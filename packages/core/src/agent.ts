import { EventEmitter } from 'eventemitter3';
import type Database from 'better-sqlite3';
import type {
  AgentConfig,
  AgentEvents,
  AgentInterface,
  Message,
  Session,
  ToolCall,
  ToolResult,
  LLMResponse,
  StreamCallbacks,
} from './types.js';
import { createProvider, type BaseLLMProvider } from './llm/index.js';
import { ToolRegistry, getBuiltinTools } from './tools/index.js';
import { ConversationMemory, LongTermMemoryStore, createDatabase } from './memory/index.js';
import { SessionManager, SendPolicyManager, SessionPruner, CompactionManager, parseCommand } from './sessions/index.js';
import type { SessionStore } from './sessions/index.js';
import type { InboundContext } from './types.js';
import type { CommandContext } from './sessions/commands.js';
import { loadConfig, ensureDataDir } from './config.js';
import { createLogger } from './logger.js';
import { AuditLogger } from './security/audit.js';
import { CredentialManager } from './security/keychain.js';
import { DataEncryption } from './security/encryption.js';
import { LocalAuth } from './security/auth.js';
import { DataManager } from './security/data.js';
import { PermissionManager } from './security/permissions.js';
import { HeartbeatManager } from './heartbeat.js';
import { UserManager } from './users.js';
import { ContextManager } from './context-manager.js';
import { retryWithBackoff, CircuitBreaker } from './resilience.js';
import { RateLimiter } from './rate-limiter.js';
import { HealthServer, type HealthStats } from './health.js';
import { IntentClassifier } from './reasoning/intent-classifier.js';
import { DomainClassifier } from './reasoning/domain-classifier.js';
import { KnowledgeProbe } from './reasoning/knowledge-probe.js';
import { detectRedFlag, type RedFlagResult } from './reasoning/redflag-gate.js';
import { DecisionEngine, type DecisionEngineInput, type DecisionSummary, type ExecutionTrace } from './reasoning/decision-engine.js';
import { RetrievalService } from './retrieval/retrieval-service.js';
import { extractSnippet } from './retrieval/snippet-extractor.js';
import { runCognitiveMemoryMigrations } from './db/migrations/index.js';
import { DocumentRegistry } from './memory/document-registry.js';
import type { QueryIntent, RetrievalResult } from './memory/types.js';
import type { RetrievalMetadata, RetrievalMetadataDocument } from './types.js';
import { EntityIngestionService, type EntityIngestionResult } from './entities/entity-ingestion-service.js';
import { FeedbackStore, type FeedbackPayload, type FeedbackRecord } from './memory/feedback-store.js';

// ─── Phase B-merge: silly-johnson advanced subsystems (additive) ─────────────
// All optional. Each subsystem either:
//   (a) eager-inits and is always available (Checkpoint/Baseline/Autonomy),
//   (b) lazy-inits when its config flag turns on (MCP, Hooks, OAuth,
//       AgentLoop, MultiAgentSupervisor), or
//   (c) is exposed via a getter that returns null until wired by a future
//       phase (HybridOrchestrator, ModelFabric).
import { MCPClientManager } from './mcp/client-manager.js';
import { HooksEngine } from './security/hooks-engine.js';
import { ClaudeOAuthService } from './security/claude-oauth.js';
import { CheckpointManager } from './stability/checkpoint-manager.js';
import { BaselineRegistry } from './stability/baseline-registry.js';
import { AutonomyGate } from './validation/autonomy-gate.js';
import { SelfImprovementController } from './validation/self-improvement-controller.js';
import { LearningEngine } from './learning/learning-engine.js';
import { PersonalIntelligence } from './learning/personal-intelligence.js';
import { IntelligenceHardening } from './learning/intelligence-hardening.js';
import { GlobalLearningService } from './learning/global-learning.js';
import { BuildIntelligenceService } from './learning/build-intelligence.js';
import { SelfImprovementService } from './learning/self-improvement.js';
import { UserPersonalizationService } from './learning/user-personalization.js';
import { AdaptiveStatusService } from './learning/adaptive-status.js';
import { MemoryConsolidator } from './memory/memory-consolidator.js';
import { VectorIndexService } from './memory/vector-index-service.js';
import { AgentLoopEngine } from './agent-loop/agent-loop-engine.js';
import { ExperienceStore as LoopExperienceStore } from './agent-loop/learning/experience-store.js';
import { eventBus as agentLoopEventBus } from './agent-loop/event-bus.js';
import type { AgentLoopState } from './agent-loop/agent-loop-types.js';
import type { Subagent, SubagentConfig } from './agent-loop/subagent.js';
import { MultiAgentBuildSupervisor } from './agents/multi-agent-supervisor.js';
import type { HybridOrchestrator } from './hybrid/hybrid-orchestrator.js';
import type { ModelFabric } from './llm/model-fabric.js';
// Phase B-merge round 2: additional lifted subsystems exposed via getters
import { EpisodeStore } from './memory/episodic-memory.js';
import { CategorizedMemoryStore } from './memory/categorized-memory.js';
import { MemoryIngestionEngine } from './memory/memory-ingestion.js';
import { KnowledgeFlowEngine } from './memory/knowledge-flow.js';
import { KnowledgeAugmenter } from './memory/knowledge-augmenter.js';
import { AdvisorOrchestrator } from './memory/advisor-orchestrator.js';
import { BuildSessionManager } from './memory/build-session.js';
import { InteractionEvaluator } from './memory/interaction-evaluator.js';
import { EmailIngestionService } from './email/index.js';
import { EmailRunner } from './email/email-runner.js';
import type { EmailSource } from './email/email-runner.js';
import { createImapSource } from './email/imap-source.js';
import { LLMInteractionLogger } from './observability/llm-interaction-logger.js';
import { SystemLogBuffer } from './observability/system-log-buffer.js';
import { ActionEngine } from './action-engine/index.js';
import { RealAutomationPolicyService } from './services/automation-policy.js';
import { RealAutomationRunStore } from './services/automation-run-store.js';
import { RealAutomationEngine } from './services/automation-engine.js';
import { RealComputerPermissionService } from './services/computer-permission.js';
import { RealComputerSettingsService } from './services/computer-settings.js';
import { RealScreenshotManager } from './services/screenshot-manager.js';

const log = createLogger('agent');

const DEFAULT_SYSTEM_PROMPT = `You are AgentX, a capable AI assistant. You can use tools to accomplish tasks.
Be helpful, concise, and accurate. When you need to perform actions, use the available tools.
Always explain what you're doing and why.`;

export class Agent extends EventEmitter<AgentEvents> implements AgentInterface {
  private config: AgentConfig;
  private provider: BaseLLMProvider;
  private toolRegistry: ToolRegistry;
  private conversationMemory: ConversationMemory;
  private longTermMemory: LongTermMemoryStore;
  private sessionManager: SessionManager;
  private db: Database.Database;
  private systemPrompt: string;

  // Security subsystems
  private auditLogger: AuditLogger;
  private credentialManager: CredentialManager;
  private encryption: DataEncryption;
  private localAuth: LocalAuth;
  private dataManager: DataManager;
  private permissionManager: PermissionManager;

  // Heartbeat & users
  private heartbeatManager: HeartbeatManager;
  private userManager: UserManager;

  // Context, resilience, rate limiting, health
  private contextManager: ContextManager;
  private llmCircuitBreaker: CircuitBreaker;
  private rateLimiter: RateLimiter;
  private healthServer: HealthServer;
  private messagesProcessed = 0;
  private lastActivityTime: number | null = null;
  private shellConfirmCallback: ((command: string) => Promise<boolean>) | null = null;

  // New session subsystems
  private sendPolicyManager: SendPolicyManager;
  private sessionPruner: SessionPruner;
  private compactionManager: CompactionManager;

  // Abort controllers per session for /stop support
  private sessionAbortControllers = new Map<string, AbortController>();

  // Phase 4: Intelligence observation (Decision Engine wiring, observation-only)
  private _intelligenceEnabled = false;
  private _intelligenceObservationOnly = true;
  private _intelligenceInfluenceMode: 'off' | 'force-reasoning' = 'off';
  private _intentClassifier: IntentClassifier | null = null;
  private _domainClassifier: DomainClassifier | null = null;
  private _knowledgeProbe: KnowledgeProbe | null = null;
  private _decisionEngine: DecisionEngine | null = null;
  private _lastDecisionSummary: DecisionSummary | null = null;
  private _lastExecutionTrace: ExecutionTrace | null = null;
  private _lastRedFlag: RedFlagResult | null = null;
  private _lastForceReasoning = false;

  // R2/R3: Retrieval integration
  private _retrievalEnabled = false;
  private _retrievalService: RetrievalService | null = null;
  private _lastRetrievalIntent: QueryIntent | null = null;
  private _lastRetrievalResults: RetrievalResult[] = [];
  private _lastRetrievalMetadata: RetrievalMetadata | null = null;

  // R5: Entity ingestion
  private _entityIndexingEnabled = false;
  private _entityIngestionService: EntityIngestionService | null = null;

  // R10: retrieval safety + observability
  private _retrievalTimeoutMs = 5000;
  private _retrievalMaxMetadataDocs = 50;
  private _lastRetrievalStats: { intent: string; source: string; matchCount: number; elapsedMs: number } | null = null;
  private _lastRetrievalError: string | null = null;

  // R11: feedback store (always available, no flag)
  private _feedbackStore: FeedbackStore;

  // ─── Phase B-merge: silly-johnson subsystems (additive, all opt-in) ─────
  // Lazy: only instantiated when config.features.* enables them, or never
  //       (MCP/Hooks/OAuth need on-disk config files to activate)
  private _claudeOAuthService: ClaudeOAuthService | null = null;
  private _mcpClientManager: MCPClientManager | null = null;
  private _hooksEngine: HooksEngine | null = null;
  // Eager: instantiated by the constructor's restoration block, never null
  private _checkpointManager!: CheckpointManager;
  private _baselineRegistry!: BaselineRegistry;
  private _autonomyGate!: AutonomyGate;
  private _selfImprovementController!: SelfImprovementController;
  private _learningEngine!: LearningEngine;
  private _personalIntelligence!: PersonalIntelligence;
  private _intelligenceHardening!: IntelligenceHardening;
  private _adaptiveStatusService!: AdaptiveStatusService;
  // Deferred: depend on subsystems wired in a later phase
  private _memoryConsolidator: MemoryConsolidator | null = null;
  private _vectorIndexService: VectorIndexService | null = null;
  // Lazy: opt-in via config.features
  private _globalLearningService: GlobalLearningService | null = null;
  private _buildIntelligenceService: BuildIntelligenceService | null = null;
  private _selfImprovementService: SelfImprovementService | null = null;
  private _userPersonalizationService: UserPersonalizationService | null = null;
  private _agentLoopEngine: AgentLoopEngine | null = null;
  private _multiAgentSupervisor: MultiAgentBuildSupervisor | null = null;
  // Reserved for future ModelFabric/HybridOrchestrator wiring; getters
  // return null until a later phase wires them up against silly's
  // multi-provider routing layer.
  private _hybridOrchestrator: HybridOrchestrator | null = null;
  private _modelFabric: ModelFabric | null = null;

  // ── Phase B-merge round 2: eager-init subsystems with safe ctors ──────
  // All declared `!` because the constructor's restoration block fills them
  // before any external caller can reach them via getters.
  private _episodeStore!: EpisodeStore;
  private _categorizedMemoryStore!: CategorizedMemoryStore;
  private _memoryIngestionEngine!: MemoryIngestionEngine;
  private _knowledgeFlowEngine!: KnowledgeFlowEngine;
  private _knowledgeAugmenter!: KnowledgeAugmenter;
  private _advisorOrchestrator!: AdvisorOrchestrator;
  private _buildSessionManager!: BuildSessionManager;
  private _interactionEvaluator!: InteractionEvaluator;
  private _automationPolicyService!: RealAutomationPolicyService;
  private _automationRunStore!: RealAutomationRunStore;
  private _automationEngine!: RealAutomationEngine;
  private _computerPermissionService!: RealComputerPermissionService;
  private _computerSettingsService!: RealComputerSettingsService;
  private _screenshotManager!: RealScreenshotManager;
  // Lazy: depends on external config (Gmail Keychain) or circular refs
  private _emailIngestionService: EmailIngestionService | null = null;
  private _emailRunner: EmailRunner | null = null;
  private _actionEngine: ActionEngine | null = null;

  constructor(configPath?: string) {
    super();

    this.config = loadConfig(configPath);
    const dataDir = ensureDataDir();

    this.db = createDatabase(dataDir);
    this._feedbackStore = new FeedbackStore(this.db); // R11: always available
    this.provider = createProvider(this.config.agent.defaultProvider, this.config);
    this.toolRegistry = new ToolRegistry();
    this.conversationMemory = new ConversationMemory(
      this.db,
      this.config.memory.maxConversationHistory,
      this.config.memory.summarizeAfter,
    );
    this.longTermMemory = new LongTermMemoryStore(this.db);
    this.sessionManager = new SessionManager(this.db, this.config.sessions.ttlMinutes, this.config.agent.name);
    this.systemPrompt = DEFAULT_SYSTEM_PROMPT;

    // Initialize enhanced session subsystems
    this.sessionManager.initEnhanced(this.config.sessions);

    this.sendPolicyManager = new SendPolicyManager(
      this.config.sessions.sendPolicy ?? { rules: [], default: 'allow' },
      this.config.agent.name,
    );
    this.sessionPruner = new SessionPruner();
    this.compactionManager = new CompactionManager(this.config.sessions.compaction);

    // Initialize security subsystems
    this.auditLogger = new AuditLogger(
      this.db,
      this.config.security.auditLog,
      this.config.security.auditRetentionDays,
    );
    this.credentialManager = new CredentialManager(dataDir);
    // Tier 2 batch A: instantiate ClaudeOAuthService with the existing
    // CredentialManager. Construction has no I/O — Keychain reads happen
    // lazily in getStatus()/disconnect()/startAuthFlow().
    this._claudeOAuthService = new ClaudeOAuthService(this.credentialManager);
    this.encryption = new DataEncryption();
    this.localAuth = new LocalAuth(dataDir);
    this.dataManager = new DataManager(this.db);
    this.permissionManager = new PermissionManager(dataDir);

    this.toolRegistry.setPermissionManager(this.permissionManager);

    // Heartbeat & users
    this.heartbeatManager = new HeartbeatManager();
    this.heartbeatManager.setMessageGenerator(async (prompt: string) => {
      const response = await this.completeWithResilience({
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        systemPrompt: this.systemPrompt,
      });
      return response.content;
    });
    this.userManager = new UserManager(this.db, {
      multiUserMode: this.config.security.multiUserMode,
      requireOwnerApproval: this.config.security.requireOwnerApproval,
      ownerPlatformId: this.config.security.ownerPlatformId,
    });

    // Context manager — configurable per provider
    this.contextManager = new ContextManager(this.config.agent.defaultProvider);
    this.contextManager.setSummarizer(async (msgs: Message[]) => {
      const text = msgs.map((m) => `${m.role}: ${m.content}`).join('\n');
      const resp = await this.provider.complete({
        messages: [{ role: 'user', content: `Summarize this conversation concisely:\n\n${text}`, timestamp: Date.now() }],
        systemPrompt: 'You are a summarization assistant. Provide concise, factual summaries.',
      });
      return resp.content;
    });

    // Wire compaction manager
    this.compactionManager.setSummarizer(async (msgs: Message[]) => {
      const text = msgs.map((m) => `${m.role}: ${m.content}`).join('\n');
      const resp = await this.provider.complete({
        messages: [{ role: 'user', content: `Summarize this conversation concisely:\n\n${text}`, timestamp: Date.now() }],
        systemPrompt: 'You are a summarization assistant. Provide concise, factual summaries.',
      });
      return resp.content;
    });

    // Wire memory flusher — runs a silent LLM turn to extract durable notes before compaction
    this.compactionManager.setMemoryFlusher(async (sessionId: string) => {
      const messages = this.conversationMemory.getMessages(sessionId);
      if (messages.length < 10) return; // Not enough to extract from

      const text = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
      const flushResp = await this.provider.complete({
        messages: [{
          role: 'user',
          content: `Review this conversation and extract any important facts, decisions, preferences, or commitments that should be remembered long-term. Return them as a concise bulleted list. If nothing important, return "none".\n\n${text}`,
          timestamp: Date.now(),
        }],
        systemPrompt: 'You extract durable knowledge from conversations. Be concise and factual.',
      });

      const notes = flushResp.content.trim();
      if (notes && notes.toLowerCase() !== 'none') {
        this.longTermMemory.store(
          `[Auto-extracted before compaction]\n${notes}`,
          ['compaction', 'auto-extracted', `session:${sessionId}`],
        );
        log.info({ sessionId, notesLength: notes.length }, 'Memory flushed before compaction');
      }
    });

    // Circuit breaker for LLM calls
    this.llmCircuitBreaker = new CircuitBreaker('llm-provider', {
      failureThreshold: 5,
      cooldownMs: 60_000,
      successThreshold: 2,
    });

    // Rate limiter for LLM calls
    this.rateLimiter = new RateLimiter(this.config.agent.defaultProvider);

    // Health server
    this.healthServer = new HealthServer(
      {
        port: this.config.health.port,
        authToken: this.config.health.authToken,
      },
    );
    this.healthServer.setStatsProvider(() => this.collectStats());

    this.registerBuiltinTools();

    // Auto-start health server if enabled
    if (this.config.health.enabled) {
      this.healthServer.start().catch((err) => {
        log.error({ error: err }, 'Failed to start health server');
      });
    }

    // R2: Initialize retrieval integration if enabled
    if (this.config.agent.retrieval?.enabled) {
      runCognitiveMemoryMigrations(this.db);
      this._retrievalEnabled = true;
      this._retrievalService = new RetrievalService(this.db);
      // R10: read safety knobs (with safe positive-integer defaults)
      const t = this.config.agent.retrieval.timeoutMs;
      if (typeof t === 'number' && Number.isFinite(t) && t > 0) this._retrievalTimeoutMs = t;
      const m = this.config.agent.retrieval.maxMetadataDocs;
      if (typeof m === 'number' && Number.isFinite(m) && m > 0) this._retrievalMaxMetadataDocs = Math.floor(m);
    }

    // R5: Initialize entity ingestion if enabled (independent of retrieval flag)
    if (this.config.agent.entityIndexing?.enabled) {
      runCognitiveMemoryMigrations(this.db);
      this._entityIndexingEnabled = true;
      this._entityIngestionService = new EntityIngestionService(this.db);
    }

    // Phase 4/5: Initialize intelligence observation + optional influence
    const intel = this.config.agent.intelligence;
    if (intel?.enabled) {
      const mode = (intel.influenceMode ?? 'off') as 'off' | 'force-reasoning';
      if (!intel.observationOnly && mode !== 'off' && mode !== 'force-reasoning') {
        throw new Error(`Decision Engine influenceMode "${intel.influenceMode}" not supported. Allowed: off | force-reasoning`);
      }
      this._intelligenceEnabled = true;
      this._intelligenceObservationOnly = intel.observationOnly;
      this._intelligenceInfluenceMode = mode;
      this._intentClassifier = new IntentClassifier();
      this._domainClassifier = new DomainClassifier();
      this._knowledgeProbe = new KnowledgeProbe();
      this._decisionEngine = new DecisionEngine();
    }

    log.info({
      provider: this.config.agent.defaultProvider,
      retrieval: this._retrievalEnabled,
      entityIndexing: this._entityIndexingEnabled,
      intelligence: this._intelligenceEnabled,
    }, 'Agent initialized');

    // Loud warning when the configured provider has no auth and isn't a
    // local provider. Surfaces to the startup log so operators see this
    // before the first chat() call returns 503.
    const providerId = this.config.agent.defaultProvider;
    if (providerId === 'anthropic' && !process.env['ANTHROPIC_API_KEY']) {
      log.warn({ providerId }, 'ANTHROPIC_API_KEY not set — chat() will fail with PROVIDER_AUTH_MISSING. Set the env var or switch agent.defaultProvider to ollama.');
    }
    if (providerId === 'openai' && !process.env['OPENAI_API_KEY']) {
      log.warn({ providerId }, 'OPENAI_API_KEY not set — chat() will fail with PROVIDER_AUTH_MISSING. Set the env var or switch agent.defaultProvider to ollama.');
    }

    // ─── Phase B-merge: silly-johnson restoration (additive subsystem init) ──
    // Eager-init subsystems that have no external dependencies and no config
    // flag. These are always available via getters; they're cheap to construct
    // and have no runtime cost until something calls into them.
    this._checkpointManager = new CheckpointManager(dataDir);
    this._baselineRegistry = new BaselineRegistry(this.db as never);
    this._autonomyGate = new AutonomyGate(dataDir);
    this._selfImprovementController = new SelfImprovementController();
    this._learningEngine = new LearningEngine(this.db as never);
    this._personalIntelligence = new PersonalIntelligence(this.db as never);
    this._intelligenceHardening = new IntelligenceHardening();
    this._adaptiveStatusService = new AdaptiveStatusService();
    // MemoryConsolidator and VectorIndexService both depend on subsystems
    // that aren't initialised here yet (CategorizedMemoryStore + a concrete
    // VectorIndexService implementation). They're left null and exposed via
    // optional getters; later phases will wire them when CategorizedMemoryStore
    // is integrated and the vector backend is chosen.

    // Lazy: turn-on via config.features.* — preserves zero-overhead default.
    const features = this.config.features;
    if (features?.buildLearning) {
      this._globalLearningService = new GlobalLearningService(this.db);
      this._buildIntelligenceService = new BuildIntelligenceService(this._globalLearningService);
    }
    if (features?.builderV2) {
      // Multi-agent supervisor takes optional ExecutionLimits, not the event bus.
      this._multiAgentSupervisor = new MultiAgentBuildSupervisor();
    }

    // ── Phase B-merge round 2: eager-init the safe-ctor subsystems ──────
    // Memory layer (categorized/episode/ingestion/consolidator/flow)
    this._episodeStore = new EpisodeStore(this.db as never);
    this._categorizedMemoryStore = new CategorizedMemoryStore(this.db);
    this._memoryIngestionEngine = new MemoryIngestionEngine(this._categorizedMemoryStore);
    this._memoryConsolidator = new MemoryConsolidator(this._categorizedMemoryStore);
    this._knowledgeFlowEngine = new KnowledgeFlowEngine(
      this.db as never,
      this._learningEngine,
      this._episodeStore,
    );
    // Wire knowledge flow into the consolidator so cross-session learning
    // signals reinforce memory ranking (silly-johnson behaviour).
    this._memoryConsolidator.setKnowledgeFlow(this._knowledgeFlowEngine);
    this._knowledgeAugmenter = new KnowledgeAugmenter();
    this._advisorOrchestrator = new AdvisorOrchestrator();
    this._buildSessionManager = new BuildSessionManager();
    this._interactionEvaluator = new InteractionEvaluator();

    // Automation/computer-control services — all default-deny / no-op until
    // explicitly enabled by config or runtime calls. Safe to eager-init.
    this._automationPolicyService = new RealAutomationPolicyService();
    this._automationRunStore = new RealAutomationRunStore();
    this._computerPermissionService = new RealComputerPermissionService();
    this._computerSettingsService = new RealComputerSettingsService();
    this._screenshotManager = new RealScreenshotManager(dataDir);
    this._automationEngine = new RealAutomationEngine(
      this._automationPolicyService,
      this._automationRunStore,
      this.toolRegistry,
      this.auditLogger,
    );

    // ── Email ingestion auto-start (opt-in via env) ────────────────────
    // Default OFF. Only starts the polling loop when explicitly enabled.
    // Polling cadence: AGENT_EMAIL_INGESTION_INTERVAL_MS, default 60s.
    if (process.env['AGENT_EMAIL_INGESTION_ENABLED'] === 'true') {
      try {
        const runner = this.getEmailRunner();
        const intervalMs = Number(process.env['AGENT_EMAIL_INGESTION_INTERVAL_MS'] ?? 60_000);
        if (runner) {
          runner.start(intervalMs);
          log.info({ intervalMs }, 'Email ingestion auto-started');
        }
      } catch (err) {
        log.warn({ err: String(err) }, 'Email ingestion auto-start failed (non-fatal)');
      }
    }

    log.info({
      checkpoint: !!this._checkpointManager,
      baseline: !!this._baselineRegistry,
      autonomy: !!this._autonomyGate,
      buildLearning: !!this._buildIntelligenceService,
      builderV2: !!this._multiAgentSupervisor,
      memory: !!this._categorizedMemoryStore,
      consolidator: !!this._memoryConsolidator,
      knowledgeFlow: !!this._knowledgeFlowEngine,
      automation: !!this._automationEngine,
    }, 'Phase B-merge subsystems initialized');
  }

  // Phase 4: observation-only orchestration. Pure side-effect on private fields.
  private _runIntelligenceObservation(input: string): void {
    if (!this._intelligenceEnabled || !this._decisionEngine || !this._intentClassifier || !this._domainClassifier || !this._knowledgeProbe) return;
    const redFlag = detectRedFlag(input);
    const detectedDomain = this._domainClassifier.classify(input);
    const queryIntent = this._intentClassifier.classify(input);
    const knowledge = this._knowledgeProbe.probe(input);
    const decisionInput: DecisionEngineInput = {
      query: input,
      knowledgeCtx: { ...knowledge, detectedDomain, queryIntent },
      advisorDecision: { detectedDomain, knowledgeConfidence: 'none', toolsRecommended: true },
      redFlagGate: { triggered: redFlag.isRedFlag, isHardGate: false },
    };
    const decision = this._decisionEngine.decide(decisionInput);
    this._lastDecisionSummary = DecisionEngine.summarize(decision, detectedDomain, decisionInput);
    this._lastExecutionTrace = DecisionEngine.buildExecutionTrace(decision, decisionInput);
    this._lastRedFlag = redFlag;
    this._lastForceReasoning = decision.forceReasoning;
  }

  // Phase 5: emit a model-capability hint only when influence is fully opted in
  private _resolveModelHint(): { capability: 'reasoning' } | null {
    if (!this._intelligenceEnabled) return null;
    if (this._intelligenceObservationOnly) return null;
    if (this._intelligenceInfluenceMode !== 'force-reasoning') return null;
    return this._lastForceReasoning ? { capability: 'reasoning' } : null;
  }

  getLastDecisionSummary(): DecisionSummary | null { return this._lastDecisionSummary; }
  getLastExecutionTrace(): ExecutionTrace | null { return this._lastExecutionTrace; }
  getLastRedFlag(): RedFlagResult | null { return this._lastRedFlag; }
  getLastForceReasoning(): boolean | null { return this._intelligenceEnabled ? this._lastForceReasoning : null; }

  // R2/R3/R10: Retrieval wiring with timeout + bounded metadata + stats logging.
  // Errors are logged but never propagate — chat must always continue.
  private async _buildRetrievalContext(input: string): Promise<string | null> {
    if (!this._retrievalEnabled || !this._retrievalService) return null;

    // Reset per-call observability so callers see a clean slate before this run.
    this._lastRetrievalMetadata = null;
    this._lastRetrievalIntent = null;
    this._lastRetrievalResults = [];
    this._lastRetrievalStats = null;
    this._lastRetrievalError = null;

    const start = Date.now();
    try {
      // R10: hard timeout — race against a timer so a stuck SQL call cannot
      // hang chat forever. On timeout we throw, the catch logs + falls through.
      const r = await Promise.race([
        this._retrievalService.retrieve(input),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () => reject(new Error('R10: retrieval timed out after ' + this._retrievalTimeoutMs + 'ms')),
            this._retrievalTimeoutMs,
          );
        }),
      ]);
      this._lastRetrievalIntent = r.intent;
      this._lastRetrievalResults = r.results;

      const reg = new DocumentRegistry(this.db);
      const documents: RetrievalMetadataDocument[] = [];
      let retrievalCount: number | undefined = undefined;

      if (r.intent === 'COUNT') {
        retrievalCount = r.results[0]?.score ?? 0;
      } else {
        // R9: extract bounded snippets around the matched phrase for each doc.
        const phrase = (r.intent === 'EXACT_SEARCH' || r.intent === 'FILTERED_SEARCH')
          ? this._retrievalService.extractExactSearchPhrase(input)
          : input;
        for (const res of r.results) {
          if (!res.document_id) continue;
          const doc = reg.get(res.document_id);
          if (!doc) continue;
          // Prefer a specific chunk if the result tagged one; else any chunk for the doc.
          const chunkRow = res.chunk_id
            ? this.db.prepare('SELECT content FROM document_chunks WHERE chunk_id = ? LIMIT 1').get(res.chunk_id) as { content: string } | undefined
            : this.db.prepare('SELECT content FROM document_chunks WHERE document_id = ? ORDER BY chunk_number ASC LIMIT 1').get(res.document_id) as { content: string } | undefined;
          const { snippet, matchedPhrase } = extractSnippet(chunkRow?.content, phrase);
          documents.push({
            document_id: doc.document_id,
            file_name: doc.file_name,
            title: doc.title,
            file_type: doc.file_type,
            sender: doc.sender,
            ...(snippet ? { snippet } : {}),
            ...(matchedPhrase ? { matchedPhrase } : {}),
          });
        }
      }

      // R4: source is now reported by RetrievalService itself (covers entity vs fts).
      const source: RetrievalMetadata['retrievalSource'] = r.source as RetrievalMetadata['retrievalSource'];

      // R10: cap metadata-exposed documents (UI/external payload). The full
      // result count remains accurate via retrievalMatchCount.
      const cappedDocs = documents.length > this._retrievalMaxMetadataDocs
        ? documents.slice(0, this._retrievalMaxMetadataDocs)
        : documents;

      this._lastRetrievalMetadata = {
        retrievalIntent: r.intent as RetrievalMetadata['retrievalIntent'],
        retrievalSource: source,
        retrievalMatchCount: r.intent === 'COUNT' ? (retrievalCount ?? 0) : r.results.length,
        retrievalDocuments: cappedDocs,
        ...(retrievalCount !== undefined ? { retrievalCount } : {}),
      };

      // R10: per-call stats for observability + perf logging
      const elapsedMs = Date.now() - start;
      this._lastRetrievalStats = {
        intent: String(r.intent),
        source: String(source),
        matchCount: this._lastRetrievalMetadata.retrievalMatchCount,
        elapsedMs,
      };
      log.info({ ...this._lastRetrievalStats, exposedDocs: cappedDocs.length }, 'retrieval');

      // Build the prompt-injection string
      if (r.intent === 'COUNT') {
        const filters = this._retrievalService.parseCountFilters(input);
        const filterDesc = Object.keys(filters).length > 0
          ? Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(', ')
          : 'all documents';
        return `\n\n--- Retrieved Facts (sql:documents) ---\nDOCUMENT COUNT (${filterDesc}): ${retrievalCount}\nThis count is authoritative — it was computed from SQL, not estimated.\n--- End Retrieved Facts ---`;
      }
      if (documents.length === 0) return null;
      const lines = documents.slice(0, 50).map(d =>
        `- [${d.document_id}] ${d.file_name}${d.title ? ` — ${d.title}` : ''}${d.sender ? ` (sender: ${d.sender})` : ''}`
      );
      const intentLabel = r.intent === 'EXACT_SEARCH' ? 'Exact-match Documents' :
                          r.intent === 'SEMANTIC' ? 'Semantically-relevant Documents' :
                          r.intent === 'FILTERED_SEARCH' ? 'Filtered Documents' : 'Documents';
      return `\n\n--- Retrieved Knowledge (${intentLabel}, ${r.results.length} matches) ---\n${lines.join('\n')}\n--- End Retrieved Knowledge ---`;
    } catch (error) {
      // R10: retrieval failure must NEVER crash chat. Log a safe warning
      // (no stack trace dump that might include user data), record the
      // error string for observability, return null so the LLM call
      // proceeds with the unmodified system prompt.
      const message = error instanceof Error ? error.message : String(error);
      this._lastRetrievalError = message;
      this._lastRetrievalMetadata = null;
      const elapsedMs = Date.now() - start;
      log.warn({ message, elapsedMs }, 'retrieval failed — continuing without injected context');
      return null;
    }
  }

  getLastRetrievalIntent(): QueryIntent | null { return this._lastRetrievalIntent; }
  getLastRetrievalResults(): RetrievalResult[] { return this._lastRetrievalResults; }
  getLastRetrievalMetadata(): RetrievalMetadata | null { return this._lastRetrievalMetadata; }
  /** R10: stats from the last retrieval invocation (null on disabled / error / timeout). */
  getLastRetrievalStats(): { intent: string; source: string; matchCount: number; elapsedMs: number } | null {
    return this._lastRetrievalStats;
  }
  /** R10: error message from the last retrieval failure (null on success / disabled). */
  getLastRetrievalError(): string | null { return this._lastRetrievalError; }

  /** R11: record a thumbs-up/down on a chat response. Validates payload — throws on bad input. */
  recordFeedback(payload: FeedbackPayload): FeedbackRecord {
    return this._feedbackStore.record(payload);
  }
  /** R11: list recent feedback records (newest first). */
  listFeedback(limit = 100): FeedbackRecord[] { return this._feedbackStore.list(limit); }
  /** R11: total feedback row count. */
  feedbackCount(): number { return this._feedbackStore.count(); }

  /**
   * R5: Ingest entity mentions for a document. Removes any pre-existing
   * mentions for the document first, then extracts + writes fresh ones.
   * Returns null when the entity-indexing feature flag is off.
   */
  ingestDocumentEntities(documentId: string, text: string): EntityIngestionResult | null {
    if (!this._entityIndexingEnabled || !this._entityIngestionService) return null;
    return this._entityIngestionService.ingestDocument(documentId, text);
  }

  /** R5: Whether entity indexing is enabled for this agent. */
  isEntityIndexingEnabled(): boolean { return this._entityIndexingEnabled; }

  // ─── Phase B-merge: silly-johnson getters (additive) ─────────────────────
  // Each getter returns either the eagerly-initialised instance or null when
  // the feature is opt-in and currently off. Web routes (lifted later) will
  // call these to expose subsystem status to the dashboard.

  getClaudeOAuthService(): ClaudeOAuthService | null { return this._claudeOAuthService; }
  getMCPClientManager(): MCPClientManager | null { return this._mcpClientManager; }
  getHooksEngine(): HooksEngine | null { return this._hooksEngine; }
  getCheckpointManager(): CheckpointManager { return this._checkpointManager; }
  getBaselineRegistry(): BaselineRegistry { return this._baselineRegistry; }
  getAutonomyGate(): AutonomyGate { return this._autonomyGate; }
  getSelfImprovementController(): SelfImprovementController { return this._selfImprovementController; }
  getLearningEngine(): LearningEngine { return this._learningEngine; }
  getPersonalIntelligence(): PersonalIntelligence { return this._personalIntelligence; }
  getIntelligenceHardening(): IntelligenceHardening { return this._intelligenceHardening; }
  getAdaptiveStatus(): AdaptiveStatusService { return this._adaptiveStatusService; }
  getMemoryConsolidator(): MemoryConsolidator { return this._memoryConsolidator!; }
  getVectorIndexService(): VectorIndexService | null { return this._vectorIndexService; }
  getEpisodeStore(): EpisodeStore { return this._episodeStore; }
  getCategorizedMemoryStore(): CategorizedMemoryStore { return this._categorizedMemoryStore; }
  getMemoryIngestionEngine(): MemoryIngestionEngine { return this._memoryIngestionEngine; }
  getKnowledgeFlowEngine(): KnowledgeFlowEngine { return this._knowledgeFlowEngine; }
  getKnowledgeAugmenter(): KnowledgeAugmenter { return this._knowledgeAugmenter; }
  getAdvisorOrchestrator(): AdvisorOrchestrator { return this._advisorOrchestrator; }
  getBuildSessionManager(): BuildSessionManager { return this._buildSessionManager; }
  getInteractionEvaluator(): InteractionEvaluator { return this._interactionEvaluator; }

  /** Automation / computer-control services (all default-deny). */
  getAutomationPolicyService(): RealAutomationPolicyService { return this._automationPolicyService; }
  getAutomationRunStore(): RealAutomationRunStore { return this._automationRunStore; }
  getAutomationEngine(): RealAutomationEngine { return this._automationEngine; }
  getComputerPermissionService(): RealComputerPermissionService { return this._computerPermissionService; }
  getComputerSettingsService(): RealComputerSettingsService { return this._computerSettingsService; }
  getScreenshotManager(): RealScreenshotManager { return this._screenshotManager; }

  /** Lazy email ingestion — first call constructs from default config.
   *  Returns null on instantiation failure (e.g. permission errors on data dir). */
  getEmailIngestionService(): EmailIngestionService | null {
    if (!this._emailIngestionService) {
      try {
        this._emailIngestionService = new EmailIngestionService();
      } catch (err) {
        log.warn({ err: String(err) }, 'EmailIngestionService init failed');
        return null;
      }
    }
    return this._emailIngestionService;
  }

  /**
   * Lazy email runner — the actual ingestion engine that pulls from a
   * (production: IMAP / tests: fixture) source and writes into the
   * documents table so emails appear in the Memory Control Center.
   * First call wires the runner against this agent's DB; the source can
   * be overridden for tests via setEmailRunnerSource.
   */
  getEmailRunner(): EmailRunner | null {
    if (this._emailRunner) return this._emailRunner;
    try {
      const svc = this.getEmailIngestionService();
      const allow = svc?.getAllowlist() ?? { senders: [], domains: [] };
      const cfg = svc?.getState().config ?? null;
      // Default source: real IMAP. Will fail at runtime without a Keychain
      // password — that's surfaced via lastError on the runner status, not
      // by throwing here, so the server stays alive.
      const source: EmailSource = cfg
        ? createImapSource({
            account: cfg.account,
            host: cfg.host,
            port: cfg.port,
            secure: cfg.secure,
          })
        : async () => [];
      this._emailRunner = new EmailRunner({
        db: this.db as never,
        source,
        allowedSenders: allow.senders,
        allowedDomains: allow.domains,
        onIngested: this._entityIndexingEnabled
          ? (id, text) => { this._entityIngestionService?.ingestDocument(id, text); }
          : undefined,
      });
      return this._emailRunner;
    } catch (err) {
      log.warn({ err: String(err) }, 'EmailRunner init failed');
      return null;
    }
  }

  /**
   * Override the email runner's source. Used by tests to inject a fixture
   * source without touching IMAP. Call before any runOnce/start.
   */
  setEmailRunner(runner: EmailRunner): void {
    if (this._emailRunner) this._emailRunner.stop();
    this._emailRunner = runner;
  }

  /** Lazy action-engine — first call constructs with this agent passed in. */
  getActionEngine(): ActionEngine {
    if (!this._actionEngine) {
      // ActionEngine defines its own structural AgentInterface — cast via never.
      this._actionEngine = new ActionEngine({}, this as never);
    }
    return this._actionEngine;
  }

  /** Singleton observability loggers — exposed for the Logs page. */
  getLLMInteractionLogger(): LLMInteractionLogger { return LLMInteractionLogger.getInstance(); }
  getSystemLogBuffer(): SystemLogBuffer { return SystemLogBuffer.getInstance(); }
  getGlobalLearningService(): GlobalLearningService | null { return this._globalLearningService; }
  getBuildIntelligenceService(): BuildIntelligenceService | null { return this._buildIntelligenceService; }
  getSelfImprovementService(): SelfImprovementService | null { return this._selfImprovementService; }
  getUserPersonalizationService(): UserPersonalizationService | null { return this._userPersonalizationService; }
  getAgentLoopEngine(): AgentLoopEngine | null { return this._agentLoopEngine; }
  getMultiAgentSupervisor(): MultiAgentBuildSupervisor | null { return this._multiAgentSupervisor; }
  getHybridOrchestrator(): HybridOrchestrator | null { return this._hybridOrchestrator; }
  getModelFabric(): ModelFabric | null { return this._modelFabric; }

  /** Direct access to the better-sqlite3 handle — used by routes that
   * read silly-johnson tables (build_memory, agent_loops, etc.). */
  getDatabase(): Database.Database { return this.db; }

  /**
   * Phase B-merge: feature flag introspection.
   * Reads config.features.<name> with sensible defaults — `webSearch` and
   * `toolCallEvaluator` default to true; everything else defaults to false.
   * The dashboard Settings page calls this to render toggle state.
   */
  isFeatureEnabled(
    name: 'builderV2' | 'buildLearning' | 'projectWorkflows' | 'toolCallEvaluator' | 'otelTracing' | 'otelContentTracing' | 'webSearch',
  ): boolean {
    const f = this.config.features;
    if (!f) return name === 'webSearch' || name === 'toolCallEvaluator';
    const explicit = f[name];
    if (typeof explicit === 'boolean') return explicit;
    return name === 'webSearch' || name === 'toolCallEvaluator';
  }

  /**
   * Phase B-merge: hot-update feature flags from the Settings page.
   * Mutates the in-memory config; persistence is the caller's responsibility.
   */
  updateFeatures(patch: Partial<NonNullable<AgentConfig['features']>>): void {
    if (!this.config.features) {
      this.config.features = { ...patch };
    } else {
      Object.assign(this.config.features, patch);
    }
    log.info({ patch }, 'Features updated');
  }

  /**
   * Phase B-merge: create an isolated subagent for delegated work.
   * Thin wrapper so web routes don't have to import the subagent module.
   */
  createSubagent(config: SubagentConfig): Subagent {
    // Dynamic import to avoid making subagent a hard dep of this module
    // when the agent-loop runtime isn't enabled.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createSubagent } = require('./agent-loop/subagent.js');
    return createSubagent(config) as Subagent;
  }

  /**
   * Phase B-merge: run an agent-loop goal end-to-end.
   * Returns the final loop state. When agent-loop isn't initialised this
   * throws — the dashboard should call getAgentLoopEngine() first to detect.
   */
  async runAgentLoop(description: string, sessionId?: string, constraints?: string[]): Promise<AgentLoopState> {
    if (!this._agentLoopEngine) {
      throw new Error('Agent-loop runtime is not enabled. Set config.features.builderV2 (or wire AgentLoopEngine in a future phase).');
    }
    const goal = {
      description,
      constraints: constraints ?? [],
      sessionId: sessionId ?? 'default',
    };
    return this._agentLoopEngine.runLoop(goal as never) as unknown as AgentLoopState;
  }

  /**
   * Phase B-merge: cancel all in-flight execution.
   * Aborts every per-session AbortController and stops the agent-loop engine
   * if running. Returns counts for the dashboard's "Stop all" button.
   */
  stopAllExecution(): { plansCancelled: number; sessionsAborted: number } {
    let sessionsAborted = 0;
    for (const [, controller] of this.sessionAbortControllers) {
      controller.abort();
      sessionsAborted++;
    }
    this.sessionAbortControllers.clear();
    let plansCancelled = 0;
    if (this._agentLoopEngine) {
      const stopFn = (this._agentLoopEngine as unknown as { stopAll?: () => number }).stopAll;
      if (typeof stopFn === 'function') plansCancelled = stopFn.call(this._agentLoopEngine) ?? 0;
    }
    log.info({ plansCancelled, sessionsAborted }, 'stopAllExecution called');
    return { plansCancelled, sessionsAborted };
  }

  /**
   * Phase B-merge: snapshot current execution state for the dashboard
   * (Active sessions, agent-loop status). Cheap to call.
   */
  getExecutionStatus(): { activeSessions: number; agentLoopActive: boolean } {
    return {
      activeSessions: this.sessionAbortControllers.size,
      agentLoopActive: this._agentLoopEngine !== null,
    };
  }

  /**
   * Phase B-merge: experience store for the agent-loop learning subsystem.
   * Lazy-instantiated — first call wires it on top of this.db.
   */
  private _loopExperienceStore: LoopExperienceStore | null = null;
  getLoopExperienceStore(): LoopExperienceStore {
    if (!this._loopExperienceStore) {
      this._loopExperienceStore = new LoopExperienceStore(this.db);
    }
    return this._loopExperienceStore;
  }

  private registerBuiltinTools(): void {
    for (const tool of getBuiltinTools()) {
      this.toolRegistry.register(tool);
    }
  }

  // ─── Resilient LLM call ─────────────────────────────────────────────────

  private async completeWithResilience(options: {
    messages: Message[];
    systemPrompt?: string;
    tools?: import('./types.js').ToolDefinition[];
    capability?: 'reasoning';
  }): Promise<LLMResponse> {
    // Estimate tokens for rate limiting
    const estimatedTokens = this.contextManager.estimateTokenCount(options.messages);

    // Acquire rate limit slot
    await this.rateLimiter.acquire(estimatedTokens);

    // Execute through circuit breaker + retry
    const response = await this.llmCircuitBreaker.execute(() =>
      retryWithBackoff(
        () => this.provider.complete(options),
        {
          maxRetries: 3,
          baseDelayMs: 1000,
          maxDelayMs: 30_000,
        },
      ),
    );

    // Record actual token usage for accurate rate limiting
    if (response.usage) {
      this.rateLimiter.recordTokenUsage(
        response.usage.inputTokens + response.usage.outputTokens,
      );
    }

    return response;
  }

  // ─── Stats collection ─────────────────────────────────────────────────

  private collectStats(): HealthStats {
    const mem = process.memoryUsage();
    return {
      activeSessions: this.sessionManager.listActive().length,
      messagesProcessed: this.messagesProcessed,
      lastActivity: this.lastActivityTime,
      memoryUsage: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
        heapTotalMB: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
        rssMB: Math.round(mem.rss / 1024 / 1024 * 100) / 100,
      },
      providers: {
        [this.config.agent.defaultProvider]: this.provider.isConfigured() ? 'connected' : 'disconnected',
      },
      circuitBreakers: {
        llm: this.llmCircuitBreaker.getState(),
      },
      rateLimiter: this.rateLimiter.getStats(),
    };
  }

  // ─── Security accessors ──────────────────────────────────────────────────

  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }

  getCredentialManager(): CredentialManager {
    return this.credentialManager;
  }

  getLocalAuth(): LocalAuth {
    return this.localAuth;
  }

  getDataManager(): DataManager {
    return this.dataManager;
  }

  getPermissionManager(): PermissionManager {
    return this.permissionManager;
  }

  getEncryption(): DataEncryption {
    return this.encryption;
  }

  // ─── Core accessors ──────────────────────────────────────────────────────

  setSystemPrompt(prompt: string): void {
    this.systemPrompt = prompt;
  }

  setProvider(providerName: 'anthropic' | 'openai' | 'ollama'): void {
    this.provider = createProvider(providerName, this.config);
    this.contextManager.setProviderLimit(providerName);
    this.rateLimiter = new RateLimiter(providerName);
    log.info({ provider: providerName }, 'Switched LLM provider');
  }

  getToolRegistry(): ToolRegistry {
    return this.toolRegistry;
  }

  getSessionManager(): SessionManager {
    return this.sessionManager;
  }

  getLongTermMemory(): LongTermMemoryStore {
    return this.longTermMemory;
  }

  getConfig(): AgentConfig {
    return this.config;
  }

  getSession(sessionId: string): Session | undefined {
    return this.sessionManager.get(sessionId);
  }

  getHeartbeatManager(): HeartbeatManager {
    return this.heartbeatManager;
  }

  getUserManager(): UserManager {
    return this.userManager;
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  getHealthServer(): HealthServer {
    return this.healthServer;
  }

  getRateLimiter(): RateLimiter {
    return this.rateLimiter;
  }

  getCircuitBreaker(): CircuitBreaker {
    return this.llmCircuitBreaker;
  }

  getSendPolicyManager(): SendPolicyManager {
    return this.sendPolicyManager;
  }

  getSessionPruner(): SessionPruner {
    return this.sessionPruner;
  }

  getCompactionManager(): CompactionManager {
    return this.compactionManager;
  }

  getSessionStore(): SessionStore | null {
    return this.sessionManager.getSessionStore();
  }

  setShellConfirmCallback(cb: (command: string) => Promise<boolean>): void {
    this.shellConfirmCallback = cb;
  }

  getShellConfirmCallback(): ((command: string) => Promise<boolean>) | null {
    return this.shellConfirmCallback;
  }

  // ─── Chat ────────────────────────────────────────────────────────────────

  async chat(input: string, sessionId?: string, context?: InboundContext): Promise<string> {
    // Check auth
    if (!this.localAuth.isUnlocked()) {
      return '[Locked] Agent is locked. Please authenticate first.';
    }
    this.localAuth.touch();

    // Resolve session: use context-driven resolution if available, else legacy
    let session: Session;
    let sessionKey: string | null = null;

    if (context) {
      const resolved = this.sessionManager.resolveSession(context);
      session = resolved.session;
      sessionKey = resolved.sessionKey;
    } else {
      session = this.sessionManager.getOrCreate(sessionId);
      sessionKey = this.sessionManager.getSessionKeyForId(session.id);
    }

    // Handle slash commands
    const cmdContext: CommandContext = {
      sessionId: session.id,
      sessionKey: sessionKey ?? session.id,
      sessionEntry: this.sessionManager.getSessionStore()?.get(sessionKey ?? '') ?? null,
      messages: this.conversationMemory.getMessages(session.id),
      config: this.config,
      contextTokens: 0,
      maxContextTokens: this.contextManager.getConfig().maxContextTokens,
    };
    cmdContext.contextTokens = this.contextManager.estimateTokenCount(cmdContext.messages);

    const cmdResult = parseCommand(input, cmdContext);
    if (cmdResult?.handled) {
      // Handle session reset
      if (cmdResult.shouldReset && sessionKey) {
        this.sessionManager.resetSession(sessionKey);
        this.contextManager.invalidateSummary(session.id);
        this.conversationMemory.clearMessages(session.id);

        // If there's a new model, switch provider
        if (cmdResult.newModel) {
          // Best-effort model switch (just log it, actual switch depends on provider)
          log.info({ model: cmdResult.newModel }, 'Model switch requested');
        }

        // If there's remaining text after reset, process it as a new message
        if (cmdResult.remainder) {
          return this.chat(cmdResult.remainder, undefined, context);
        }
      }

      // Handle compaction
      if (cmdResult.shouldCompact) {
        const allMsgs = this.conversationMemory.getMessages(session.id);
        const maxTokens = this.contextManager.getConfig().maxContextTokens;
        const result = await this.compactionManager.manualCompact(
          session.id, allMsgs, maxTokens, cmdResult.compactInstructions,
        );
        if (result.compacted) {
          return cmdResult.response ?? 'Session compacted.';
        }
        return 'Nothing to compact.';
      }

      // Handle send policy
      if (cmdResult.command === 'send' && sessionKey) {
        this.sendPolicyManager.handleOverrideCommand(sessionKey, input);
      }

      // Handle /stop — abort any in-progress run for this session
      if (cmdResult.shouldStop) {
        const controller = this.sessionAbortControllers.get(session.id);
        if (controller) {
          controller.abort();
          this.sessionAbortControllers.delete(session.id);
        }
      }

      return cmdResult.response ?? 'Command handled.';
    }

    // Set up abort controller for this run
    const abortController = new AbortController();
    this.sessionAbortControllers.set(session.id, abortController);

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };

    this.conversationMemory.addMessage(session.id, userMessage);
    this.emit('message', userMessage, session.id);

    this.auditLogger.log({
      action: 'message_received',
      sessionId: session.id,
      platform: session.platform,
      details: `User message (${input.length} chars)`,
      success: true,
    });

    // Get all messages, prune old tool results, then truncate via context manager
    let allMessages = this.conversationMemory.getMessages(session.id);

    // Prune old tool results if enabled
    if (this.config.sessions.pruning?.enabled) {
      allMessages = this.sessionPruner.pruneToolResults(allMessages, {
        maxAge: this.config.sessions.pruning.maxToolResultAge,
        keepLastN: this.config.sessions.pruning.keepLastNToolResults,
      });
    }

    // Auto-compaction if enabled
    if (this.config.sessions.compaction?.enabled) {
      const maxTokens = this.contextManager.getConfig().maxContextTokens;
      const compactResult = await this.compactionManager.checkAndCompact(session.id, allMessages, maxTokens);
      if (compactResult.compacted) {
        allMessages = compactResult.messages;
      }
    }

    const contextResult = await this.contextManager.prepareContext(session.id, allMessages);
    const messages = contextResult.messages;

    if (contextResult.wasTruncated) {
      log.info({
        sessionId: session.id,
        totalMessages: allMessages.length,
        sentMessages: messages.length,
        tokens: contextResult.totalTokens,
        summarized: contextResult.summaryAdded,
      }, 'Context truncated for LLM');
    }

    const toolDefs = this.toolRegistry.getDefinitions();

    this._runIntelligenceObservation(input);

    const retrievalContext = await this._buildRetrievalContext(input);
    const augmentedSystemPrompt = retrievalContext ? this.systemPrompt + retrievalContext : this.systemPrompt;

    let response: LLMResponse;
    try {
      response = await this.completeWithResilience({
        messages,
        systemPrompt: augmentedSystemPrompt,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
        ...(this._resolveModelHint() ?? {}),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.emit('error', err);
      this.auditLogger.log({
        action: 'message_sent',
        sessionId: session.id,
        details: `LLM error: ${err.message}`,
        success: false,
      });
      throw err;
    }

    this.emit('response', response, session.id);

    // Handle tool calls in a loop
    let finalResponse = response;
    let iterations = 0;
    const maxIterations = 10;

    while (finalResponse.toolCalls && finalResponse.toolCalls.length > 0 && iterations < maxIterations) {
      // Check if this run was aborted via /stop
      if (abortController.signal.aborted) {
        log.info({ sessionId: session.id }, 'Run aborted by /stop');
        this.sessionAbortControllers.delete(session.id);
        return '[Stopped] Run aborted.';
      }

      iterations++;

      const assistantMsg: Message = {
        role: 'assistant',
        content: finalResponse.content,
        toolCalls: finalResponse.toolCalls,
        timestamp: Date.now(),
      };
      this.conversationMemory.addMessage(session.id, assistantMsg);

      for (const toolCall of finalResponse.toolCalls) {
        this.emit('toolCall', toolCall, session.id);

        this.auditLogger.log({
          action: 'tool_call',
          sessionId: session.id,
          platform: session.platform,
          details: `Tool: ${toolCall.name}, args: ${JSON.stringify(toolCall.arguments)}`,
          success: true,
        });

        let result: string;
        try {
          result = await this.executeToolCall(toolCall, session.id);
        } catch (error) {
          result = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }

        const toolResult: ToolResult = {
          toolCallId: toolCall.id,
          content: result,
        };
        this.emit('toolResult', toolResult, session.id);

        this.auditLogger.log({
          action: 'tool_result',
          sessionId: session.id,
          platform: session.platform,
          details: `Tool: ${toolCall.name}, result (${result.length} chars)`,
          success: !result.startsWith('Error:') && !result.startsWith('[Blocked]'),
        });

        await this.handleMemoryToolResult(toolCall, result);

        const toolMsg: Message = {
          role: 'tool',
          content: result,
          toolCallId: toolCall.id,
          timestamp: Date.now(),
        };
        this.conversationMemory.addMessage(session.id, toolMsg);
      }

      // Re-fetch and truncate context for the follow-up call
      const updatedAll = this.conversationMemory.getMessages(session.id);
      const updatedContext = await this.contextManager.prepareContext(session.id, updatedAll);

      try {
        finalResponse = await this.completeWithResilience({
          messages: updatedContext.messages,
          systemPrompt: this.systemPrompt,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
        });
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        this.emit('error', err);
        throw err;
      }
    }

    const finalMsg: Message = {
      role: 'assistant',
      content: finalResponse.content,
      timestamp: Date.now(),
    };
    this.conversationMemory.addMessage(session.id, finalMsg);
    this.sessionManager.update(session.id, this.conversationMemory.getMessages(session.id));

    this.messagesProcessed++;
    this.lastActivityTime = Date.now();

    // Record to transcript if available
    const transcript = this.sessionManager.getTranscriptManager();
    if (transcript) {
      await transcript.append(session.id, {
        timestamp: new Date(userMessage.timestamp).toISOString(),
        role: 'user',
        content: input,
      });
      await transcript.append(session.id, {
        timestamp: new Date().toISOString(),
        role: 'assistant',
        content: finalResponse.content,
        metadata: {
          tokens: finalResponse.usage
            ? finalResponse.usage.inputTokens + finalResponse.usage.outputTokens
            : undefined,
        },
      });
    }

    // Update token tracking in session store
    if (sessionKey && finalResponse.usage) {
      const store = this.sessionManager.getSessionStore();
      if (store) {
        store.updateTokens(
          sessionKey,
          finalResponse.usage.inputTokens,
          finalResponse.usage.outputTokens,
          contextResult.totalTokens,
        );
      }
    }

    // Clean up abort controller
    this.sessionAbortControllers.delete(session.id);

    this.auditLogger.log({
      action: 'message_sent',
      sessionId: session.id,
      platform: session.platform,
      details: `Response (${finalResponse.content.length} chars)`,
      success: true,
    });

    return finalResponse.content;
  }

  /**
   * Streaming chat — sends tokens to the callback as they arrive.
   * Only streams the initial LLM response; tool call loops use non-streaming.
   */
  async chatStream(input: string, callbacks: StreamCallbacks, sessionId?: string): Promise<string> {
    if (!this.localAuth.isUnlocked()) {
      return '[Locked] Agent is locked. Please authenticate first.';
    }
    this.localAuth.touch();

    const session = this.sessionManager.getOrCreate(sessionId);

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };
    this.conversationMemory.addMessage(session.id, userMessage);

    let allMessages = this.conversationMemory.getMessages(session.id);
    const contextResult = await this.contextManager.prepareContext(session.id, allMessages);
    const messages = contextResult.messages;
    const toolDefs = this.toolRegistry.getDefinitions();

    this._runIntelligenceObservation(input);

    const retrievalContextStream = await this._buildRetrievalContext(input);
    const augmentedSystemPromptStream = retrievalContextStream ? this.systemPrompt + retrievalContextStream : this.systemPrompt;
    // R3: emit retrieval event BEFORE any model token streaming begins.
    if (this._lastRetrievalMetadata && callbacks.onRetrieval) {
      callbacks.onRetrieval(this._lastRetrievalMetadata);
    }

    // First response: stream it
    let response: LLMResponse;
    try {
      response = await this.provider.completeStream(
        {
          messages,
          systemPrompt: augmentedSystemPromptStream,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          ...(this._resolveModelHint() ?? {}),
        },
        callbacks,
      );
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (callbacks.onError) callbacks.onError(err);
      throw err;
    }

    // Handle tool call loops (non-streaming for simplicity)
    let finalResponse = response;
    let iterations = 0;
    const maxIterations = 10;

    while (finalResponse.toolCalls && finalResponse.toolCalls.length > 0 && iterations < maxIterations) {
      iterations++;

      const assistantMsg: Message = {
        role: 'assistant',
        content: finalResponse.content,
        toolCalls: finalResponse.toolCalls,
        timestamp: Date.now(),
      };
      this.conversationMemory.addMessage(session.id, assistantMsg);

      for (const toolCall of finalResponse.toolCalls) {
        let result: string;
        try {
          result = await this.executeToolCall(toolCall, session.id);
        } catch (error) {
          result = `Error: ${error instanceof Error ? error.message : String(error)}`;
        }

        const toolMsg: Message = {
          role: 'tool',
          content: result,
          toolCallId: toolCall.id,
          timestamp: Date.now(),
        };
        this.conversationMemory.addMessage(session.id, toolMsg);
      }

      const updatedAll = this.conversationMemory.getMessages(session.id);
      const updatedContext = await this.contextManager.prepareContext(session.id, updatedAll);

      // Stream follow-up responses too
      try {
        finalResponse = await this.provider.completeStream(
          {
            messages: updatedContext.messages,
            systemPrompt: this.systemPrompt,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
          },
          callbacks,
        );
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (callbacks.onError) callbacks.onError(err);
        throw err;
      }
    }

    const finalMsg: Message = {
      role: 'assistant',
      content: finalResponse.content,
      timestamp: Date.now(),
    };
    this.conversationMemory.addMessage(session.id, finalMsg);
    this.sessionManager.update(session.id, this.conversationMemory.getMessages(session.id));
    this.messagesProcessed++;
    this.lastActivityTime = Date.now();

    return finalResponse.content;
  }

  private async executeToolCall(toolCall: ToolCall, sessionId: string): Promise<string> {
    return this.toolRegistry.execute(toolCall.name, toolCall.arguments, {
      sessionId,
      agent: this,
    });
  }

  private async handleMemoryToolResult(toolCall: ToolCall, result: string): Promise<void> {
    if (toolCall.name === 'memory_store') {
      try {
        const data = JSON.parse(result) as { content: string; tags: string[] };
        this.longTermMemory.store(data.content, data.tags);
      } catch {
        // Not a memory store result
      }
    } else if (toolCall.name === 'memory_search') {
      try {
        const data = JSON.parse(result) as { query: string; tags: string[] };
        data.tags.length > 0
          ? this.longTermMemory.searchByTags(data.tags)
          : this.longTermMemory.searchByContent(data.query);
      } catch {
        // Not a memory search result
      }
    }
  }

  async summarizeSession(sessionId: string): Promise<string> {
    const messages = this.conversationMemory.getMessages(sessionId);
    if (messages.length === 0) return '';

    const conversationText = messages
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n');

    const response = await this.completeWithResilience({
      messages: [
        {
          role: 'user',
          content: `Summarize this conversation concisely:\n\n${conversationText}`,
          timestamp: Date.now(),
        },
      ],
      systemPrompt: 'You are a summarization assistant. Provide concise, factual summaries.',
    });

    return response.content;
  }

  async shutdown(): Promise<void> {
    log.info('Shutting down agent');
    this.heartbeatManager.stop();
    await this.healthServer.stop();
    this.rateLimiter.reset();
    this.auditLogger.purgeOld();
    this.db.close();
  }
}
