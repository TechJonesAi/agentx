// Core agent
export { Agent } from './agent.js';

// Configuration
export { loadConfig, ensureDataDir, resolveDataDir, parseBoolEnv, applyEnvOverrides } from './config.js';

// LLM Providers
export { BaseLLMProvider, AnthropicProvider, OpenAIProvider, OllamaProvider, createProvider, resolveOllamaModel } from './llm/index.js';
export type { OllamaModelResolution } from './llm/index.js';
// Tier 3 Models/Routing Batch — route-level (Strategy 3) helpers for
// GET/POST /api/models/routing. No agent.ts wiring; the route reads/writes
// `~/.agentx/routing.json` directly and optionally probes Ollama for live
// model discovery.
export {
  loadRoutingConfig,
  saveRoutingConfig,
  validateRoutingConfig,
  probeOllamaModels,
  ROUTING_CONFIG_FILENAME,
} from './llm/routing-config.js';
export type { RoutingConfigValidation, OllamaProbeResult } from './llm/routing-config.js';
export type { RoutingPolicyConfig } from './llm/routing-policy.js';
export { DEFAULT_ROUTING_POLICY_CONFIG } from './llm/routing-policy.js';
export type { RoutingMode } from './llm/model-registry.js';
// Tier 3 Vision Batch — route-level vision analysis (Strategy 3, no agent.ts).
// `analyzeImageBuffer` wraps OllamaVisionProvider; tests substitute via
// setVisionProviderForTesting / clearVisionProviderForTesting.
export {
  analyzeImageBuffer,
  getVisionProvider,
  setVisionProviderForTesting,
  clearVisionProviderForTesting,
} from './multimodal/vision-service.js';
export type { VisionAnalyzeResult } from './multimodal/vision-service.js';
export type { VisionProvider } from './multimodal/index.js';

// Memory
export { createDatabase, ConversationMemory, LongTermMemoryStore } from './memory/index.js';
export { runCognitiveMemoryMigrations } from './db/migrations/index.js';
// Retrieval bridge — one-way sync from cognitive_memory.db → agentx.db
// so live R1–R12 retrieval finds the restored 253 documents.
export { syncCognitiveToRetrieval } from './db/sync-cognitive-to-retrieval.js';
export type { SyncResult } from './db/sync-cognitive-to-retrieval.js';
// Tier 1 safe-batch re-exports — needed by web routes for /api/agent-loops/*,
// /api/agents/trace, and /api/logs/llm-interactions/:id. Adding subpath
// re-exports here is safer than relying on `@agentx/core/dist/...` deep
// imports which break under vitest's prefix-matching alias.
export { eventBus } from './agent-loop/event-bus.js';
export { runtimeStateStore } from './agent-loop/runtime-state.js';
export { LLMInteractionLogger } from './observability/llm-interaction-logger.js';
export { HealthMonitor } from './observability/health-monitor.js';
export type { Probe, HealthCheck, HealthStatus as MonitorHealthStatus, RepairAttempt, RepairOutcome } from './observability/health-monitor.js';
export { ToolOutcomeStore } from './observability/tool-outcome-store.js';
export type { ToolOutcome, ToolReliability } from './observability/tool-outcome-store.js';
export { ModelRoutingHistory } from './observability/model-routing-history.js';
export type { ModelRoutingDecision } from './observability/model-routing-history.js';
export { RuntimeSettingsStore, DEFAULT_SETTINGS as DEFAULT_RUNTIME_SETTINGS, LIVE_TOGGLES, RESTART_REQUIRED } from './observability/runtime-settings-store.js';
export type { RuntimeSettings } from './observability/runtime-settings-store.js';
export { RetrievalOutcomeStore } from './observability/retrieval-outcome-store.js';
export type { RetrievalOutcome, RetrievalReliability } from './observability/retrieval-outcome-store.js';
// Tier 2 batch B re-exports — needed by web routes for /api/mcp/* writes.
// These are route-level config helpers; no MCP runtime instantiation here.
export { loadMCPConfig, saveMCPConfig, validateServerConfig, DEFAULT_MCP_CONFIG } from './mcp/config.js';
// Batch A2 — Private-memory-first enforcement public API
export {
  assessRetrievalSufficiency,
  extractQueryTerms,
  type RetrievalSufficiencyDecision,
  type RetrievalSufficiencyInput,
  type RetrievalDocLite,
} from './reasoning/retrieval-sufficiency.js';
export {
  DecisionTraceBuffer,
  filterEvents,
  type PrivateMemoryEvent,
  type PrivateMemoryEventName,
  type ToolFallbackBlockedEvent,
  type RetrievalSufficiencyEvent,
} from './observability/private-memory-events.js';
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
