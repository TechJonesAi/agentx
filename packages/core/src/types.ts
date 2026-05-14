import { z } from 'zod';

// ─── LLM Types ───────────────────────────────────────────────────────────────

export const LLMProviderSchema = z.enum(['anthropic', 'openai', 'ollama']);
export type LLMProvider = z.infer<typeof LLMProviderSchema>;

export const MessageRoleSchema = z.enum(['system', 'user', 'assistant', 'tool']);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * Multimodal content block — image/audio/document attachments to a message.
 *
 * Lifted from claude/silly-johnson during Phase B3 union-merge.
 * Used by the multimodal subsystem and the chat/multimodal route.
 */
export interface MultimodalContentBlock {
  type: 'text' | 'image' | 'audio' | 'document';
  data?: string;
  path?: string;
  text?: string;
  mimeType?: string;
  transcription?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface Message {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
  toolCalls?: ToolCall[];
  timestamp: number;
  /** Phase B3 union-merge: multimodal attachments from silly-johnson. */
  multimodalContent?: MultimodalContentBlock[];
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

export interface RetrievalMetadataDocument {
  document_id: string;
  file_name: string;
  title?: string;
  file_type?: string;
  sender?: string;
  /** R9: bounded excerpt around the matched phrase (≤ ~240 chars). Plain text. */
  snippet?: string;
  /** R9: the phrase to highlight inside `snippet` (case preserved from source). */
  matchedPhrase?: string;
}

export interface RetrievalMetadata {
  retrievalIntent: 'COUNT' | 'EXACT_SEARCH' | 'FILTERED_SEARCH' | 'SEMANTIC' | 'ANALYTICAL';
  retrievalSource: 'sql' | 'fts' | 'vector' | 'mixed';
  retrievalMatchCount: number;
  retrievalDocuments: RetrievalMetadataDocument[];
  /** For COUNT intent only — the SQL-derived numeric answer. */
  retrievalCount?: number;
}

export interface StreamCallbacks {
  onToken?: (token: string) => void;
  onToolCall?: (toolCall: ToolCall) => void;
  onComplete?: (response: LLMResponse) => void;
  onError?: (error: Error) => void;
  /** R3: fired BEFORE any model token streaming begins — only when
   *  retrieval is enabled and produces a result. */
  onRetrieval?: (metadata: RetrievalMetadata) => void;
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
      /** R10: hard timeout for retrieve() — fails closed on slow SQL/IO. Default 5000ms. */
      timeoutMs?: number;
      /** R10: cap on documents in retrieval metadata payload. Default 50. */
      maxMetadataDocs?: number;
    };
    entityIndexing?: {
      enabled: boolean;
    };
    /**
     * Batch A2 — Private-memory-first enforcement.
     * When true:
     *   - Cloud LLM providers (anthropic, openai) refuse to initialise.
     *   - Network-class tools (web_search, browser_*, etc.) are blocked
     *     at dispatch time regardless of retrieval sufficiency.
     *   - Default behaviour is unaffected when false (today's default).
     * Env override: AGENTX_LOCAL_ONLY=true|false.
     */
    localOnly?: boolean;
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
  /**
   * Phase B3 union-merge — config sections lifted from claude/silly-johnson.
   * All optional so existing main configs without these sections remain valid.
   */
  computerControl?: {
    enabled: boolean;
    defaultMode: string;
    maxActLoopSteps: number;
  };
  enableMemoryLearning?: boolean;
  /**
   * Feature flags shown on the Settings page. Each flag controls a live
   * behaviour in the running agent:
   *   - builderV2:        whether BuilderV2 app-generation pipeline is used
   *                       (vs. the legacy chat-based build path).
   *   - buildLearning:    whether BuildIntelligenceService biases model
   *                       ranking in ModelFabric.
   *   - projectWorkflows: whether the Projects page records automation_runs.
   */
  features?: {
    builderV2?: boolean;
    buildLearning?: boolean;
    projectWorkflows?: boolean;
    /**
     * When enabled (default: true), AgentX runs a post-turn tool-call
     * evaluator after any chat turn that used tools. The evaluator is
     * fire-and-forget (adds zero user-visible latency) and feeds a
     * `tool_call_quality` signal into the performance store that ranks
     * weak tool-callers down over time. Disable if the extra evaluator
     * call (tiny — uses llama3.1:8b) is unwanted.
     */
    toolCallEvaluator?: boolean;
    /**
     * When enabled, AgentX emits OpenTelemetry GenAI-conventioned spans for
     * every LLM call, tool execution, and subagent run. Spans are held
     * in-process unless OTEL_EXPORTER_OTLP_ENDPOINT is set (typically
     * http://localhost:6006/v1/traces for Arize Phoenix, purely local).
     * Default: false — zero overhead when off.
     */
    otelTracing?: boolean;
    /**
     * When also enabled, OTel spans include prompt / tool-argument content.
     * Useful for debugging but more privacy-sensitive. Requires otelTracing.
     * Default: false.
     */
    otelContentTracing?: boolean;
    /**
     * When enabled (default: true for backward compatibility), the
     * `web_search` tool is registered and advertised to the LLM. Queries
     * are sent to DuckDuckGo's public endpoints (api.duckduckgo.com and
     * html.duckduckgo.com) over HTTPS. Disable to keep the agent fully
     * offline — no query text ever leaves the host.
     */
    webSearch?: boolean;
  };
  routing?: {
    mode: 'LOCAL_ONLY' | 'COMBINATION' | 'SUBSCRIPTION_ONLY';
    maxLocalFailuresBeforeCloud?: number;
    allowCloudForLatencySensitiveTasks?: boolean;
    latencySensitiveThresholdMs?: number;
    fallbackChains?: Record<string, string[]>;
    capabilityPins?: Record<string, string>;
    /** User-set "default model" override from Settings page. */
    forceModel?: string | null;
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
