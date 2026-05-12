// Core agent
export { Agent } from './agent.js';

// Configuration
export { loadConfig, ensureDataDir, resolveDataDir, parseBoolEnv, applyEnvOverrides } from './config.js';

// LLM Providers
export { BaseLLMProvider, AnthropicProvider, OpenAIProvider, OllamaProvider, createProvider } from './llm/index.js';

// Memory
export { createDatabase, ConversationMemory, LongTermMemoryStore } from './memory/index.js';
export { runCognitiveMemoryMigrations } from './db/migrations/index.js';
// Tier 1 safe-batch re-exports — needed by web routes for /api/agent-loops/*,
// /api/agents/trace, and /api/logs/llm-interactions/:id. Adding subpath
// re-exports here is safer than relying on `@agentx/core/dist/...` deep
// imports which break under vitest's prefix-matching alias.
export { eventBus } from './agent-loop/event-bus.js';
export { runtimeStateStore } from './agent-loop/runtime-state.js';
export { LLMInteractionLogger } from './observability/llm-interaction-logger.js';
// Tier 2 batch B re-exports — needed by web routes for /api/mcp/* writes.
// These are route-level config helpers; no MCP runtime instantiation here.
export { loadMCPConfig, saveMCPConfig, validateServerConfig } from './mcp/config.js';
export type { MCPConfig, MCPServerConfig } from './mcp/types.js';
// Tier 3 Builder Batch 2 re-exports — for /api/builder/queue/{cancel,clear}
// tests that need to construct the manager classes directly.
export { BuildQueueManager } from './build-queue.js';
export type { BuildStatus, BuildQueueState, QueuedBuild } from './build-queue.js';
export { IdleManager } from './idle-manager.js';
export type { IdleState, IdleManagerConfig } from './idle-manager.js';
export {
  ingestUploadedDocument,
  extractTextFromUpload,
} from './ingestion/upload-ingest.js';
export type {
  IngestArgs,
  IngestResult,
  ExtractResult,
  UploadKind,
} from './ingestion/upload-ingest.js';
export { EmailRunner } from './email/email-runner.js';
export type {
  RawEmail,
  EmailSource,
  EmailRunResult,
  EmailRunnerStatus,
  EmailRunnerOptions,
} from './email/email-runner.js';
export { createImapSource } from './email/imap-source.js';
export type { ImapSourceOptions } from './email/imap-source.js';
export { FeedbackStore } from './memory/feedback-store.js';
export type { FeedbackPayload, FeedbackRecord, FeedbackRating } from './memory/feedback-store.js';

// Tools
export { ToolRegistry, getBuiltinTools } from './tools/index.js';

// Sessions
export {
  SessionManager,
  SessionStore,
  TranscriptManager,
  generateSessionKey,
  parseSessionKey,
  normalizeLegacyKey,
  IdentityResolver,
  SessionResetManager,
  SendPolicyManager,
  SessionPruner,
  CompactionManager,
  parseCommand,
} from './sessions/index.js';
export type {
  SessionFilter,
  IdentityConfig,
  ResetTriggerResult,
  PruningOptions,
  CompactionConfig,
  CommandResult,
  CommandContext,
} from './sessions/index.js';

// Scheduler
export { Scheduler } from './scheduler.js';

// Heartbeat
export { HeartbeatManager } from './heartbeat.js';
export type { HeartbeatRule, HeartbeatTarget, HeartbeatConfig, MessageSender } from './heartbeat.js';

// Users
export { UserManager } from './users.js';
export type { UserProfile, PlatformIdentity, MultiUserConfig, UserStatus } from './users.js';

// Context Management
export { ContextManager, estimateTokens, estimateMessageTokens } from './context-manager.js';
export type { ContextManagerConfig, ContextWindowResult } from './context-manager.js';

// Resilience
export { retryWithBackoff, CircuitBreaker, CircuitOpenError } from './resilience.js';
export type { RetryOptions, CircuitBreakerConfig, CircuitState } from './resilience.js';

// Rate Limiting
export { RateLimiter, PROVIDER_LIMITS } from './rate-limiter.js';
export type { RateLimiterConfig, RateLimiterEvents } from './rate-limiter.js';

// Health
export { HealthServer } from './health.js';
export type { HealthStatus, HealthStats, HealthServerConfig } from './health.js';

// Shutdown
export { ShutdownManager } from './shutdown.js';
export type { ShutdownHandler } from './shutdown.js';

// Logger
export { logger, createLogger } from './logger.js';

// Reasoning Service + Internet Search
export { ReasoningService } from './reasoning/reasoning-service.js';
export type {
  ReasoningInput, ReasoningOutput, ReasoningDiagnostics,
  ConfidenceLevel, InternetResult, InternetSearchProvider,
} from './reasoning/reasoning-service.js';
export { DuckDuckGoSearchProvider } from './reasoning/web-search-provider.js';

// Reasoning / Decision Engine (P8-1)
export { DecisionEngine, isUtilityQuery, isDocumentReferenceQuery } from './reasoning/decision-engine.js';
export type {
  DecisionEngineInput, DecisionEngineResult, DecisionDomain,
  DecisionStrategy, DecisionKnowledgeContext, DecisionAdvisorInput,
  DecisionRedFlagInput, DecisionValidationInput, DecisionValidationResult,
  AlignmentStatus, DecisionSummary,
  ClassificationSource, ExecutionTrace,
  ValidationSummary,
} from './reasoning/decision-engine.js';

// Security
export {
  CredentialManager, redactSecrets,
  ShellSandbox,
  DataEncryption, EncryptedColumnHelper,
  AuditLogger,
  LocalAuth,
  DataManager,
  PermissionManager,
} from './security/index.js';
export type {
  CredentialKey,
  ShellPermissionLevel, ShellSandboxConfig, ShellResult,
  AuditAction, AuditEntry, AuditQueryOptions,
  AuthResult,
  DataExport, DeleteResult, PlatformStats,
  PermissionType, PermissionGrant,
} from './security/index.js';

// Types
export type {
  AgentConfig,
  AgentEvents,
  AgentInterface,
  DmScope,
  InboundContext,
  Integration,
  LLMProvider,
  LLMRequestOptions,
  LLMResponse,
  LongTermMemory,
  MemoryEntry,
  Message,
  MessageRole,
  ResetMode,
  ResetPolicy,
  ScheduledTask,
  SendPolicyConfig,
  SendPolicyRule,
  Session,
  SessionConfig,
  SessionEntry,
  SessionResetConfig,
  Skill,
  SkillManifest,
  Tool,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolResult,
  StreamCallbacks,
  TranscriptEntry,
} from './types.js';
