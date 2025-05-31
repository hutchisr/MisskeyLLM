//@ts-check
import "dotenv/config";
import axios from "axios";
import WebSocket from "ws";
import fs from "fs";

/**
 * @typedef {Object} Note - Represents a note in Misskey
 * @property {string} id - The unique identifier of the note
 * @property {string} text - The content of the note
 * @property {string} userId - The ID of the user who created the note
 * @property {User} user - The user object containing user details
 * @property {string|null} replyId - The ID of the note this note is replying to (if applicable)
 * @property {string|null} renoteId - The ID of the note this note is renoting (if applicable)
 * @property {Note|null} reply - The reply object if the note is a reply, null otherwise
 * @property {Note|null} renote - The renote object if the note is a renote, null otherwise
 * @property {*} [key] - Additional properties that may be present in the note object
 */

/**
 * @typedef {Object} User - Represents a user in Misskey
 * @property {string} id - The unique identifier of the user
 * @property {string|null} name - The username of the user
 * @property {string} username - The username of the user
 * @property {string} host - The host of the user
 * @property {*} [key] - Additional properties that may be present in the user object
 */

/**
 * @typedef {Object} LLMRequestPayload - The request payload for LLM API calls
 * @property {Array<{role: string, content: string}>} messages - Array of conversation messages
 * @property {string} [model] - The model to use (can be overridden by function logic)
 * @property {number} [temperature] - Controls randomness in responses (0.0 to 2.0)
 * @property {number} [max_tokens] - Maximum number of tokens in the response
 * @property {boolean} [stream] - Whether to stream the response
 * @property {*} [key] - Additional properties that may be present in the payload
 */

/**
 * @typedef {Object} LLMResponse - The response object from LLM API endpoints (Axios response structure)
 * @property {Object} data - The response data from the LLM API
 * @property {Array<Object>} [data.choices] - Array of response choices from the LLM
 * @property {Object} [data.choices[].message] - Message object containing the response
 * @property {string} [data.choices[].message.content] - The generated text content
 * @property {string} [data.choices[].message.role] - The role of the response (usually "assistant")
 * @property {Object} [data.usage] - Token usage information
 * @property {number} [data.usage.prompt_tokens] - Number of tokens in the prompt
 * @property {number} [data.usage.completion_tokens] - Number of tokens in the completion
 * @property {number} [data.usage.total_tokens] - Total number of tokens used
 * @property {number} status - HTTP status code of the response
 * @property {string} statusText - HTTP status text
 * @property {Object} headers - HTTP response headers
 * @property {Object} config - Axios request configuration used
 * @property {*} [key] - Additional properties that may be present in the response
 */

/**
 * Get terminal width with fallback
 * @returns {number} Terminal width in columns
 */
function getTerminalWidth() {
  return process.stdout.columns || 80; // Default to 80 if not available
}

/**
 * Word wrap text to fit terminal width
 * @param {string} text - Text to wrap
 * @param {string} prefix - Prefix for each line (e.g., "💬 Reply: ")
 * @param {number?} maxWidth - Maximum width (defaults to terminal width)
 * @returns {string} Wrapped text
 */
function wrapText(text, prefix = '', maxWidth = null) {
  if (!maxWidth) maxWidth = getTerminalWidth();
  if (!text) return text;

  // Calculate available width after prefix
  const availableWidth = maxWidth - prefix.length;

  // If text is shorter than available width, return as-is
  if (text.length <= availableWidth) {
    return prefix + text;
  }

  const words = text.split(' ');
  const lines = [];
  let currentLine = '';

  for (const word of words) {
    // If adding this word would exceed the line length
    if (currentLine.length + word.length + 1 > availableWidth) {
      if (currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        // Word is longer than available width, break it
        lines.push(word.substring(0, availableWidth));
        currentLine = word.substring(availableWidth);
      }
    } else {
      currentLine = currentLine ? currentLine + ' ' + word : word;
    }
  }

  if (currentLine) {
    lines.push(currentLine);
  }

  // Join lines with prefix and continuation indent
  const continuationIndent = ' '.repeat(prefix.length);
  return lines.map((line, index) =>
    index === 0 ? prefix + line : continuationIndent + line
  ).join('\n');
}

// Configuration validation
/**
 * Validates that a required environment variable is set
 * @param {string | undefined} value
 * @param {string} name
 * @returns {string}
 */
function requireEnvVar(value, name) {
  if (!value) {
    throw new Error(`Required environment variable ${name} is not set`);
  }
  return value;
}

// Configuration
/** @type {string} */
const BASE_URL = requireEnvVar(process.env.URL, 'URL');
/** @type {string} */
const WS_URL = requireEnvVar(process.env.WS_URL, 'WS_URL');
/** @type {string} */
const ACCESS_TOKEN = requireEnvVar(process.env.TOKEN, 'TOKEN');
/** @type {string | undefined} */
const CHANNEL_ID = process.env.CHANNEL;
/** @type {string[]} */
const LLM_URLS = process.env.LLM_URL ? process.env.LLM_URL.split(',').map(url => url.trim()) : [];
/** @type {string[]} */
const LLM_KEYS = process.env.LLM_KEY ? process.env.LLM_KEY.split(',').map(key => key.trim()) : [];
/** @type {string[]} */
const LLM_MODELS = process.env.LLM_MODEL ? process.env.LLM_MODEL.split(',').map(m => m.trim()) : [];
/** @type {string[]} */
const AUTO_LLM_MODELS = process.env.AUTO_LLM_MODEL ? process.env.AUTO_LLM_MODEL.split(',').map(m => m.trim()) : LLM_MODELS;
/** @type {number} */
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS ?? '1000');
/** @type {string} */
const BOT_USER_ID = requireEnvVar(process.env.BOT_USER_ID, 'BOT_USER_ID');
/** @type {string} */
const BOT_USERNAME = requireEnvVar(process.env.BOT_USERNAME, 'BOT_USERNAME');
/** @type {string} */
const SYSTEM_PROMPT = requireEnvVar(process.env.SYSTEM_PROMPT, 'SYSTEM_PROMPT');
/** @type {string} */
const SYSTEM_PROMPT_AUTO = process.env.SYSTEM_PROMPT_AUTO ?? SYSTEM_PROMPT;

// Validate LLM configuration
if (LLM_URLS.length === 0) {
  throw new Error('Required environment variable LLM_URL is not set');
}
if (LLM_KEYS.length === 0) {
  throw new Error('Required environment variable LLM_KEY is not set');
}
if (LLM_MODELS.length === 0) {
  throw new Error('Required environment variable LLM_MODEL is not set');
}

/**
 * @type {Record<string, Array<{ role: string, content: string }>>}
 */
const conversationMemory = {};
/** @type {number} */
const MAX_MEMORY = parseInt(process.env.MAX_MEMORY ?? '20');

/** @type {string[]} */
const autoMemory = [];
/** @type {number} */
const MAX_AUTO_MEMORY = parseInt(process.env.MAX_MEMORY ?? `${MAX_MEMORY}`);

/**
 * Function to save conversation memory to file
 * @returns {void}
 */
function saveMemoryToFile() {
  const memoryData = {
    conversationMemory,
    autoMemory
  };

  try {
    fs.writeFileSync('memory.json', JSON.stringify(memoryData, null, 2));
    console.log(wrapText('Memory saved to memory.json', '💾 '));
  } catch (error) {
    console.error(wrapText(`Error saving memory to file: ${error.message || error}`, '❌ '));
  }
}

/**
 * Function to load conversation memory from file
 * @returns {void}
 */
function loadMemoryFromFile() {
  try {
    if (fs.existsSync('memory.json')) {
      const data = fs.readFileSync('memory.json', 'utf8');
      const memoryData = JSON.parse(data);

      // Restore conversation memory
      if (Array.isArray(memoryData.conversationMemory)) {
        // Clear existing memory
        Object.keys(conversationMemory).forEach(key => delete conversationMemory[key]);

        // If the saved data is a flat array (legacy format), convert it to the new structure
        // For now, we'll put all messages under a 'general' key to maintain compatibility
        conversationMemory['general'] = memoryData.conversationMemory;
        console.log(wrapText(`Loaded ${memoryData.conversationMemory.length} conversation memory items`, '💾 '));
      } else if (typeof memoryData.conversationMemory === 'object' && memoryData.conversationMemory !== null) {
        // Clear existing memory
        Object.keys(conversationMemory).forEach(key => delete conversationMemory[key]);

        // If the saved data is already in the correct object format, restore it directly
        Object.assign(conversationMemory, memoryData.conversationMemory);
        const totalItems = Object.values(conversationMemory).reduce((sum, arr) => sum + arr.length, 0);
        console.log(wrapText(`Loaded ${totalItems} conversation memory items across ${Object.keys(conversationMemory).length} conversations`, '💾 '));
      }

      // Restore auto memory
      if (Array.isArray(memoryData.autoMemory)) {
        autoMemory.length = 0; // Clear existing memory
        memoryData.autoMemory.forEach(item => autoMemory.push(item));
        console.log(wrapText(`Loaded ${autoMemory.length} auto memory items`, '💾 '));
      }
    } else {
      console.log(wrapText('No memory file found, starting with empty memory', '💾 '));
    }
  } catch (error) {
    console.error(wrapText(`Error loading memory from file: ${error.message || error}`, '❌ '));
  }
}

/**
 * Function to add a message to the conversation memory
 *
 * @param {string | null} username
 * @param {string | null} inReplyTo
 * @param {string} message
 * @param {string} [role="user"]
 *
 * @returns {void}
 */
function addToMemory(username, inReplyTo, message, role = "user") {
  let content = message;
  if (username) {
    content = `${username}: ${message}`;
  }
  const key = username || inReplyTo || 'unknown';
  if (!conversationMemory[key]) {
    conversationMemory[key] = [];
  }
  conversationMemory[key].push({ role, content });

  // Check if this conversation thread exceeds MAX_MEMORY
  if (conversationMemory[key].length > MAX_MEMORY) {
    conversationMemory[key].shift();
  }
  saveMemoryToFile();
}

function isValidUserMessages(obj) {
  return obj !== null &&
    typeof obj === 'object' &&
    !Array.isArray(obj) &&
    Object.keys(obj).length > 0 &&
    Object.values(obj).every(value => Array.isArray(value));
}

/**
 * Function to get the conversation history as a string
 *
 */
/**
 * Get conversation history for a specific user
 * @param {string | null} username - The username to get history for
 * @returns {Array<{role: string, content: string}>} Array of conversation messages
 */
function getConversationHistory(username = null) {
  if (username && conversationMemory[username]) {
    return conversationMemory[username];
  }
  // If no username provided or no history for that user, return empty array
  return [];
}

/**
 * Function to send a note to the channel
 *
 * @param {string} text
 * @param {string | null} replyId
 * @returns {Promise<void>}
 */
async function sendNoteToChannel(text, replyId = null) {
  try {
    const payload = {
      channelId: CHANNEL_ID,
      text: text,
    };
    if (replyId) {
      payload.replyId = replyId;
    }
    const response = await axios.post(`${BASE_URL}/api/notes/create`, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });
    console.log(wrapText(text, "📤 Sent: "));
    addToMemory(null, replyId, text, "assistant");
  } catch (error) {
    console.error(wrapText(
      `Error sending note: ${error.response ? JSON.stringify(error.response.data) : error.message}`,
      "❌ "
    ));
  }
}

/**
 * Function to reply
 * @param {string} text
 * @param {Note} note
 * @param {boolean} isDirectMessage
 * @returns {Promise<void>}
 */
async function sendReply(text, note, isDirectMessage) {
  try {
    const payload = {
      channelId: CHANNEL_ID,
      text: text,
      replyId: note.id,
      visibility: isDirectMessage ? "specified" : "home",
    };
    const response = await axios.post(`${BASE_URL}/api/notes/create`, payload, {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        "Content-Type": "application/json",
      },
    });

    // Check if the response was successful
    if (response.status === 200 || response.status === 201) {
      const user = getUserFromNote(note);
      console.log(wrapText(text.replace(/\n/g, "\n   "), "💬 Reply: "));
      addToMemory(null, user, text, "assistant");
    } else {
      console.warn(`Unexpected response status: ${response.status}`);
    }
  } catch (error) {
    console.error(wrapText(
      `Error sending reply: ${error.response ? JSON.stringify(error.response.data) : error.message}`,
      "❌ "
    ));
  }
}

/**
 * Attempts to send requests to configured LLM endpoints with intelligent fallback and load balancing.
 *
 * This function implements a robust retry mechanism that:
 * - Randomizes endpoint selection to distribute load across available services
 * - Rotates through different API keys and models for each attempt
 * - Provides comprehensive error logging for debugging
 * - Throws detailed errors when all endpoints fail
 *
 * The function will try each configured endpoint once in random order before giving up.
 * Each attempt uses a different combination of API key and model based on the endpoint index.
 *
 * @param {LLMRequestPayload} payload - The request payload containing messages and LLM configuration
 * @param {boolean} [useAutoModel=false] - Whether to use AUTO_LLM_MODEL array instead of LLM_MODEL array
 * @returns {Promise<LLMResponse>} The successful HTTP response from an LLM endpoint (see LLMResponse typedef for structure)
 * @throws {Error} When all configured endpoints fail or when invalid parameters are provided
 *
 * @example
 * // Basic usage with conversation messages
 * const response = await tryLLMEndpoints({
 *   messages: [
 *     { role: "system", content: "You are a helpful assistant" },
 *     { role: "user", content: "Hello!" }
 *   ],
 *   temperature: 0.7,
 *   max_tokens: 150
 * });
 *
 * @example
 * // Using auto model selection
 * const response = await tryLLMEndpoints(payload, true);
 */
async function tryLLMEndpoints(payload, useAutoModel = false) {
  const models = useAutoModel ? AUTO_LLM_MODELS : LLM_MODELS;

  // Create array of indices to try in random order
  const indices = Array.from({ length: LLM_URLS.length }, (_, i) => i);
  const startIndex = Math.floor(Math.random() * indices.length);
  const orderedIndices = [...indices.slice(startIndex), ...indices.slice(0, startIndex)];

  for (let j = 0; j < orderedIndices.length; j++) {
    const i = orderedIndices[j];
    try {
      // Rotate through keys and models with the same logic
      const keyIndex = i % LLM_KEYS.length;
      const modelIndex = i % models.length;
      const key = LLM_KEYS[keyIndex];
      const model = models[modelIndex] || payload.model;

      const headers = {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      };
      const requestPayload = { ...payload, model, enable_thinking: false };
      const response = await axios.post(LLM_URLS[i], requestPayload, { headers });
      console.log(wrapText(`Using endpoint: ${LLM_URLS[i]} with model: ${model}`, '\x1b[32m✅ ') + '\x1b[0m');
      return response;
    } catch (error) {
      console.error(wrapText(`Error with LLM endpoint ${LLM_URLS[i]}: ${error.message}`, '❌ '));
      if (j === orderedIndices.length - 1) {
        throw error; // Throw error if all endpoints failed
      }
    }
  }
  console.error(wrapText('All LLM endpoints failed. Please check your configuration.', '❌ '));
  throw new Error('All LLM endpoints failed. Please check your configuration.');
}

/**
 * Function to process message with AI API
 *
 * @param {string} username
 * @param {string} message
 * @param {string | null} quotedMessage
 * @returns {Promise<string | null>}
 */
async function processWithAI(username, message, quotedMessage = null) {
  try {
    // Avoid escaping double quotes in the message
    message = message.replace(/"/g, "'");

    const conversationContext = getConversationHistory(username);
    let prompt = `${SYSTEM_PROMPT}`;

    if (quotedMessage) {
      prompt += `Quoted message: "${quotedMessage}"`;
    }

    // prompt += `${username}: ${message}`;

    const messages = [
      { role: "system", content: prompt },
      ...conversationContext,
      { role: "user", content: `${username}: ${message}` },
    ];

    const response = await tryLLMEndpoints({
      messages,
      max_tokens: MAX_TOKENS,
    });
    const content = response.data?.choices?.[0]?.message?.content;
    if (!content || content.trim() === "") {
      throw new Error();
    }
    return content;
  } catch (error) {
    console.error(wrapText(`Error processing with AI: ${error.message || error}`, "❌ "));
    return "I'm sorry but my brain appears to be broken. Please try again later. 💀";
  }
}

// Connect to Misskey streaming API
let ws = new WebSocket(`${WS_URL}/streaming?i=${ACCESS_TOKEN}`);
let pingInterval;

ws.on("open", () => {
  console.log(wrapText("Connected to Misskey streaming API", "🛜 "));
  ws.send(
    JSON.stringify({
      type: "connect",
      body: {
        channel: "main",
        id: "111111",
      },
    })
  );
  pingInterval = startPingInterval(ws);
});

// Object to store incoming messages
const incomingMessages = new Map();

// Cooldown duration in milliseconds
const COOLDOWN_DURATION = 2000; // 2 seconds

/**
 * Function to process messages after cooldown
 * @param {string} messageId
 * @returns {void}
 */
function processMessageAfterCooldown(messageId) {
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
 * @param {{ type: string, body: any }} message
 * @returns {Promise<void>}
 */
async function processMessage(message) {
  const note = message.body.body;

  // Censorship
  note.text = note.text.replace(/nig(ger)?|jeet/gi, 'elon')
    .replace(/rape|fuck/gi, 'gently caress')


  // Check if the note is a reply to the bot or mentions the bot
  const isReplyToBot =
    note.reply && note.reply?.userId === BOT_USER_ID;
  const isMentionToBot = note.text?.includes(`@${BOT_USERNAME}`);

  // Check if the message is NOT from the bot itself to prevent loops
  if (
    (isReplyToBot || isMentionToBot) &&
    note.userId !== BOT_USER_ID
  ) {
    const user = getUserFromNote(note);
    console.log(wrapText(note.text, `👤 ${user}: `));
    addToMemory(user, null, note.text, "user");

    let quotedMessage = null;
    if (isReplyToBot) {
      quotedMessage = note.reply?.text;
    }

    // Process the note with AI
    const response = await processWithAI(
      user,
      note.text,
      quotedMessage
    );

    // Check if the original message is a direct message
    const isDirectMessage = note.visibility === "specified";

    // Send the response as a reply
    if (response !== null) {
      await sendReply(response, note, isDirectMessage);
    }
  }
}

/**
 * @param {Note} note
 * @returns {string} - The user identifier in the format "username@host" or just "username"
 */
function getUserFromNote(note) {
  let user = '';
  if (note?.user.host) {
    user = `${note.user.username}@${note.user.host}`;
  } else {
    user = note?.user.username
  }

  return user;
}

ws.on("message", async (data) => {
  const stringData = data.toString("utf-8");

  try {
    const message = JSON.parse(stringData);
    if (message.type === "pong") {
      //received pong
    } else if (
      message.type === "channel" &&
      (message.body.type === "mention" || message.body.type === "reply")
    ) {
      const note = message.body.body;
      const messageId = note.id;

      // Store the message
      if (!incomingMessages.has(messageId)) {
        incomingMessages.set(messageId, []);
        processMessageAfterCooldown(messageId);
      }
      incomingMessages.get(messageId).push({
        type: message.body.type,
        body: message.body,
      });
    }
  } catch (error) {
    console.error(wrapText(`Error parsing message: ${error.message || error}`, "❌ "));
  }
});

ws.on("error", (error) => {
  console.error(wrapText(`WebSocket error: ${error.message || error}`, "❌ "));
});

ws.on("close", () => {
  console.log(wrapText("Disconnected from Misskey streaming API", "🔌 "));
  clearInterval(pingInterval);
  setTimeout(() => {
    ws = new WebSocket(`${WS_URL}/streaming?i=${ACCESS_TOKEN}`);
  }, 5000); // Try to reconnect after 5 seconds
});

/**
 * Function to add a message to the auto conversation memory
 * @param {string} username
 * @param {string} message
 * @returns {void}
 */
function addToAutoMemory(username, message) {
  autoMemory.push(`${username}: ${message}`);
  if (autoMemory.length > MAX_AUTO_MEMORY) {
    autoMemory.shift();
  }
  // saveMemoryToFile();
}

/**
 * Function to get the auto conversation history as a string
 * @returns {string}
 */
function getAutoConversationHistory() {
  return autoMemory.join("\n").replace(/"/g, "'");
}

/**
 * Function to process auto message with AI API
 * @param {string} message
 * @returns {Promise<string | null>}
 */
async function processAutoWithAI(message) {
  try {
    // Avoid escaping double quotes in the message
    message = message.replace(/"/g, "'");

    // const conversationContext = getAutoConversationHistory();
    let prompt = `${SYSTEM_PROMPT_AUTO}`;

    const response = await tryLLMEndpoints({
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: message },
      ],
      max_tokens: MAX_TOKENS,
    }, true);
    return response.data?.choices?.[0]?.message?.content;
  } catch (error) {
    console.error(wrapText(`Error processing auto message with AI: ${error.message || error}`, "❌ "));
    return null;
  }
}

/**
 * Function to send an auto message
 * @returns {Promise<void>}
 */
async function sendAutoMessage() {
  let response = await processAutoWithAI("AUTO");
  if (response !== null) {
    // clean up the response: if it starts with "AUTO" or "ENV_BOT_NAME:", remove it.
    response = response.replace(/^AUTO: /gi, "");
    response = response.replace(
      new RegExp(BOT_USERNAME + ": ", "gi"),
      ""
    );

    await sendNoteToChannel(response);
    addToAutoMemory(BOT_USERNAME, response);
  }
}

/**
 * Function to schedule the next auto message
 * @returns {void}
 */
function scheduleNextAutoMessage() {
  const minDelay = 5 * 60 * 1000; // 30 minutes
  const maxDelay = 30 * 60 * 1000; // 4 hours
  const delay =
    Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;

  setTimeout(() => {
    sendAutoMessage();
    scheduleNextAutoMessage();
  }, delay);

  console.log(wrapText(`Next auto message in ${(delay / 60000).toFixed(1)} minutes`, "🕥 "));
}

// Start the auto message scheduling
scheduleNextAutoMessage();

/**
 * Start ping interval for WebSocket
 * @param {WebSocket} ws
 * @returns {NodeJS.Timeout}
 */
function startPingInterval(ws) {
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
const memorySaveInterval = setInterval(() => {
  saveMemoryToFile();
}, 5 * 60 * 1000);

// Handle graceful shutdown to save memory
process.on('SIGINT', () => {
  console.log(wrapText('Saving memory before shutdown...', '💾 '));
  saveMemoryToFile();
  process.exit(0);
});

// Load memory from file when starting
loadMemoryFromFile();

console.log(wrapText(`${BOT_USERNAME} is running...`, "🤖 "));
