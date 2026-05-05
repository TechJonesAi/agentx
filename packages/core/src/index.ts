// Core agent
export { Agent } from './agent.js';

// Configuration
export { loadConfig, ensureDataDir, resolveDataDir, parseBoolEnv, applyEnvOverrides } from './config.js';

// LLM Providers
export { BaseLLMProvider, AnthropicProvider, OpenAIProvider, OllamaProvider, createProvider } from './llm/index.js';

// Memory
export { createDatabase, ConversationMemory, LongTermMemoryStore } from './memory/index.js';

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
