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
