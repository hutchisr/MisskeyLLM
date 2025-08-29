import * as z from "jsr:@zod/zod";

export type Username = string;

export type Message = {
  role: string;
  content: string;
};

export type Note = {
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

export type User = {
  id: string;
  name: string | null;
  username: string;
  host: string;
  [key: string]: unknown;
};

export type LLMRequestPayload = {
  messages: Message[];
  model?: string;
  plugins?: Array<{ id: string }>;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  reasoning?: { exclude: boolean; max_tokens: number };
  [key: string]: unknown;
};

export type LLMResponse = {
  choices?: Array<{ message: Message }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  [key: string]: unknown;
};

export type ConversationMemory = Record<Username, Message[]>;

export type MemoryData = {
  conversationMemory: ConversationMemory;
  autoMemory: string[];
};

export const Config = z.object({
  url: z.url().min(1, "url must not be empty"),
  ws_url: z.url().min(1, "ws_url must not be empty"),
  token: z.string().min(1, "token must not be empty"),
  channel: z.string().optional(),
  llm_endpoints: z.array(
    z.object({
      url: z.url().min(1, "endpoint url must not be empty"),
      key: z.string().optional(),
      model: z.string().min(1, "model must not be empty"),
    }),
  ).min(1, "llm_endpoints must not be empty"),
  max_tokens: z.int().positive("max_tokens must be greater than 0"),
  bot_user_id: z.string().min(1, "bot_user_id must not be empty"),
  bot_username: z.string().min(1, "bot_username must not be empty"),
  system_prompt: z.string().min(1, "system_prompt must not be empty"),
  system_prompt_auto: z.string().min(1, "system_prompt_auto must not be empty"),
  redis_uri: z.url()
    .regex(
      /^(redis|rediss|redis-sentinel):\/\/(?:([^:/@\s]+)(?::([^@\s]*))?@)?([^:/@\s]+|\[[a-fA-F0-9:]+\])(?::(\d+))?(?:\/(\d+))?$/,
      "redis_uri must be a valid Redis URI (redis:// or rediss://)",
    )
    .optional(),
  redis_key_prefix: z.string().min(1, "redis_key_prefix must not be empty").optional(),
  redis_key_ttl: z.int().positive("redis_key_ttl must be greater than 0").optional(),
  max_retries: z.int().positive("max_retries must be greater than 0"),
  max_memory: z.int().nonnegative("max_memory must not be negative"),
}).refine((data) => {
  // Custom validation: if redis_uri is provided, redis_key_ttl must be positive
  if (data.redis_uri && data.redis_key_ttl && data.redis_key_ttl <= 0) {
    return false;
  }
  return true;
}, {
  message: "redis_key_ttl must be greater than 0 when redis_uri is provided",
  path: ["redis_key_ttl"],
});

export type Config = z.infer<typeof Config>;

export type WebSocketMessage = {
  type: string;
  body?: {
    type?: string;
    body?: Note;
    channel?: string;
    id?: string;
  };
};

export type IncomingMessage = {
  type: string;
  body: {
    type: string;
    body: Note;
  };
};
