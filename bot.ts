#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
// deno-lint-ignore-file no-unused-vars
import { parse as parseYaml } from "jsr:@std/yaml";
import { parseArgs } from "jsr:@std/cli/parse-args";
import * as path from "jsr:@std/path";
import {
  Config,
  ConversationMemory,
  IncomingMessage,
  LLMRequestPayload,
  LLMResponse,
  MemoryData,
  Message,
  Note,
  User,
  Username,
  WebSocketMessage,
} from "./types.ts";
import { configure, getAnsiColorFormatter, getConsoleSink, getLogger } from "jsr:@logtape/logtape";
import { DEFAULT_REDACT_FIELDS, JWT_PATTERN, redactByPattern, type RedactionPattern } from "jsr:@logtape/redaction";
import { createKv, Kv } from "jsr:@joyful/kv";
import { createRedisDriver } from "jsr:@joyful/kv-mini-redis";
import { assertGreater, assertGreaterOrEqual, assertMatch } from "jsr:@std/assert";

const API_TOKEN_PATTERN: RedactionPattern = {
  pattern: /sk-[\p{L},\p{N}\-_\.]+\b/gu,
  replacement: "[REDACTED_API_TOKEN]",
};

await configure({
  sinks: {
    console: getConsoleSink({
      formatter: redactByPattern(
        getAnsiColorFormatter({
          level: "ABBR",
          levelStyle: "bold",
          timestamp: "rfc3339",
          format: (values) =>
            `${values.timestamp ? values.timestamp + " " : ""}${values.level} ${values.category} ${values.message}`,
        }),
        [
          JWT_PATTERN,
          API_TOKEN_PATTERN,
        ],
      ),
    }),
  },
  loggers: [
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
    { category: [], lowestLevel: "debug", sinks: ["console"] },
  ],
});

// Set up logger
const logger = getLogger(["misskey-llm", "bot"]);

const args = parseArgs(Deno.args, {
  string: ["config"],
  alias: { c: "config" },
});

// Load configuration from YAML file
const input = parseYaml(await Deno.readTextFile(args.config ?? path.join(Deno.cwd(), "config.yaml")));
const config = Config.parse(input);

// Memory management
const conversationMemory: ConversationMemory = {};
const autoMemory: string[] = [];

let kv: Kv<Awaited<ReturnType<typeof createRedisDriver>>> | undefined;

/**
 * Initialize memory storage (Redis or file-based)
 */
async function initializeMemory(): Promise<void> {
  if (config.redis_uri) {
    try {
      const redisDriver = await createRedisDriver(config.redis_uri);
      kv = createKv({ driver: redisDriver, prefix: config.redis_key_prefix });
      logger.info("✅ Redis connection initialized successfully");
    } catch (error) {
      logger.error(`❌ ❌ Failed to initialize Redis: ${error instanceof Error ? error.message : error}`);
      kv = undefined;
    }
  } else {
    logger.info("📁 Using file-based memory storage (redis_uri not set)");
    await loadMemoryFromFile();
  }
}

/**
 * Save user conversation to Redis
 */
async function saveUserConversationToRedis(username: string, messages: Message[]): Promise<void> {
  if (!config.redis_uri || !kv) return;

  try {
    const key = `user:${username}`;
    await kv.set(key, JSON.stringify(messages), config.redis_key_ttl);
  } catch (error) {
    logger.error(`❌ Error saving user conversation to Redis: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Load user conversation from Redis
 */
async function loadUserConversationFromRedis(username: string): Promise<Message[]> {
  if (!config.redis_uri || !kv) return [];

  try {
    const key = `user:${username}`;
    const result = await kv.get(key);
    if (result.ok && result.value) {
      return JSON.parse(result.value) as Message[];
    }
    return [];
  } catch (error) {
    logger.error(`❌ Error loading user conversation from Redis: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/**
 * Save auto memory to Redis with TTL
 */
async function saveAutoMemoryToRedis(autoMemory: string[]): Promise<void> {
  if (!config.redis_uri || !kv) return;

  try {
    const key = `auto`;
    await kv.set(key, JSON.stringify(autoMemory), config.redis_key_ttl);
  } catch (error) {
    logger.error(`❌ Error saving auto memory to Redis: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Load auto memory from Redis
 */
async function loadAutoMemoryFromRedis(): Promise<string[]> {
  if (!config.redis_uri || !kv) return [];

  try {
    const key = `auto`;
    const result = await kv.get(key);
    if (result.ok && result.value) {
      return JSON.parse(result.value) as string[];
    }
    return [];
  } catch (error) {
    logger.error(`❌ Error loading auto memory from Redis: ${error instanceof Error ? error.message : error}`);
    return [];
  }
}

/**
 * Trim user conversation in Redis to maintain MAX_MEMORY limit
 */
async function trimUserConversationInRedis(username: string): Promise<void> {
  if (!config.redis_uri || !kv) return;

  try {
    const messages = await loadUserConversationFromRedis(username);
    if (messages.length > config.max_memory) {
      const messagesToRemove = messages.length - config.max_memory;
      const trimmedMessages = messages.slice(messagesToRemove);
      await saveUserConversationToRedis(username, trimmedMessages);
    }
  } catch (error) {
    logger.error(`❌ Error trimming user conversation in Redis: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Function to save conversation memory to file using Deno APIs
 */
async function saveMemoryToFile(): Promise<void> {
  const memoryData: MemoryData = {
    conversationMemory,
    autoMemory,
  };

  try {
    await Deno.writeTextFile("memory.json", JSON.stringify(memoryData, null, 2));
    logger.info("💾 Memory saved to memory.json");
  } catch (error) {
    logger.error(`❌ Error saving memory to file: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Function to load conversation memory from file
 */
async function loadMemoryFromFile(): Promise<void> {
  try {
    const fileInfo = await Deno.stat("memory.json").catch(() => null);
    if (fileInfo) {
      const data = await Deno.readTextFile("memory.json");
      const memoryData = JSON.parse(data) as MemoryData;

      // Restore conversation memory
      if (Array.isArray(memoryData.conversationMemory)) {
        // Clear existing memory
        Object.keys(conversationMemory).forEach((key) => delete conversationMemory[key]);

        // If the saved data is a flat array (legacy format), convert it to the new structure
        conversationMemory["general"] = memoryData.conversationMemory as unknown as Message[];
        logger.info(
          `💾 Loaded ${(memoryData.conversationMemory as unknown as Message[]).length} conversation memory items`,
        );
      } else if (typeof memoryData.conversationMemory === "object" && memoryData.conversationMemory !== null) {
        // Clear existing memory
        Object.keys(conversationMemory).forEach((key) => delete conversationMemory[key]);

        // If the saved data is already in the correct object format, restore it directly
        Object.assign(conversationMemory, memoryData.conversationMemory);
        const totalItems = Object.values(conversationMemory).reduce((sum, arr) => sum + arr.length, 0);
        logger.info(
          `💾 Loaded ${totalItems} conversation memory items across ${
            Object.keys(conversationMemory).length
          } conversations`,
        );
      }

      // Restore auto memory
      if (Array.isArray(memoryData.autoMemory)) {
        autoMemory.length = 0; // Clear existing memory
        memoryData.autoMemory.forEach((item) => autoMemory.push(item));
        logger.info(`💾 Loaded ${autoMemory.length} auto memory items`);
      }
    } else {
      logger.info("💾 No memory file found, starting with empty memory");
    }
  } catch (error) {
    logger.error(`❌ Error loading memory from file: ${error instanceof Error ? error.message : error}`);
  }
}
/**
 * Trims conversation memory for a specific key to maintain optimal size
 * Removes oldest messages when memory exceeds MAX_MEMORY limit
 * @param key - The conversation key to trim
 */
function trimConversationMemory(key: string): void {
  if (!conversationMemory[key]) {
    return;
  }

  const conversation = conversationMemory[key];

  if (conversation.length > config.max_memory) {
    const messagesToRemove = conversation.length - config.max_memory;
    conversation.splice(0, messagesToRemove);
  }
}

/**
 * Function to add a message to the conversation memory with validation and error handling
 * @param username - The username of the message sender
 * @param inReplyTo - The ID of the message being replied to
 * @param message - The message content
 * @param role - The role of the message sender (default: "user")
 */
async function addToMemory(
  username?: string,
  inReplyTo?: string,
  message?: string,
  role = "user",
): Promise<void> {
  // Input validation
  if (!message || typeof message !== "string" || message.trim().length === 0) {
    logger.warn("Attempted to add empty or invalid message to memory");
    return;
  }

  if (typeof role !== "string" || role.trim().length === 0) {
    logger.warn(`Invalid role provided: ${role}. Using default 'user'`);
    role = "user";
  }

  try {
    let content = message.trim();
    if (username && username.trim().length > 0) {
      content = `${username.trim()}: ${content}`;
    }

    const key = username?.trim() || inReplyTo?.trim() || "unknown";

    // Initialize conversation array if it doesn't exist
    if (!conversationMemory[key]) {
      conversationMemory[key] = [];
    }

    // Add the message to in-memory storage
    conversationMemory[key].push({ role: role.trim(), content });

    // Trim in-memory conversation
    trimConversationMemory(key);

    // Save to Redis if available
    if (config.redis_uri && kv) {
      await saveUserConversationToRedis(key, conversationMemory[key]);
      await trimUserConversationInRedis(key);
    } else {
      // Only save to file if not using Redis
      await saveMemoryToFile();
    }
  } catch (error) {
    logger.error(`❌ Error adding message to memory: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Get conversation history for a specific user
 */
async function getConversationHistory(username: string | null = null): Promise<Message[]> {
  if (!username) return [];

  try {
    // Try Redis first
    if (config.redis_uri && kv) {
      const redisMessages = await loadUserConversationFromRedis(username);
      if (redisMessages.length > 0) {
        // Update in-memory cache
        conversationMemory[username] = redisMessages;
        return redisMessages;
      }
    }

    // Fallback to in-memory
    if (conversationMemory[username]) {
      return conversationMemory[username];
    }

    return [];
  } catch (error) {
    logger.error(`❌ Error getting conversation history: ${error instanceof Error ? error.message : error}`);
    // Fallback to in-memory on error
    return conversationMemory[username] || [];
  }
}

/**
 * Function to send a note to the channel using Deno's fetch API
 */
async function sendNote(
  text: string,
  replyId?: string,
  isAutoMessage: boolean = false,
): Promise<void> {
  try {
    const payload: Record<string, string> = {
      text,
    };
    if (replyId) {
      payload.replyId = replyId;
    }
    if (config.channel) {
      payload.channelId = config.channel;
    }

    const response = await fetch(`${config.url}/api/notes/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // Check if the response was successful
    if (response.status === 200 || response.status === 201) {
      logger.info(`📤 Sent: ${text.replace(/\r?\n/g, "⏎")}`);
    } else {
      logger.warn(`Unexpected response status: ${response.status}`);
    }
  } catch (error) {
    logger.error(`❌ Error sending note: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Function to fetch a note by its ID using Deno's fetch API
 */
async function fetchNoteById(noteId: string): Promise<Note | undefined> {
  try {
    const response = await fetch(`${config.url}/api/notes/show`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ noteId }),
    });

    const note = await response.json() as Note;
    return note;
  } catch (error) {
    logger.error(`❌ Error fetching note ${noteId}: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Function to reply using Deno's fetch API
 */
async function sendReply(text: string, note: Note, isDirectMessage: boolean = false): Promise<void> {
  try {
    const payload: Record<string, string> = {
      text: text,
      replyId: note.id,
      visibility: isDirectMessage ? "specified" : "home",
    };
    if (config.channel) {
      payload.channelId = config.channel;
    }

    const response = await fetch(`${config.url}/api/notes/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // Check if the response was successful
    if (response.ok) {
      const user = getUserFromNote(note);
      logger.info(`💬 Reply: ${text.replace(/\n/g, "⏎")}`);
      await addToMemory(undefined, user, text, "assistant");
    } else {
      throw new Error(`${response.status}: ${response.statusText}`);
    }
  } catch (error) {
    logger.error(`❌ Error sending reply: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Attempts to send requests to configured LLM endpoints with retry logic and fallback.
 * Each endpoint is retried up to 3 times before moving to the next endpoint.
 */
async function tryLLMEndpoints(payload: LLMRequestPayload, useAutoModel = false, random = false): Promise<string> {
  // Create array of endpoints to try in random order if requested
  let endpoints = config.llm_endpoints;
  if (random) {
    // Shuffle the endpoints array
    endpoints = shuffleArray(config.llm_endpoints);
  }

  for (const endpointConfig of endpoints) {
    const endpoint = endpointConfig.url;
    const key = endpointConfig.key;
    const model = endpointConfig.model;

    logger.info(`🛜 Trying endpoint ${endpoint} with model ${model}...`);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "Accept": "application/json",
    };

    // Only include Authorization header if key is truthy
    if (key) {
      headers["Authorization"] = `Bearer ${key}`;
    }
    const requestPayload = {
      ...payload,
      model,
      // reasoning: { exclude: true, max_tokens: 0 },
    };

    // console.info(`payload: ${JSON.stringify(requestPayload)}\n\nheaders: ${JSON.stringify(headers)}`);

    // Retry logic for current endpoint
    let lastError: Error | null = null;
    for (let retryCount = 0; retryCount < config.max_retries; retryCount++) {
      try {
        if (retryCount > 0) {
          logger.info(`🔄 Retry ${retryCount}/${config.max_retries - 1} for endpoint ${endpoint}`);
        }

        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(requestPayload),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json() as LLMResponse;

        logger.info(`\x1b[32m✅ Using endpoint: ${endpoint} with model: ${model}\x1b[0m`);

        // return data?.choices?.[0]?.message?.content;
        const content = data?.choices?.[0]?.message?.content;
        if (!content || content.trim() === "") {
          throw new Error("AI response is empty or invalid");
        }
        return content.trim();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        logger.error(
          `❌ Error with LLM endpoint ${endpoint} (attempt ${
            retryCount + 1
          }/${config.max_retries}): ${lastError.message}`,
        );

        // If this is not the last retry, wait a bit before retrying
        if (retryCount < config.max_retries - 1) {
          const delay = Math.min(1000 * Math.pow(2, retryCount), 5000); // Exponential backoff, max 5 seconds
          logger.info(`⏳ Waiting ${delay}ms before retry...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    // If we've exhausted all retries for this endpoint and it's not the last endpoint, continue to next
    logger.warn(`❌ Endpoint ${endpoint} failed after ${config.max_retries} attempts, trying next endpoint...`);
  }
  logger.error("❌ All LLM endpoints failed. Please check your configuration.");
  throw new Error("All LLM endpoints failed. Please check your configuration.");
}

/**
 * Function to process message with AI API
 */
async function processWithAI(
  username: string,
  message: string | null,
  quotedMessage: string | null = null,
  replyContext: Note | null = null,
): Promise<string | void> {
  if (!message) return;
  try {
    // Avoid escaping double quotes in the message
    message = message.replace(/"/g, "'");

    const conversationContext = await getConversationHistory(username);
    let prompt = `${config.system_prompt}`;

    if (quotedMessage) {
      prompt += `\n<quote>${quotedMessage}</quote>`;
    }

    // If there's reply context, include it in the prompt
    if (replyContext) {
      const replyUser = getUserFromNote(replyContext);
      prompt += `\n"<quote>${replyUser}: ${replyContext.text}</quote>"`;
    }

    const messages: Message[] = [
      { role: "system", content: prompt },
      ...conversationContext,
      { role: "user", content: `${username}: ${message}` },
    ];

    return await tryLLMEndpoints({
      messages,
      max_tokens: config.max_tokens,
      // plugins: [{ id: "web" }],
    });
  } catch (error) {
    logger.error(`❌ ❌ Error processing with AI: ${error instanceof Error ? error.message : error}`);
    return "I'm sorry but my brain appears to be broken. Please try again later. 💀";
  }
}

/**
 * Get user identifier from note
 */
function getUserFromNote(note: Note): string {
  let user = "";
  if (note?.user.host) {
    user = `${note.user.username}@${note.user.host}`;
  } else {
    user = note?.user.username;
  }
  return user;
}

// WebSocket connection using Deno's native WebSocket
let ws: WebSocket;
let pingInterval: number;

function connectWebSocket(): void {
  ws = new WebSocket(`${config.ws_url}/streaming?i=${config.token}`);

  ws.addEventListener("open", () => {
    logger.info("🌎 Connected to Misskey streaming API");
    ws.send(JSON.stringify({
      type: "connect",
      body: {
        channel: "main",
        id: "111111",
      },
    }));
    pingInterval = startPingInterval(ws);
  });

  // Object to store incoming messages
  const incomingMessages = new Map<string, IncomingMessage[]>();

  // Cooldown duration in milliseconds
  const COOLDOWN_DURATION = 2000; // 2 seconds

  /**
   * Function to process messages after cooldown
   */
  function processMessageAfterCooldown(messageId: string): void {
    setTimeout(() => {
      const messages = incomingMessages.get(messageId) || [];
      if (messages.length > 0) {
        // Sort messages to prioritize replies over mentions
        messages.sort((a, b) => {
          if (a.type === "reply") return -1;
          if (b.type === "reply") return 1;
          return 0;
        });

        const message = messages[0]; // Take the first message (prioritized)
        processMessage(message);
      }
      incomingMessages.delete(messageId);
    }, COOLDOWN_DURATION);
  }

  /**
   * Function to process a single message
   */
  async function processMessage(message: IncomingMessage): Promise<void> {
    const note = message.body.body;

    // Censorship
    note.text = note.text?.replace(/nig(ger)?|jeet|kike/gi, "elon")
      .replace(/rape|fuck/gi, "gently caress")
      .replace(/nuke|bomb/gi, "hug") ?? null;

    // Check if the note is a reply to the bot or mentions the bot
    const isReplyToBot = note.reply && note.reply?.userId === config.bot_user_id;
    const isMentionToBot = note.text?.includes(`@${config.bot_username}`);

    // Check if the message is NOT from the bot itself to prevent loops
    if ((isReplyToBot || isMentionToBot) && note.userId !== config.bot_user_id) {
      const user = getUserFromNote(note);
      logger.info(`👤 ${user}: ${note.text}`);
      await addToMemory(user, undefined, note.text ?? undefined, "user");

      let quotedMessage: string | undefined;
      let replyContext: Note | undefined;

      if (isReplyToBot) {
        quotedMessage = note.reply?.text || undefined;
      }

      // If this note is a reply to another note, fetch the full context
      if (note.replyId) {
        logger.info(`🔍 Fetching reply context for note ${note.replyId}`);
        replyContext = await fetchNoteById(note.replyId);
        if (replyContext) {
          logger.info(`📄 Found reply context: ${replyContext.text?.replace(/\r?\n/g, "⏎").substring(0, 160)}...`);
        }
      }

      // Process the note with AI
      const response = await processWithAI(user, note.text, quotedMessage, replyContext);

      // Check if the original message is a direct message
      const isDirectMessage = note.visibility === "specified";

      // Send the response as a reply
      if (response) {
        await sendReply(response, note, isDirectMessage);
      }
    }
  }

  ws.addEventListener("message", (event) => {
    const stringData = event.data;

    try {
      const message = JSON.parse(stringData) as WebSocketMessage;
      if (message.type === "pong") {
        // received pong
      } else if (
        message.type === "channel" && message.body && (message.body.type === "mention" || message.body.type === "reply")
      ) {
        const note = message.body.body!;
        const messageId = note.id;

        // Store the message
        if (!incomingMessages.has(messageId)) {
          incomingMessages.set(messageId, []);
          processMessageAfterCooldown(messageId);
        }
        incomingMessages.get(messageId)!.push({
          type: message.body.type!,
          body: message.body as { type: string; body: Note },
        });
      }
    } catch (error) {
      logger.error(`❌ Error parsing message: ${error instanceof Error ? error.message : error}`);
    }
  });

  ws.addEventListener("error", (event) => {
    logger.error(`❌ WebSocket error: ${JSON.stringify(event)}`);
  });

  ws.addEventListener("close", () => {
    logger.info("🔌 Disconnected from Misskey streaming API");
    clearInterval(pingInterval);
    setTimeout(() => {
      connectWebSocket();
    }, 5000); // Try to reconnect after 5 seconds
  });
}

/**
 * Function to add a message to the auto conversation memory
 */
async function addToAutoMemory(username: string, message: string): Promise<void> {
  try {
    const autoMessage = `${username}: ${message}`;

    // Add to in-memory
    autoMemory.push(autoMessage);
    if (autoMemory.length > config.max_memory) {
      autoMemory.shift();
    }

    // Save to Redis if available
    if (config.redis_uri && kv) {
      await saveAutoMemoryToRedis(autoMemory);
    } else {
      // Only save to file if not using Redis
      await saveMemoryToFile();
    }
  } catch (error) {
    logger.error(`❌ Error adding to auto memory: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Function to process auto message with AI API
 */
async function processAutoWithAI(message: string = "AUTO"): Promise<string | undefined> {
  try {
    // Avoid escaping double quotes in the message
    message = message.replace(/"/g, "'");

    const prompt = `${config.system_prompt_auto}`;

    return await tryLLMEndpoints({
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: message },
      ],
      max_tokens: config.max_tokens,
    }, true);
  } catch (error) {
    logger.error(
      `❌ Error processing auto message with AI: ${error instanceof Error ? error.message : error}`,
    );
  }
}

/**
 * Function to send an auto message
 */
async function sendAutoMessage(): Promise<void> {
  // Load auto memory from Redis if available
  if (config.redis_uri && kv) {
    const redisAutoMemory = await loadAutoMemoryFromRedis();
    if (redisAutoMemory.length > 0) {
      autoMemory.length = 0; // Clear existing memory
      redisAutoMemory.forEach((item) => autoMemory.push(item));
    }
  }

  let response = await processAutoWithAI("AUTO");

  if (!response) return;

  // clean up the response: if it starts with "AUTO" or "BOT_USERNAME:", remove it.
  response = response.replace(/^AUTO: /gi, "");
  response = response.replace(new RegExp(config.bot_username + ": ", "gi"), "");

  await sendNote(response);
  await addToAutoMemory(config.bot_username, response);
}

/**
 * Function to schedule the next auto message
 */
function scheduleNextAutoMessage(): void {
  const minDelay = 5 * 60 * 1000; // 5 minutes
  const maxDelay = 30 * 60 * 1000; // 30 minutes
  const delay = Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

  setTimeout(() => {
    sendAutoMessage();
    scheduleNextAutoMessage();
  }, delay);

  logger.info(`🕥 Next auto message in ${(delay / 60000).toFixed(1)} minutes`);
}

/**
 * Start ping interval for WebSocket
 */
function startPingInterval(ws: WebSocket): number {
  const pingInterval = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "ping" }));
    } else {
      clearInterval(pingInterval);
    }
  }, 60000); // Send a ping every minute

  return pingInterval;
}

function shuffleArray<T>(array: Array<T>): Array<T> {
  const shuffled = [...array]; // Create a copy to avoid mutating original
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]; // Swap elements
  }
  return shuffled;
}

// Set up periodic memory saving (every 5 minutes)

// Handle graceful shutdown to save memory - Deno style
globalThis.addEventListener("unload", () => {
  logger.info("💾 Saving memory before shutdown...");
  // Note: In Deno, we can't use async operations in unload event
  // Memory will be saved periodically instead
});

// Handle SIGINT for graceful shutdown
Deno.addSignalListener("SIGINT", async () => {
  logger.info("💾 Saving memory before shutdown...");
  await saveMemoryToFile();
  Deno.exit(0);
});

// Main execution
async function main(): Promise<void> {
  // Initialize memory storage
  await initializeMemory();

  // Connect to WebSocket
  connectWebSocket();

  // Start the auto message scheduling
  scheduleNextAutoMessage();

  logger.info(`🤖 ${config.bot_username} is running...`);
}

// Run the main function
if (import.meta.main) {
  main().catch(logger.error);
}
