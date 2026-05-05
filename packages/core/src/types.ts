import { z } from 'zod';

// ─── LLM Types ───────────────────────────────────────────────────────────────

export const LLMProviderSchema = z.enum(['anthropic', 'openai', 'ollama']);
export type LLMProvider = z.infer<typeof LLMProviderSchema>;

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolResult {
  toolCallId: string;
  content: string;
  isError?: boolean;
}

export interface LLMResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  finishReason: 'stop' | 'tool_use' | 'max_tokens' | 'error';
}

export interface LLMRequestOptions {
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  capability?: 'reasoning';
}

export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onComplete?: (response: LLMResponse) => void;
  onError?: (error: Error) => void;
}

// ─── Tool Types ──────────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Tool {
  definition: ToolDefinition;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<string>;
}

export interface ToolContext {
  sessionId: string;
  userId?: string;
  skillName?: string;
  agent: AgentInterface;
}

// ─── Memory Types ────────────────────────────────────────────────────────────

export interface MemoryEntry {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface LongTermMemory {
  id: string;
  content: string;
  embedding?: number[];
  tags: string[];
  createdAt: number;
  accessedAt: number;
}

// ─── Session Types ───────────────────────────────────────────────────────────

export interface Session {
  id: string;
  userId?: string;
  platform?: string;
  messages: Message[];
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type DmScope = 'main' | 'per-peer' | 'per-channel-peer' | 'per-account-channel-peer';

export interface InboundContext {
  /** Human-readable label for the origin */
  label: string;
  /** Channel/provider ID (telegram, discord, cli, etc.) */
  provider: string;
  /** Sender routing ID */
  from: string;
  /** Recipient routing ID */
  to: string;
  /** Multi-account ID (optional) */
  accountId?: string;
  /** Thread or topic ID */
  threadId?: string;
  /** Chat type */
  chatType: 'dm' | 'group' | 'thread';
  /** Group/room ID for group chats */
  groupId?: string;
}

export interface SessionEntry {
  sessionId: string;
  sessionKey: string;
  updatedAt: string;
  createdAt: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  contextTokens: number;
  origin: {
    label: string;
    provider: string;
    from: string;
    to: string;
    accountId?: string;
    threadId?: string;
  };
  displayName?: string;
  channel?: string;
  subject?: string;
  room?: string;
  space?: string;
}

export interface TranscriptEntry {
  timestamp: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  metadata?: {
    tokens?: number;
    model?: string;
    toolName?: string;
    toolResult?: unknown;
  };
}

export type ResetMode = 'daily' | 'idle' | 'never';

export interface ResetPolicy {
  mode: ResetMode;
  atHour?: number;
  idleMinutes?: number;
}

export interface SessionResetConfig {
  reset: ResetPolicy;
  resetByType?: {
    dm?: ResetPolicy;
    group?: ResetPolicy;
    thread?: ResetPolicy;
  };
  resetByChannel?: Record<string, ResetPolicy>;
  resetTriggers: string[];
}

export interface SendPolicyRule {
  action: 'allow' | 'deny';
  match: {
    channel?: string;
    chatType?: 'dm' | 'group' | 'thread';
    keyPrefix?: string;
  };
}

export interface SendPolicyConfig {
  rules: SendPolicyRule[];
  default: 'allow' | 'deny';
}

export interface SessionConfig {
  dmScope: DmScope;
  mainKey: string;
  identityLinks: Record<string, string[]>;
  reset: ResetPolicy;
  resetByType?: {
    dm?: ResetPolicy;
    group?: ResetPolicy;
    thread?: ResetPolicy;
  };
  resetByChannel?: Record<string, ResetPolicy>;
  resetTriggers: string[];
  sendPolicy: SendPolicyConfig;
  pruning: {
    enabled: boolean;
    maxToolResultAge: number;
    keepLastNToolResults: number;
  };
  compaction: {
    enabled: boolean;
    threshold: number;
    autoFlushMemory: boolean;
  };
  store: string;
}

// ─── Config Types ────────────────────────────────────────────────────────────

export interface AgentConfig {
  agent: {
    name: string;
    defaultProvider: LLMProvider;
    model: string;
    intelligence?: {
      enabled: boolean;
      observationOnly: boolean;
      influenceMode?: 'off' | 'force-reasoning';
    };
    retrieval?: {
      enabled: boolean;
    };
  };
  providers: {
    anthropic?: { model: string; maxTokens: number };
    openai?: { model: string; maxTokens: number };
    ollama?: { model: string; baseUrl: string };
  };
  memory: {
    maxConversationHistory: number;
    summarizeAfter: number;
    embeddingProvider: string;
  };
  sessions: {
    persistToDisk: boolean;
    ttlMinutes: number;
  } & Partial<SessionConfig>;
  skills: {
    directory: string;
    autoReload: boolean;
  };
  browser: {
    headless: boolean;
    timeout: number;
  };
  voice: {
    ttsProvider: string;
    sttProvider: string;
    whisperModel: string;
  };
  scheduler: {
    enabled: boolean;
    heartbeatIntervalMinutes: number;
  };
  security: {
    sandboxShell: boolean;
    shellPermissionLevel: 'unrestricted' | 'ask-confirm' | 'allowlist-only' | 'disabled';
    maxShellTimeout: number;
    encryptStorage: boolean;
    auditLog: boolean;
    auditRetentionDays: number;
    localAuth: boolean;
    autoLockMinutes: number;
    multiUserMode: boolean;
    requireOwnerApproval: boolean;
    ownerPlatformId: string;
  };
  health: {
    enabled: boolean;
    port: number;
    authToken?: string;
  };
}

// ─── Event Types ─────────────────────────────────────────────────────────────

export interface AgentEvents {
  message: (message: Message, sessionId: string) => void;
  response: (response: LLMResponse, sessionId: string) => void;
  toolCall: (toolCall: ToolCall, sessionId: string) => void;
  toolResult: (result: ToolResult, sessionId: string) => void;
  error: (error: Error) => void;
  sessionCreated: (session: Session) => void;
  sessionEnded: (sessionId: string) => void;
}

// ─── Agent Interface ─────────────────────────────────────────────────────────

export interface AgentInterface {
  chat(input: string, sessionId?: string): Promise<string>;
  getSession(sessionId: string): Session | undefined;
  getConfig(): AgentConfig;
}

// ─── Skill Types ─────────────────────────────────────────────────────────────

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  triggers: string[];
  permissions: string[];
  author?: string;
}

export interface Skill {
  manifest: SkillManifest;
  tools: Tool[];
  onLoad?(): Promise<void>;
  onUnload?(): Promise<void>;
}

// ─── Integration Types ───────────────────────────────────────────────────────

export interface Integration {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

// ─── Scheduler Types ─────────────────────────────────────────────────────────

export interface ScheduledTask {
  id: string;
  name: string;
  cronExpression: string;
  handler: () => Promise<void>;
  enabled: boolean;
}
