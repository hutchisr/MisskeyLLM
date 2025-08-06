#!/usr/bin/env -S deno run --allow-net --allow-read --allow-write --allow-env
import "jsr:@std/dotenv/load";
import { configure, getAnsiColorFormatter, getConsoleSink, getLogger } from "jsr:@logtape/logtape";
import { assertGreater, assertGreaterOrEqual } from "jsr:@std/assert";

await configure({
  sinks: {
    console: getConsoleSink({
      formatter: getAnsiColorFormatter({
        level: "ABBR",
        levelStyle: "bold",
        timestamp: "rfc3339",
        format: (values) =>
          `${values.timestamp ? values.timestamp + " " : ""}${values.level} ${values.category} ${values.message}`,
      }),
    }),
  },
  loggers: [
    { category: ["logtape", "meta"], lowestLevel: "warning", sinks: ["console"] },
    { category: [], lowestLevel: "debug", sinks: ["console"] },
  ],
});

// Set up logger
const logger = getLogger(["misskey-llm", "grok"]);

type Username = string;

type Message = {
  role: string;
  content: string;
};

type Note = {
  id: string;
  text: string | null;
  userId: string;
  user: User;
  replyId: string | null;
  renoteId: string | null;
  reply: Note | null;
  renote: Note | null;
  visibility: "public" | "home" | "followers" | "specified";
  mentions?: string[];
  [key: string]: unknown;
};

type User = {
  id: string;
  name: string | null;
  username: string;
  host: string;
  [key: string]: unknown;
};

type LLMRequestPayload = {
  messages: Message[];
  model?: string;
  plugins?: Array<{ id: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  reasoning?: { exclude: boolean; max_tokens: number };
  [key: string]: unknown;
};

type LLMResponse = {
  choices?: Array<{ message: Message }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
};

export type ConversationMemory = Record<Username, Message[]>;

type MemoryData = {
  conversationMemory: ConversationMemory;
  autoMemory: string[];
};

type WebSocketMessage = {
  type: string;
  body?: {
    type?: string;
    body?: Note;
    channel?: string;
    id?: string;
  };
};

type IncomingMessage = {
  type: string;
  body: {
    type: string;
    body: Note;
  };
};

/**
 * Validates that a required environment variable is set
 */
function requireEnvVar(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

// Configuration - Using Deno.env instead of process.env
const BASE_URL: string = requireEnvVar("URL");
const WS_URL: string = requireEnvVar("WS_URL");
const ACCESS_TOKEN: string = requireEnvVar("TOKEN");
const CHANNEL_ID: string | undefined = Deno.env.get("CHANNEL");
const LLM_URLS: string[] = requireEnvVar("LLM_URL").split(",").map((s) => s.trim());
const LLM_KEYS: string[] = requireEnvVar("LLM_KEY").split(",").map((s) => s.trim());
const LLM_MODELS: string[] = requireEnvVar("LLM_MODEL").split(",").map((s) => s.trim());
const AUTO_LLM_MODELS: string[] = Deno.env.get("AUTO_LLM_MODEL")
  ? Deno.env.get("AUTO_LLM_MODEL")!.split(",").map((s) => s.trim())
  : LLM_MODELS;
const MAX_TOKENS: number = parseInt(Deno.env.get("MAX_TOKENS") ?? "1000");
const BOT_USER_ID: string = requireEnvVar("BOT_USER_ID");
const BOT_USERNAME: string = requireEnvVar("BOT_USERNAME");
const SYSTEM_PROMPT: string = requireEnvVar("SYSTEM_PROMPT");
const SYSTEM_PROMPT_AUTO: string = Deno.env.get("SYSTEM_PROMPT_AUTO") ?? SYSTEM_PROMPT;

// Memory management
const conversationMemory: ConversationMemory = {};
const MAX_MEMORY: number = parseInt(Deno.env.get("MAX_MEMORY") ?? "20");

const autoMemory: string[] = [];
const MAX_AUTO_MEMORY: number = parseInt(Deno.env.get("MAX_MEMORY") ?? `${MAX_MEMORY}`);

assertGreater(LLM_URLS.length, 0, "At least one LLM URL must be provided");
assertGreater(LLM_KEYS.length, 0, "At least one LLM key must be provided");
assertGreater(LLM_MODELS.length, 0, "At least one LLM model must be provided");
assertGreater(AUTO_LLM_MODELS.length, 0, "At least one auto LLM model must be provided");
assertGreater(MAX_TOKENS, 0, "Max tokens must be greater than 0");
assertGreater(BOT_USER_ID.length, 0, "BOT_USER_ID must not be empty");
assertGreater(BOT_USERNAME.length, 0, "BOT_USERNAME must not be empty");
assertGreater(SYSTEM_PROMPT.length, 0, "SYSTEM_PROMPT must not be empty");
assertGreater(SYSTEM_PROMPT_AUTO.length, 0, "SYSTEM_PROMPT_AUTO must not be empty");
assertGreaterOrEqual(MAX_MEMORY, 0, "MAX_MEMORY must not be negative");
assertGreaterOrEqual(MAX_AUTO_MEMORY, 0, "MAX_AUTO_MEMORY must not be negative");

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
    logger.error(`Error saving memory to file: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Function to load conversation memory from file using Deno APIs
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
    logger.error(`Error loading memory from file: ${error instanceof Error ? error.message : error}`);
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

  if (conversation.length > MAX_MEMORY) {
    const messagesToRemove = conversation.length - MAX_MEMORY;
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
function addToMemory(username: string | null, inReplyTo: string | null, message: string, role = "user"): void {
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

    // Add the message to memory
    conversationMemory[key].push({ role: role.trim(), content });

    // Trim conversation memory to maintain optimal performance and prevent memory bloat
    trimConversationMemory(key);

    // Save to file (with error handling in saveMemoryToFile)
    saveMemoryToFile();
  } catch (error) {
    logger.error(`Error adding message to memory: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Get conversation history for a specific user
 */
function getConversationHistory(username: string | null = null): Message[] {
  if (username && conversationMemory[username]) {
    return conversationMemory[username];
  }
  // If no username provided or no history for that user, return empty array
  return [];
}

/**
 * Function to send a note to the channel using Deno's fetch API
 */
async function sendNoteToChannel(text: string, replyId: string | null = null): Promise<void> {
  try {
    const payload: Record<string, unknown> = {
      channelId: CHANNEL_ID,
      text: text,
    };
    if (replyId) {
      payload.replyId = replyId;
    }

    const response = await fetch(`${BASE_URL}/api/notes/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // Check if the response was successful
    if (response.status === 200 || response.status === 201) {
      logger.info(`📤 Sent: ${text}`);
      addToMemory(null, replyId, text, "assistant");
    } else {
      logger.warn(`Unexpected response status: ${response.status}`);
    }
  } catch (error) {
    logger.error(`Error sending note: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Function to fetch a note by its ID using Deno's fetch API
 */
async function fetchNoteById(noteId: string): Promise<Note | null> {
  try {
    const response = await fetch(`${BASE_URL}/api/notes/show`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ noteId }),
    });

    const note = await response.json() as Note;
    return note;
  } catch (error) {
    logger.error(`Error fetching note ${noteId}: ${error instanceof Error ? error.message : error}`);
    return null;
  }
}

/**
 * Function to reply using Deno's fetch API
 */
async function sendReply(text: string, note: Note, isDirectMessage: boolean): Promise<void> {
  try {
    const payload = {
      channelId: CHANNEL_ID,
      text: text,
      replyId: note.id,
      visibility: isDirectMessage ? "specified" : "home",
    };

    const response = await fetch(`${BASE_URL}/api/notes/create`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    // Check if the response was successful
    if (response.ok) {
      const user = getUserFromNote(note);
      logger.info(`💬 Reply: ${text.replace(/\n/g, "\n   ")}`);
      addToMemory(null, user, text, "assistant");
    } else {
      throw new Error(`${response.status}: ${response.statusText}`);
    }
  } catch (error) {
    logger.error(`Error sending reply: ${error instanceof Error ? error.message : error}`);
  }
}

/**
 * Attempts to send requests to configured LLM endpoints with intelligent fallback and load balancing.
 */
async function tryLLMEndpoints(payload: LLMRequestPayload, useAutoModel = false, random = false): Promise<LLMResponse> {
  const models = useAutoModel ? AUTO_LLM_MODELS : LLM_MODELS;
  let orderedIndices: number[];

  // Create array of indices to try in random order
  if (random) {
    const indices = Array.from({ length: LLM_MODELS.length }, (_, i) => i);
    const startIndex = Math.floor(Math.random() * indices.length);
    orderedIndices = [...indices.slice(startIndex), ...indices.slice(0, startIndex)];
  } else {
    orderedIndices = Array.from({ length: LLM_MODELS.length }, (_, i) => i);
  }

  for (let j = 0; j < orderedIndices.length; j++) {
    const i = orderedIndices[j];
    const keyIndex = i % LLM_KEYS.length;
    const modelIndex = i % models.length;
    const urlIndex = i % LLM_URLS.length;
    // Rotate through keys and models with the same logic
    const endpoint = LLM_URLS[urlIndex] || LLM_URLS[0];
    const key = LLM_KEYS[keyIndex];
    const model = models[modelIndex] || payload.model;

    logger.info(`Trying endpoint ${endpoint} with model ${model} and key ${key}...`);

    const headers = {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Accept": "application/json",
    };
    const requestPayload = {
      ...payload,
      model,
      reasoning: { exclude: true, max_tokens: 0 },
    };
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
      });

      logger.info(`Response status: ${response.status}`);

      if (!response.ok) {
        continue; // Skip to next endpoint if response is not OK
      }

      const data = await response.json() as LLMResponse;

      logger.info(`\x1b[32m✅ Using endpoint: ${endpoint} with model: ${model}\x1b[0m`);
      return data;
    } catch (error) {
      logger.error(`Error with LLM endpoint ${endpoint}: ${error instanceof Error ? error.message : error}`);
      if (j === orderedIndices.length - 1) {
        throw error; // Throw error if all endpoints failed
      }
    }
  }
  logger.error("All LLM endpoints failed. Please check your configuration.");
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

    const conversationContext = getConversationHistory(username);
    let prompt = `${SYSTEM_PROMPT}`;

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

    const response = await tryLLMEndpoints({
      messages,
      max_tokens: MAX_TOKENS,
      // plugins: [{ id: "web" }],
    });

    const content = response?.choices?.[0]?.message?.content;
    if (!content || content.trim() === "") {
      throw new Error("AI response is empty or invalid");
    }
    return content.trim();
  } catch (error) {
    logger.error(`Error processing with AI: ${error instanceof Error ? error.message : error}`);
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
  ws = new WebSocket(`${WS_URL}/streaming?i=${ACCESS_TOKEN}`);

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
    const isReplyToBot = note.reply && note.reply?.userId === BOT_USER_ID;
    const isMentionToBot = note.text?.includes(`@${BOT_USERNAME}`);

    // Check if the message is NOT from the bot itself to prevent loops
    if ((isReplyToBot || isMentionToBot) && note.userId !== BOT_USER_ID) {
      const user = getUserFromNote(note);
      logger.info(`👤 ${user}: ${note.text ?? ""}`);
      addToMemory(user, null, note.text ?? "", "user");

      let quotedMessage: string | null = null;
      let replyContext: Note | null = null;

      if (isReplyToBot) {
        quotedMessage = note.reply?.text || null;
      }

      // If this note is a reply to another note, fetch the full context
      if (note.replyId) {
        logger.info(`🔍 Fetching reply context for note ${note.replyId}`);
        replyContext = await fetchNoteById(note.replyId);
        if (replyContext) {
          logger.info(`📄 Found reply context: ${replyContext.text?.replace(/\r?\n/g, " ").substring(0, 100)}...`);
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
      logger.error(`Error parsing message: ${error instanceof Error ? error.message : error}`);
    }
  });

  ws.addEventListener("error", (event) => {
    logger.error(`WebSocket error: ${JSON.stringify(event)}`);
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
function addToAutoMemory(username: string, message: string): void {
  autoMemory.push(`${username}: ${message}`);
  if (autoMemory.length > MAX_AUTO_MEMORY) {
    autoMemory.shift();
  }
  // saveMemoryToFile();
}

/**
 * Function to process auto message with AI API
 */
async function processAutoWithAI(message: string): Promise<string | undefined> {
  try {
    // Avoid escaping double quotes in the message
    message = message.replace(/"/g, "'");

    const prompt = `${SYSTEM_PROMPT_AUTO}`;

    const response = await tryLLMEndpoints({
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: message },
      ],
      max_tokens: MAX_TOKENS,
    }, true);
    return response?.choices?.[0]?.message?.content;
  } catch (error) {
    logger.error(
      `Error processing auto message with AI: ${error instanceof Error ? error.message : error}`,
    );
    return;
  }
}

/**
 * Function to send an auto message
 */
async function sendAutoMessage(): Promise<void> {
  let response = await processAutoWithAI("AUTO");

  if (!response) return;

  // clean up the response: if it starts with "AUTO" or "BOT_USERNAME:", remove it.
  response = response.replace(/^AUTO: /gi, "");
  response = response.replace(new RegExp(BOT_USERNAME + ": ", "gi"), "");

  await sendNoteToChannel(response);
  addToAutoMemory(BOT_USERNAME, response);
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
  // Load memory from file when starting
  await loadMemoryFromFile();

  // Connect to WebSocket
  connectWebSocket();

  // Start the auto message scheduling
  scheduleNextAutoMessage();

  logger.info(`🤖 ${BOT_USERNAME} is running...`);
}

// Run the main function
if (import.meta.main) {
  main().catch(logger.error);
}
