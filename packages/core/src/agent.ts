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
import { ContinuousContextStore } from './memory/continuous-context.js';
import { PlaybookStore } from './memory/playbook-store.js';
import { ToolForge, buildForgeDraftTool, buildForgeListTool } from './tools/tool-forge.js';
import { buildOllamaEmbedder } from './llm/ollama-embedder.js';
import { extractSnippet } from './retrieval/snippet-extractor.js';
import {
  assessRetrievalSufficiency,
  type RetrievalSufficiencyDecision,
} from './reasoning/retrieval-sufficiency.js';
import {
  DecisionTraceBuffer,
  type PrivateMemoryEvent,
} from './observability/private-memory-events.js';
import { TOOL_PERMISSION_MAP } from './tools/registry.js';
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
// Tier 3 Builder Batch 2: lazy-init queue + idle manager. Both are
// self-contained utility classes — no constructor wiring needed.
import { BuildQueueManager } from './build-queue.js';
import { IdleManager } from './idle-manager.js';
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
import { ModelRoutingHistory } from './observability/model-routing-history.js';
import { ToolOutcomeStore } from './observability/tool-outcome-store.js';
import { HealthMonitor } from './observability/health-monitor.js';
import { RuntimeSettingsStore } from './observability/runtime-settings-store.js';
import { RetrievalOutcomeStore } from './observability/retrieval-outcome-store.js';
import { classifyTask, type TaskClassification } from './observability/task-classifier.js';
import { decideRoute, DEFAULT_TASK_MODEL_MAP, type RoutingDecision } from './observability/model-routing-engine.js';
import { SCENARIOS as _VALIDATION_SCENARIOS } from './observability/validation-scenarios.js';
import { TelemetryStore } from './observability/telemetry-store.js';
import { WorkflowRunStore } from './observability/workflow-run-store.js';
import { ProviderBenchmarkStore } from './observability/provider-benchmark-store.js';
import { OmlxProvider } from './llm/omlx.js';
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
Always explain what you're doing and why.

CRITICAL — App generation output location:
When the user asks you to BUILD, GENERATE, or SCAFFOLD an app, website, or
multi-file project via the shell tool, you MUST write every file under a
unique workspace directory:
  /Users/darrenjones/Projects/AGENTX_APPS/build-<timestamp>-<slug>/
Always start by running:
  mkdir -p /Users/darrenjones/Projects/AGENTX_APPS/build-<timestamp>-<slug>
…choosing a short kebab-case slug describing the app and the current
unix timestamp in milliseconds. Then put every subsequent shell command
INSIDE that directory (use the workingDir argument of the shell tool OR
absolute paths). NEVER write app files into the AgentX project root or
the user's home directory directly. NEVER mix files for different apps.

CRITICAL — Editing existing files (preserve content):
When you modify an EXISTING file that the user already has, NEVER use
\`echo "..." > file\` to overwrite the whole file unless you are emitting
the COMPLETE updated content including every previously-existing function,
event handler, import, and behaviour. A file rewrite that drops existing
functionality (e.g. re-emitting only the data array and forgetting the
render function) is a failure. Prefer:
  - Surgical edits with \`sed -i '' 's/OLD/NEW/g' file\` for small changes
  - \`cat file\` first to read existing content, then emit the FULL merged
    content in one \`echo > file\` (or use a heredoc) — keep every existing
    function, event handler, import, helper, and behaviour intact
  - Append-only edits with \`echo "..." >> file\` for additions
When generating HTML pages that load JS via <script src=...>, verify that
the corresponding JS file defines the functions referenced in inline
event handlers, window.onload, and \`document.querySelector(...).onclick\`
sites. If you produce a page that calls \`displayX()\` but the JS file
contains only a data array, the page will not work.

CRITICAL — Use the write_file tool for ALL file content:
For ANY file that contains HTML, CSS, JS, JSON, Markdown, or any text
longer than a single short line, ALWAYS use the \`write_file\` tool
(args: {path, content}) instead of \`echo > file\` from the shell. The
write_file tool takes raw UTF-8 content — no shell escaping required.
Use the shell tool ONLY for: mkdir, ls, wc, cat, sed, mv, cp, grep,
chmod, and verifying file sizes. Pattern when scaffolding an app:
  Call 1 — shell: mkdir -p /Users/darrenjones/Projects/AGENTX_APPS/build-<ts>-<slug>
  Call 2 — write_file: {path:"/Users/.../index.html", content:"<!doctype html>..."}
  Call 3 — write_file: {path:"/Users/.../style.css", content:"body{...}"}
  Call 4 — write_file: {path:"/Users/.../script.js", content:"const profiles=[...]"}
  Call 5 — shell: wc -c /Users/.../index.html /Users/.../style.css /Users/.../script.js
Each write_file call returns the byte count — verify it is non-zero.

LEGACY — If you must write content via the shell tool:
The AgentX shell sandbox does NOT provide interactive stdin. NEVER use
\`cat > file\` or \`cat << EOF\` / heredocs — those commands will hang
waiting for stdin and produce a 0-byte file. ALWAYS write file content
using one of:
  - \`echo '<full content>' > file\` (single quotes, one command line,
    use \\n for newlines or \`printf\` if multiline is needed)
  - \`printf '%s' '<full content>' > file\`
  - For HTML/JS/CSS containing single quotes: use \`echo "..."\` with
    double quotes and escape any \\$ and \\\` characters.
After writing any file, ALWAYS verify it is non-empty with
\`wc -c filename\` before moving to the next file. A 0-byte file means
the write failed and you must rewrite it.

NEVER emit a \`printf\` or \`echo\` without explicit \`> filename\`
redirection at the end of the same shell command — output to stdout
creates NO file.

CRITICAL — One file per shell call (for build/generate workflows):
Issue ONE shell tool call per file. Do NOT chain
\`mkdir && echo ... > a.html && echo ... > b.css\` in a single command:
shell argument size and quote-escaping fail for non-trivial HTML/JS.
Pattern when scaffolding an app under AGENTX_APPS:
  Call 1 — shell: mkdir -p /Users/darrenjones/Projects/AGENTX_APPS/build-<ts>-<slug>
  Call 2 — shell: echo '<full index.html>' > /absolute/.../index.html
  Call 3 — shell: wc -c /absolute/.../index.html
  Call 4 — shell: echo '<full style.css>' > /absolute/.../style.css
  Call 5 — shell: wc -c /absolute/.../style.css
  Call 6 — shell: echo '<full script.js>' > /absolute/.../script.js
  Call 7 — shell: wc -c /absolute/.../script.js
Always use absolute paths in every command so the working directory
doesn't matter.`;

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
  /** P12-2 — Continuous-context durability layer (archive + bridge + journal). */
  private _continuousContext: ContinuousContextStore | null = null;
  /** P12-3 — Playbooks: success memory (proven approaches per task type). */
  private _playbooks: PlaybookStore | null = null;
  /** P12-4 — Tool Forge: draft / approve / run sandboxed custom tools. */
  private _toolForge: ToolForge | null = null;
  /** P13-A3 — oMLX provider (Apple-Silicon MLX, OpenAI-compatible, localhost-only). */
  private _omlxProvider: OmlxProvider | null = null;
  /** Cached oMLX reachability (probed with a TTL so routing stays cheap). */
  private _omlxAvailable = false;
  private _omlxLastProbe = 0;
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

  // Batch A2 — Private-memory-first enforcement state.
  private _localOnly = false;
  /** Cached list of installed local model names. Populated by the
   *  HealthMonitor's LLM Provider probe on each cycle so routing can
   *  consult an up-to-date list without re-pinging Ollama every chat. */
  private _installedLocalModelCache: string[] | null = null;
  private _lastSufficiencyDecision: RetrievalSufficiencyDecision | null = null;
  private _decisionTrace = new DecisionTraceBuffer();

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

    // Batch A2 — Private-memory-first / localOnly state.
    this._localOnly = this.config.agent.localOnly === true;

    // ── P12-2: Continuous Context — durability layer ─────────────────
    // Archive summarised-out turns (never lose the thread), bridge new
    // sessions with the previous session's recap, and keep a structured
    // decision journal. Best-effort by design: any failure here logs
    // and chat continues unaffected.
    try {
      this._continuousContext = new ContinuousContextStore(this.db);
      this.contextManager.setArchiveSink((sessionId, olderMessages, summary, batchId) => {
        const res = this._continuousContext!.archiveCompactedTurns(sessionId, olderMessages, summary, batchId);
        if (res.archived > 0) {
          this._continuousContext!.recordDecision(
            'compaction',
            `Compacted ${olderMessages.length} turns out of the window (archived + indexed)`,
            { batchId, archived: res.archived },
            sessionId,
          );
        }
      });
      log.info('P12-2: ContinuousContextStore wired (archive + bridge + journal)');
    } catch (ccErr) {
      log.warn(
        { err: ccErr instanceof Error ? ccErr.message : String(ccErr) },
        'P12-2: ContinuousContextStore init failed — durability layer disabled',
      );
    }

    // ── P12-3: Playbooks — success memory ────────────────────────────
    // Records what worked per (task type, query signature); recalls the
    // proven approach on similar future requests. Best-effort.
    try {
      this._playbooks = new PlaybookStore(this.db);
      log.info('P12-3: PlaybookStore wired (success memory)');
    } catch (pbErr) {
      log.warn(
        { err: pbErr instanceof Error ? pbErr.message : String(pbErr) },
        'P12-3: PlaybookStore init failed — success memory disabled',
      );
    }

    // ── P13-A3: oMLX provider — real end-to-end wiring ────────────────
    // Constructed whenever an endpoint is configured (default
    // localhost:8080). The constructor enforces localhost-only. A TTL
    // probe (see _probeOmlx) gates routing: 'omlx' only enters
    // availableProviders while /v1/models answers with ≥1 model, so a
    // stopped MLX server can never strand a request. Execution falls
    // back to Ollama on ANY oMLX error.
    try {
      const omlxEndpoint = process.env['AGENTX_OMLX_ENDPOINT'] ?? 'http://localhost:8080';
      this._omlxProvider = new OmlxProvider({
        endpoint: omlxEndpoint,
        model: process.env['AGENTX_OMLX_MODEL'] ?? 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
      });
      log.info({ endpoint: omlxEndpoint }, 'P13-A3: oMLX provider constructed (availability probed lazily)');
    } catch (omlxErr) {
      log.warn(
        { err: omlxErr instanceof Error ? omlxErr.message : String(omlxErr) },
        'P13-A3: oMLX provider construction failed — Ollama-only',
      );
    }

    // ── P13-B1: Semantic memory — embedder for playbooks + archive ───
    // nomic-embed-text via the local Ollama endpoint. Fail-open: when
    // Ollama or the model is unavailable, both stores silently fall
    // back to keyword matching.
    try {
      const ollamaBase =
        (this.config.providers as Record<string, { baseUrl?: string } | undefined>)['ollama']?.baseUrl ??
        'http://localhost:11434';
      const embedder = buildOllamaEmbedder({ baseUrl: ollamaBase });
      this._playbooks?.setEmbedder(embedder);
      this._continuousContext?.setEmbedder(embedder);
      log.info({ ollamaBase }, 'P13-B1: semantic embedder wired into playbooks + archive');
    } catch (embErr) {
      log.warn(
        { err: embErr instanceof Error ? embErr.message : String(embErr) },
        'P13-B1: embedder wiring failed — keyword matching only',
      );
    }

    // ── P12-4: Tool Forge — draft / approve / run custom tools ───────
    // The model can DRAFT pure-compute utility tools mid-conversation
    // (stored pending); only a human approval makes them executable.
    // Approved tools re-register at every boot. Sandboxed via node:vm
    // with an empty context + static deny-list + 1s timeout +
    // auto-disable after 3 consecutive failures.
    try {
      this._toolForge = new ToolForge(this.db, this.toolRegistry);
      const loaded = this._toolForge.loadApprovedTools();
      this.toolRegistry.register(buildForgeDraftTool(this._toolForge));
      this.toolRegistry.register(buildForgeListTool(this._toolForge));
      log.info({ approvedLoaded: loaded }, 'P12-4: ToolForge wired (forge_tool + list_custom_tools registered)');
    } catch (tfErr) {
      log.warn(
        { err: tfErr instanceof Error ? tfErr.message : String(tfErr) },
        'P12-4: ToolForge init failed — custom tools disabled',
      );
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

    // Batch 6A — workflow durability: any workflow left in a non-terminal
    // state from a prior process is marked interrupted_by_restart and
    // gets a recovery event in the timeline so the operator can see it.
    try {
      const recoveredCount = WorkflowRunStore.get(this.db).recoverIncomplete();
      if (recoveredCount > 0) {
        log.info({ count: recoveredCount }, 'Workflow durability: recovered interrupted runs after restart');
      }
    } catch (e) {
      log.warn({ error: e instanceof Error ? e.message : String(e) }, 'Workflow recoverIncomplete failed (non-fatal)');
    }

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

    // Self-Healing: register real probes and start the monitor. Each probe is
    // a read-only check; the (optional) repair() function is the safest
    // possible idempotent action — never destructive. Disable with
    // AGENTX_DISABLE_HEALTH_MONITOR=true for tests.
    this._initHealthMonitor();
  }

  private _initHealthMonitor(): void {
    if (process.env['AGENTX_DISABLE_HEALTH_MONITOR'] === 'true') return;
    const monitor = HealthMonitor.getInstance();
    // Batch 3 — repair policy is read live from RuntimeSettingsStore on
    // every failure so toggling the dashboard setting takes effect for
    // the very next cycle.
    monitor.setPolicyResolver(() => RuntimeSettingsStore.getInstance().getKey('repairPolicy'));
    const provider = this.provider;
    const config = this.config;

    // 1) LLM Provider liveness — for ollama, ping the local /api/tags
    //    endpoint. For other providers, just verify the instance exists.
    monitor.registerProbe({
      name: 'LLM Provider',
      run: async () => {
        try {
          if (!provider) return { status: 'failed', detail: 'provider not initialized' };
          if (config.agent.defaultProvider === 'ollama') {
            const host = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';
            const ctrl = new AbortController();
            const t = setTimeout(() => ctrl.abort(), 3000);
            try {
              const r = await fetch(`${host}/api/tags`, { signal: ctrl.signal });
              if (!r.ok) return { status: 'failed', detail: `ollama ${host} returned ${r.status}` };
              const data = await r.json() as { models?: Array<{ name?: string }> };
              const list = Array.isArray(data.models) ? data.models : [];
              // Cache installed model names for ModelRoutingEngine.
              this._installedLocalModelCache = list.map((m) => m?.name).filter((n): n is string => typeof n === 'string');
              const n = this._installedLocalModelCache.length;
              if (n === 0) return { status: 'degraded', detail: `ollama reachable but 0 models installed` };
              return { status: 'ok', detail: `${n} model(s) installed` };
            } finally { clearTimeout(t); }
          }
          return { status: 'ok' };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
      repair: async () => {
        // Safe repair: re-probe with longer timeout. Surfacing this as
        // "needs-approval" if it still fails — restarting ollama is the
        // user's call, not ours.
        const host = process.env['OLLAMA_HOST'] ?? 'http://localhost:11434';
        try {
          const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(8000) });
          if (r.ok) return { outcome: 'success', action: 're-pinged ollama with extended timeout', detail: 'recovered' };
          return { outcome: 'needs-approval', action: 'restart ollama', detail: `ollama at ${host} unreachable. User must restart it.`, requiresApproval: true };
        } catch (e) {
          return { outcome: 'needs-approval', action: 'restart ollama', detail: e instanceof Error ? e.message : String(e), requiresApproval: true };
        }
      },
    });

    // 2) Long-term memory DB — read-only count probe.
    monitor.registerProbe({
      name: 'Long-term Memory',
      run: async () => {
        try {
          const all = this.longTermMemory.listAll(1);
          return { status: 'ok', detail: `db readable (${all.length >= 1 ? 'has entries' : 'empty'})` };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 3) Tool registry — must have shell + write_file + memory_* registered.
    monitor.registerProbe({
      name: 'Tool Registry',
      run: async () => {
        const defs = this.toolRegistry.getDefinitions();
        const names = new Set(defs.map((d) => d.name));
        const required = ['shell', 'write_file', 'memory_store', 'memory_search'];
        const missing = required.filter((r) => !names.has(r));
        if (missing.length > 0) return { status: 'failed', detail: `missing: ${missing.join(', ')}` };
        return { status: 'ok', detail: `${defs.length} tools registered` };
      },
    });

    // 4) Conversation Memory — must be able to enumerate sessions without throw.
    monitor.registerProbe({
      name: 'Conversation Memory',
      run: async () => {
        try {
          // No-op call to verify the singleton is alive
          this.conversationMemory.getMessages('__healthcheck__');
          return { status: 'ok' };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 5) Workspace dir (AGENTX_APPS) — must be writable for app generation.
    monitor.registerProbe({
      name: 'Workspace (AGENTX_APPS)',
      run: async () => {
        try {
          const fs = await import('node:fs/promises');
          const path = '/Users/darrenjones/Projects/AGENTX_APPS';
          const stat = await fs.stat(path).catch(() => null);
          if (!stat) return { status: 'degraded', detail: `${path} does not exist` };
          if (!stat.isDirectory()) return { status: 'failed', detail: `${path} is not a directory` };
          // Try a write
          const probePath = `${path}/.healthprobe-${Date.now()}`;
          await fs.writeFile(probePath, 'ok');
          await fs.unlink(probePath);
          return { status: 'ok', detail: 'read+write verified' };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
      repair: async () => {
        try {
          const fs = await import('node:fs/promises');
          const path = '/Users/darrenjones/Projects/AGENTX_APPS';
          await fs.mkdir(path, { recursive: true });
          return { outcome: 'success', action: 'mkdir -p AGENTX_APPS', detail: 'created workspace directory' };
        } catch (e) {
          return { outcome: 'failed', action: 'mkdir AGENTX_APPS', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // ── Batch 4: self-healing expansion across the platform ──────────────

    // 6) Retrieval index integrity — confirms the FTS+chunks tables exist
    //    and a probe document_id lookup doesn't throw.
    monitor.registerProbe({
      name: 'Retrieval Index',
      run: async () => {
        try {
          const db = this.db;
          const fts = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('documents_fts', 'chunks_fts', 'documents', 'document_chunks')").all() as Array<{ name: string }>;
          const have = new Set(fts.map((r) => r.name));
          const required = ['documents_fts', 'chunks_fts', 'documents', 'document_chunks'];
          const missing = required.filter((r) => !have.has(r));
          if (missing.length > 0) {
            return { status: 'degraded', detail: `tables missing: ${missing.join(', ')}` };
          }
          return { status: 'ok', detail: `${required.length} tables present` };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 7) Runtime Settings — persistence round-trip read/write probe.
    monitor.registerProbe({
      name: 'Runtime Settings',
      run: async () => {
        try {
          const snap = RuntimeSettingsStore.getInstance().get();
          // Verify shape — these are required for the routing engine.
          const ok = typeof snap.localOnly === 'boolean' && typeof snap.retrievalEnabled === 'boolean' && typeof snap.toolCallingEnabled === 'boolean';
          return ok
            ? { status: 'ok', detail: `localOnly=${snap.localOnly} retrieval=${snap.retrievalEnabled} tools=${snap.toolCallingEnabled}` }
            : { status: 'failed', detail: 'settings snapshot missing required fields' };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 8) Routing Engine — confirms the decideRoute() function returns a
    //    decision for a synthetic chat classification.
    monitor.registerProbe({
      name: 'Routing Engine',
      run: async () => {
        try {
          // decideRoute is statically imported at module top — no dynamic
          // import cost per probe (Windows CI sensitivity).
          const d = decideRoute({
            classification: { primary: 'chat', confidence: 0.5, signals: [] },
            defaultProvider: this.config.agent.defaultProvider,
            defaultModel: this.config.agent.model ?? 'm',
            pins: {}, preferredModels: [], disabledModels: [],
            localOnly: false, installedLocalModels: [],
            reliabilityAware: false,
          });
          return d.model ? { status: 'ok', detail: `synthetic route → ${d.model}` } : { status: 'failed', detail: 'no model returned' };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 9) Validation Runner — confirms the scenario registry is non-empty.
    monitor.registerProbe({
      name: 'Validation Runner',
      run: async () => {
        try {
          const n = _VALIDATION_SCENARIOS.length;
          return n > 0
            ? { status: 'ok', detail: `${n} scenario(s) registered` }
            : { status: 'degraded', detail: 'no scenarios registered' };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 10) MCP (best-effort) — checks that mcp.json config can be read
    //     (the file may not exist, which is fine — just don't throw).
    monitor.registerProbe({
      name: 'MCP Config',
      run: async () => {
        try {
          const fs = await import('node:fs/promises');
          const os = await import('node:os');
          const path = await import('node:path');
          const p = path.join(os.homedir(), '.agentx', 'mcp.json');
          const stat = await fs.stat(p).catch(() => null);
          if (!stat) return { status: 'degraded', detail: 'no MCP config — no servers configured' };
          if (!stat.isFile()) return { status: 'failed', detail: `${p} is not a file` };
          return { status: 'ok', detail: 'MCP config readable' };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 11) Settings file health — when localOnly is on, verify it survived
    //     a load round-trip (catches corrupted JSON).
    monitor.registerProbe({
      name: 'Settings File',
      run: async () => {
        try {
          const fs = await import('node:fs/promises');
          const os = await import('node:os');
          const path = await import('node:path');
          const p = path.join(os.homedir(), '.agentx', 'runtime-settings.json');
          const stat = await fs.stat(p).catch(() => null);
          if (!stat) return { status: 'ok', detail: 'no settings file yet (defaults in effect)' };
          // Try parsing — failure means file is corrupted.
          const raw = await fs.readFile(p, 'utf-8');
          try { JSON.parse(raw); } catch { return { status: 'failed', detail: 'settings file is not valid JSON' }; }
          return { status: 'ok', detail: 'settings file parses cleanly' };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
      repair: async () => {
        // Safe repair: rename corrupted file with .corrupted suffix and reset to defaults.
        try {
          const fs = await import('node:fs/promises');
          const os = await import('node:os');
          const path = await import('node:path');
          const p = path.join(os.homedir(), '.agentx', 'runtime-settings.json');
          const backup = p + '.corrupted-' + Date.now();
          await fs.rename(p, backup).catch(() => { /* file may already be gone */ });
          RuntimeSettingsStore.getInstance().reset();
          return { outcome: 'success', action: `rename to ${backup} + reset to defaults`, detail: 'corrupted file quarantined; defaults restored' };
        } catch (e) {
          return { outcome: 'failed', action: 'quarantine corrupted settings', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // ── Batch 6A — workflow durability + autonomy hardening probes ───────

    // 12) Workflow Runtime — verifies the durable workflow table exists
    //     and recoverIncomplete() executes without throwing.
    monitor.registerProbe({
      name: 'Workflow Runtime',
      run: async () => {
        try {
          const summary = WorkflowRunStore.get(this.db).summary();
          const total = Object.values(summary).reduce((s, n) => s + n, 0);
          return { status: 'ok', detail: `${total} workflow run(s); running=${summary.running ?? 0} failed=${summary.failed ?? 0}` };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 13) Telemetry Pipeline — confirms TelemetryStore singleton accepts
    //     a sentinel write and rollups don't throw.
    monitor.registerProbe({
      name: 'Telemetry Pipeline',
      run: async () => {
        try {
          const t = TelemetryStore.getInstance();
          const sizeBefore = t.size();
          t.record({ kind: 'tool.exec', label: '__healthcheck__', latencyMs: 0 });
          const sizeAfter = t.size();
          const rollups = t.rollupByKind();
          return { status: 'ok', detail: `size ${sizeBefore}→${sizeAfter}, ${rollups.length} kind(s) rolled up` };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 14) Decision Trace Pipeline — confirms the agent's decision trace
    //     snapshot accessor returns an array (even when empty).
    monitor.registerProbe({
      name: 'Decision Trace',
      run: async () => {
        try {
          const events = this.getLastDecisionTrace();
          if (!Array.isArray(events)) return { status: 'failed', detail: 'snapshot returned non-array' };
          return { status: 'ok', detail: `${events.length} event(s) from last call` };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 15b) oMLX Runtime — pings the configured local endpoint /v1/models
    //      with a tight timeout. Honest degraded states for: not
    //      configured (env var absent), non-localhost URL (illegal),
    //      reachable but no models, unreachable. NEVER reaches out to
    //      a non-localhost endpoint — the provider constructor itself
    //      throws on non-local URLs.
    monitor.registerProbe({
      name: 'oMLX Runtime',
      run: async () => {
        const endpoint = process.env['AGENTX_OMLX_ENDPOINT'];
        if (!endpoint) {
          return { status: 'degraded', detail: 'AGENTX_OMLX_ENDPOINT not set — oMLX is opt-in' };
        }
        // Reject non-localhost up-front to enforce the localOnly guarantee.
        try { OmlxProvider.assertLocalhostOnly(endpoint); }
        catch (e) { return { status: 'failed', detail: e instanceof Error ? e.message : String(e) }; }

        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 2500);
        try {
          const r = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/models`, { signal: ctrl.signal });
          if (!r.ok) return { status: 'failed', detail: `oMLX ${endpoint} /v1/models returned ${r.status}` };
          const data = await r.json() as { data?: unknown[] };
          const n = Array.isArray(data.data) ? data.data.length : 0;
          if (n === 0) return { status: 'degraded', detail: `${endpoint} reachable, 0 models loaded` };
          return { status: 'ok', detail: `${endpoint} · ${n} model(s) loaded` };
        } catch (e) {
          return { status: 'degraded', detail: `${endpoint} unreachable: ${e instanceof Error ? e.message : String(e)}` };
        } finally { clearTimeout(t); }
      },
    });

    // 15) DB Integrity — fast PRAGMA integrity_check.
    monitor.registerProbe({
      name: 'DB Integrity',
      run: async () => {
        try {
          const row = this.db.prepare('PRAGMA quick_check').get() as { quick_check?: string } | undefined;
          const result = row?.quick_check ?? 'unknown';
          return result === 'ok'
            ? { status: 'ok', detail: 'quick_check ok' }
            : { status: 'failed', detail: `quick_check: ${result}` };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // 16) Engine Integration (Batch 7A) — confirms AgentLoopEngine is wired
    //     to WorkflowRunStore so future loop runs will persist.
    monitor.registerProbe({
      name: 'Engine Integration',
      run: async () => {
        const engineCtx = this._agentLoopEngine
          ? (this._agentLoopEngine as unknown as { context?: { workflowRunStore?: unknown } }).context
          : null;
        if (!this._agentLoopEngine) {
          return { status: 'degraded', detail: 'AgentLoopEngine not yet instantiated (lazy)' };
        }
        if (!engineCtx?.workflowRunStore) {
          return { status: 'failed', detail: 'AgentLoopEngine has no workflowRunStore — loops will not be durable' };
        }
        return { status: 'ok', detail: 'AgentLoopEngine ↔ WorkflowRunStore wired' };
      },
    });

    // 17) Approval Queue Integrity (Batch 7A) — confirms the workflow store
    //     can return pending-approval runs without throwing.
    monitor.registerProbe({
      name: 'Approval Queue',
      run: async () => {
        try {
          const s = WorkflowRunStore.get(this.db);
          const list = s.list({ state: 'awaiting_approval', limit: 10 });
          return { status: 'ok', detail: `${list.length} workflow(s) awaiting approval` };
        } catch (e) {
          return { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
        }
      },
    });

    // Run a probe cycle every 60s. Use 15s for the first 5 minutes for
    // faster boot-time signal, then settle into 60s cadence.
    monitor.start(60000);
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

  // Batch A2 — Private-memory-first decision trace.
  /** Snapshot of structured decision events emitted during the most-recent
   *  chat()/chatStream() call. Reset at the start of each call. */
  getLastDecisionTrace(): PrivateMemoryEvent[] { return this._decisionTrace.snapshot(); }
  /** Sufficiency decision for the most-recent retrieval. Null when retrieval
   *  did not run (e.g. flag off, error, or no-op). */
  getLastSufficiencyDecision(): RetrievalSufficiencyDecision | null {
    return this._lastSufficiencyDecision;
  }
  /** True when AgentX is enforcing localOnly mode (no cloud providers,
   *  no network-class tools). */
  isLocalOnly(): boolean { return this._localOnly; }

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
    // Batch A2 — reset private-memory decision trace + sufficiency.
    this._decisionTrace.reset();
    this._lastSufficiencyDecision = null;
    this._decisionTrace.emit({ event: 'retrieval_started', query: input });

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

      // Batch A2 — emit retrieval_results + assess sufficiency.
      this._decisionTrace.emit({
        event: 'retrieval_results',
        matchCount: this._lastRetrievalMetadata.retrievalMatchCount,
        source: String(source),
        intent: String(r.intent),
        elapsedMs,
      });
      const decision = assessRetrievalSufficiency({
        query: input,
        retrievalMatchCount: this._lastRetrievalMetadata.retrievalMatchCount,
        retrievalDocuments: cappedDocs.map((d) => ({
          document_id: d.document_id,
          file_name: d.file_name,
          title: d.title,
          sender: d.sender ?? null,
          snippet: d.snippet,
        })),
      });
      this._lastSufficiencyDecision = decision;
      this._decisionTrace.emit({
        event: 'retrieval_sufficiency_decision',
        sufficient: decision.sufficient,
        reason: decision.reason,
        matchedDocumentIds: decision.matchedDocumentIds,
        matchedTerms: decision.matchedTerms,
        score: decision.score,
      });

      // Build the prompt-injection string
      if (r.intent === 'COUNT') {
        const filters = this._retrievalService.parseCountFilters(input);
        const filterDesc = Object.keys(filters).length > 0
          ? Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(', ')
          : 'all documents';
        return `\n\n--- Retrieved Facts (sql:documents) ---\nDOCUMENT COUNT (${filterDesc}): ${retrievalCount}\nThis count is authoritative — it was computed from SQL, not estimated.\n--- End Retrieved Facts ---`;
      }
      if (documents.length === 0) return null;
      // Phase 3 audit fix — include the snippet content directly in the
      // injected block. Previously only doc id + filename were surfaced,
      // forcing the LLM to either hallucinate or attempt a `memory_search`
      // tool (which is a stub). With chunk content in-prompt the LLM can
      // ground its answer in real retrieved evidence. Snippets are bounded
      // (~280 chars each from extractSnippet) so the block stays small.
      const lines = documents.slice(0, 50).map(d => {
        const head = `- [${d.document_id}] ${d.file_name}${d.title ? ` — ${d.title}` : ''}${d.sender ? ` (sender: ${d.sender})` : ''}`;
        return d.snippet
          ? `${head}\n  excerpt: ${String(d.snippet).replace(/\s+/g, ' ').trim()}`
          : head;
      });
      const intentLabel = r.intent === 'EXACT_SEARCH' ? 'Exact-match Documents' :
                          r.intent === 'SEMANTIC' ? 'Semantically-relevant Documents' :
                          r.intent === 'FILTERED_SEARCH' ? 'Filtered Documents' : 'Documents';
      return `\n\n--- Retrieved Knowledge (${intentLabel}, ${r.results.length} matches) ---\n${lines.join('\n')}\n\nWhen answering, prefer information from the excerpts above over general knowledge. Cite the document by [document_id] when you use it.\n--- End Retrieved Knowledge ---`;
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

  /**
   * P12-2 — Archive recall. When the user's query references past
   * conversation ("what did we decide…", "as discussed", "last time")
   * OR shares ≥2 content words with archived turns, surface the top
   * archived hits as a compact prompt block. Nothing summarised out of
   * the window is ever unreachable. Best-effort; returns '' on any
   * failure. Cheap: one FTS query, only runs when the store exists.
   */
  private _buildArchiveRecallBlock(input: string): string {
    if (!this._continuousContext) return '';
    try {
      // Gate: only search the archive when the query plausibly refers
      // back to earlier conversation — avoids prompt noise on ordinary
      // doc/QA turns.
      const refersBack =
        /\b(?:what\s+did\s+we|as\s+(?:we\s+)?discussed|last\s+(?:time|session|week)|earlier\s+(?:you|we)|previously|remind\s+me|we\s+(?:decided|agreed|talked)|did\s+(?:you|we)\s+(?:say|mention))\b/i.test(input);
      if (!refersBack) return '';
      const hits = this._continuousContext.searchArchive(input, 4);
      if (hits.length === 0) return '';
      const lines = hits.map((h) => {
        const when = new Date(h.turn_timestamp).toISOString().slice(0, 16).replace('T', ' ');
        const text = h.content.replace(/\s+/g, ' ').slice(0, 260);
        return `- [${h.kind === 'summary' ? 'session summary' : h.role} @ ${when}] ${text}`;
      });
      return `\n\n--- Recalled From Earlier Conversations (${hits.length}) ---\n${lines.join('\n')}\n--- End Recalled Context ---`;
    } catch {
      return '';
    }
  }

  /** P12-2 — accessor for the durability layer (API / dashboard). */
  getContinuousContext(): ContinuousContextStore | null { return this._continuousContext; }

  /** P13-A2 — accessor so the memory_search tool can reach document retrieval. */
  getRetrievalService(): RetrievalService | null { return this._retrievalService; }

  /**
   * P13-A3 — oMLX reachability with a 60s TTL. Fire-and-forget refresh:
   * routing reads the CACHED flag (never blocks on the probe); the flag
   * flips within a minute of the MLX server starting or stopping.
   */
  private _probeOmlx(): boolean {
    const now = Date.now();
    if (now - this._omlxLastProbe > 60_000) {
      this._omlxLastProbe = now;
      void (async () => {
        try {
          const endpoint = (process.env['AGENTX_OMLX_ENDPOINT'] ?? 'http://localhost:8080').replace(/\/+$/, '');
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 1500);
          const r = await fetch(`${endpoint}/v1/models`, { signal: ctrl.signal });
          clearTimeout(t);
          const data = r.ok ? (await r.json()) as { data?: unknown[] } : null;
          const nowUp = !!data && Array.isArray(data.data) && data.data.length > 0;
          if (nowUp !== this._omlxAvailable) {
            log.info({ available: nowUp }, 'P13-A3: oMLX availability changed');
          }
          this._omlxAvailable = nowUp;
        } catch {
          this._omlxAvailable = false;
        }
      })();
    }
    return this._omlxAvailable;
  }

  /**
   * P13-A3 — Provider-evidence inputs for decideRoute. Feeds the Batch-10
   * promotion path that existed but was never wired: benchmark comparison
   * per task category + which providers are actually alive right now.
   */
  private _providerEvidenceInputs(taskType: string): {
    providerEvidence: { winner: string | null; reasons: string[]; perProvider: Array<{ provider: string; samples: number; avgScore: number }> } | null;
    availableProviders: string[];
    providerDefaultModel: Record<string, string>;
  } {
    const available = ['ollama'];
    if (this._omlxProvider && this._probeOmlx()) available.push('omlx');
    let evidence: ReturnType<Agent['_providerEvidenceInputs']>['providerEvidence'] = null;
    try {
      const cmp = ProviderBenchmarkStore.get(this.db).compare(taskType);
      evidence = { winner: cmp.winner, reasons: cmp.reasons, perProvider: cmp.perProvider };
    } catch { /* no benchmark data yet */ }
    return {
      providerEvidence: evidence,
      availableProviders: available,
      providerDefaultModel: {
        omlx: process.env['AGENTX_OMLX_MODEL'] ?? 'mlx-community/Qwen3-30B-A3B-Instruct-2507-4bit',
      },
    };
  }

  /** P13-A2 — read-only db handle for tool-side metadata lookups
   *  (document titles / chunk excerpts in memory_search results). */
  getDb(): Database.Database { return this.db; }

  /** P12-3 — accessor for the success-memory layer (API / dashboard). */
  getPlaybooks(): PlaybookStore | null { return this._playbooks; }

  /** P12-4 — accessor for the tool forge (API / dashboard / approval UI). */
  getToolForge(): ToolForge | null { return this._toolForge; }

  /**
   * P12-3 — Record the outcome of a completed chat turn into the
   * playbook store. Model comes from this turn's routing-history entry
   * (both chat paths record one); retrieval stats from the last run.
   * Best-effort: never throws.
   */
  private _recordPlaybookOutcome(input: string, responseContent: string, sessionId: string): void {
    if (!this._playbooks) return;
    try {
      const classification = classifyTask(input);
      const current = ModelRoutingHistory.getInstance().current();
      const model = current?.model ?? this.getActiveModel().model;
      this._playbooks.recordOutcome({
        taskType: classification.primary,
        query: input,
        model,
        success: responseContent.trim().length > 0 && !responseContent.startsWith('[Locked]'),
        retrievalSource: this._lastRetrievalStats?.source ?? null,
        retrievalMatchCount: this._lastRetrievalStats?.matchCount ?? null,
        responseChars: responseContent.length,
        sessionId,
      });

      // ── P13-C2: Proactive workflow proposals ──────────────────────
      // When a playbook proves itself repeatedly (confidence ≥ 0.9 AND
      // ≥ 5 uses) on a recurring-friendly task type, record ONE
      // workflow_proposal in the decision journal so the human can see
      // "AgentX has done this successfully 5+ times — want it scheduled?"
      // Strictly a PROPOSAL: nothing runs autonomously without approval.
      if (this._continuousContext) {
        const RECURRING_TYPES = new Set(['summarisation', 'retrieval-grounded-qa', 'deadline_extraction']);
        if (RECURRING_TYPES.has(classification.primary)) {
          const match = this._playbooks.findBest(classification.primary, input);
          const p = match?.playbook;
          if (p && p.confidence >= 0.9 && p.use_count >= 5) {
            const alreadyProposed = this._continuousContext
              .listDecisions({ kind: 'workflow_proposal', limit: 100 })
              .some((d) => d.title.includes(p.signature));
            if (!alreadyProposed) {
              this._continuousContext.recordDecision(
                'workflow_proposal',
                `Recurring success detected [${p.signature}] — propose scheduling as an autonomous workflow`,
                {
                  taskType: p.task_type,
                  signature: p.signature,
                  sampleQuery: p.sample_query,
                  confidence: p.confidence,
                  uses: p.use_count,
                  model: p.model,
                },
                sessionId,
              );
              log.info(
                { taskType: p.task_type, signature: p.signature, confidence: p.confidence, uses: p.use_count },
                'P13-C2: workflow proposal recorded — awaiting human review (GET /api/continuity/journal?kind=workflow_proposal)',
              );
            }
          }
        }
      }
    } catch { /* learning must never break a turn */ }
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
    const record = this._feedbackStore.record(payload);
    // P12-3 — User verdicts are the strongest learning signal: move the
    // matching playbook's confidence hard. A downvoted approach whose
    // confidence falls below 0.4 loses its model bias entirely.
    try {
      if (this._playbooks && payload.userQuery) {
        const classification = classifyTask(payload.userQuery);
        this._playbooks.applyFeedback(
          classification.primary,
          payload.userQuery,
          payload.rating === 'up',
        );
      }
    } catch { /* best-effort */ }
    return record;
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
  getModelRoutingHistory(): ModelRoutingHistory { return ModelRoutingHistory.getInstance(); }
  getToolOutcomeStore(): ToolOutcomeStore { return ToolOutcomeStore.getInstance(); }
  getHealthMonitor(): HealthMonitor { return HealthMonitor.getInstance(); }
  getRuntimeSettings(): RuntimeSettingsStore { return RuntimeSettingsStore.getInstance(); }
  getRetrievalOutcomeStore(): RetrievalOutcomeStore { return RetrievalOutcomeStore.getInstance(); }
  getTelemetryStore(): TelemetryStore { return TelemetryStore.getInstance(); }
  getWorkflowRunStore(): WorkflowRunStore { return WorkflowRunStore.get(this.db); }
  getProviderBenchmarkStore(): ProviderBenchmarkStore { return ProviderBenchmarkStore.get(this.db); }

  /** Snapshot of the currently-active model + provider. Used by the
   *  dashboard "Active LLM Routing" panel and Phase 4 truth surface. */
  getActiveModel(): { provider: string; model: string; localOnly: boolean; toolCallingEnabled: boolean } {
    const cfg = this.config;
    const providerId = cfg.agent.defaultProvider;
    const providerCfg = (cfg.providers as Record<string, { model?: string } | undefined>)[providerId];
    const model = providerCfg?.model ?? cfg.agent.model ?? '(unknown)';
    return {
      provider: providerId,
      model,
      localOnly: this._localOnly,
      toolCallingEnabled: process.env['AGENTX_OLLAMA_TOOL_CALLING'] === 'true' || providerId !== 'ollama',
    };
  }
  getGlobalLearningService(): GlobalLearningService | null { return this._globalLearningService; }
  getBuildIntelligenceService(): BuildIntelligenceService | null { return this._buildIntelligenceService; }
  getSelfImprovementService(): SelfImprovementService | null { return this._selfImprovementService; }
  getUserPersonalizationService(): UserPersonalizationService | null { return this._userPersonalizationService; }
  /**
   * Tier 2 batch C: lazy-instantiate the AgentLoopEngine on first call.
   *
   * Construction is deferred until something actually requests the engine
   * (POST /api/agent-loops/start). This keeps server boot cheap, avoids
   * paying the AgentLoopPlanner/Executor/Reflector cost when loops are
   * unused, and isolates any init failure to the user-triggered route
   * rather than blocking the server from starting.
   *
   * All context fields point to already-initialised privates on this
   * agent. No I/O happens here.
   */
  getAgentLoopEngine(): AgentLoopEngine | null {
    if (this._agentLoopEngine) return this._agentLoopEngine;
    try {
      const engine = new AgentLoopEngine({
        llmProvider: this.provider,
        toolRegistry: this.toolRegistry,
        longTermMemory: this.longTermMemory,
        eventBus: agentLoopEventBus,
        memoryIngestionEngine: this._memoryIngestionEngine,
        autonomyGate: this._autonomyGate,
        checkpointManager: this._checkpointManager,
        experienceStore: this.getLoopExperienceStore(),
        // Batch 7A — every loop now persists to workflow_runs for restart
        // recovery + dashboard surfacing.
        workflowRunStore: this.getWorkflowRunStore(),
      });
      // Optional capability setters — strengthen the engine when these
      // subsystems are wired. Each setter is a no-op when its dep is null.
      try { engine.setLearningEngine(this._learningEngine); } catch { /* */ }
      try { engine.setEpisodeStore(this._episodeStore); } catch { /* */ }
      try { engine.setKnowledgeFlow(this._knowledgeFlowEngine); } catch { /* */ }
      this._agentLoopEngine = engine;
      log.info('AgentLoopEngine lazy-initialised');
      return this._agentLoopEngine;
    } catch (err) {
      log.warn({ err: String(err) }, 'AgentLoopEngine lazy-init failed');
      return null;
    }
  }
  getMultiAgentSupervisor(): MultiAgentBuildSupervisor | null { return this._multiAgentSupervisor; }
  getHybridOrchestrator(): HybridOrchestrator | null { return this._hybridOrchestrator; }
  getModelFabric(): ModelFabric | null { return this._modelFabric; }

  /**
   * Tier 3 Builder Batch 2: lazy-init build queue + idle manager.
   * Both classes are self-contained (no constructor deps) and have zero
   * runtime cost until something calls into them. Constructor is NOT
   * touched — these fields live alongside the existing private fields
   * but are only allocated on first getter call.
   */
  private _buildQueue: BuildQueueManager | null = null;
  private _idleManager: IdleManager | null = null;

  getBuildQueue(): BuildQueueManager {
    if (!this._buildQueue) this._buildQueue = new BuildQueueManager();
    return this._buildQueue;
  }

  getIdleManager(): IdleManager {
    if (!this._idleManager) this._idleManager = new IdleManager();
    return this._idleManager;
  }

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
    // Tier 2 batch C: route through the lazy-init getter so the engine
    // is built on first use rather than at server boot.
    const engine = this.getAgentLoopEngine();
    if (!engine) {
      throw new Error('Agent-loop runtime is not available (lazy init failed).');
    }
    const goal = {
      description,
      constraints: constraints ?? [],
      sessionId: sessionId ?? 'default',
    };
    return engine.runLoop(goal as never) as unknown as AgentLoopState;
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
    /** Per-call model override. When set, routing is skipped. */
    model?: string;
  }): Promise<LLMResponse> {
    // ── P12-1: Task-aware model routing (non-streaming path) ─────────
    // Before P12-1 only chatStream() routed; every non-stream call went
    // to the fixed default model. Route here so ALL completions benefit.
    // Skipped when the caller already set an explicit model, or when the
    // intelligence layer forced 'reasoning' capability (accuracy-first).
    // P13-A3 — execution provider: normally Ollama; switched to oMLX when
    // routing promotes it via benchmark evidence AND the server is alive.
    let execProvider: BaseLLMProvider = this.provider;
    if (!options.model && options.capability !== 'reasoning') {
      try {
        const lastUser = [...options.messages].reverse().find((m) => m.role === 'user');
        const userText = typeof lastUser?.content === 'string' ? lastUser.content : '';
        if (userText.length > 0) {
          const settings = RuntimeSettingsStore.getInstance().get();
          const active = this.getActiveModel();
          const classification = classifyTask(userText);
          // P12-3 — Playbook recall. A proven approach for this kind of
          // request contributes two things:
          //   1. hint — appended to the system prompt (always, on match)
          //   2. model — prepended to the preferred-models list ONLY when
          //      the evidence gate is met (conf ≥ 0.8, ≥ 3 successes).
          //      Going through the preferred slot means it inherits ALL
          //      routing guards (disabled / not-installed / degraded).
          let playbookPreferred: string[] = [];
          try {
            // P13-B1 — semantic-first recall with keyword fallback.
            const match = this._playbooks
              ? await this._playbooks.findBestSemantic(classification.primary, userText)
              : null;
            if (match) {
              const hint = this._playbooks!.renderHintBlock(match);
              options = { ...options, systemPrompt: (options.systemPrompt ?? '') + hint };
              if (match.modelBiasEligible && match.playbook.model) {
                playbookPreferred = [match.playbook.model];
                log.info(
                  { taskType: classification.primary, model: match.playbook.model, confidence: match.playbook.confidence, overlap: match.overlap },
                  'P12-3: playbook model bias engaged',
                );
              }
            }
          } catch { /* playbooks are best-effort */ }
          const decision = decideRoute({
            classification,
            defaultProvider: active.provider,
            defaultModel: active.model,
            pins: settings.modelPins,
            preferredModels: [...playbookPreferred, ...settings.preferredModels],
            disabledModels: settings.disabledModels,
            localOnly: active.localOnly,
            installedLocalModels: this._installedLocalModelCache ?? [],
            reliabilityAware: settings.autoRoutingMode === 'reliability-aware',
            taskDefaults: DEFAULT_TASK_MODEL_MAP,
            perModelHealth: TelemetryStore.getInstance().perModelHealth(),
            // P13-A3 — benchmark-evidence provider promotion (ollama↔omlx)
            ...this._providerEvidenceInputs(classification.primary),
          });
          if (decision.model && decision.model !== active.model) {
            options = { ...options, model: decision.model };
            log.info(
              { taskType: decision.taskType, model: decision.model, reason: decision.reason },
              'P12-1: non-stream completion routed by task type',
            );
          }
          // P13-A3 — provider promotion: route this completion to oMLX
          // when the engine picked it (benchmark winner + alive).
          if (decision.provider === 'omlx' && this._omlxProvider && this._omlxAvailable) {
            execProvider = this._omlxProvider;
            log.info(
              { taskType: decision.taskType, model: decision.model },
              'P13-A3: completion promoted to oMLX provider',
            );
          }
          ModelRoutingHistory.getInstance().record({
            taskType: decision.taskType,
            model: decision.model,
            provider: decision.provider,
            reason: `non-stream: ${decision.reason}`,
            fallbackUsed: decision.fallbackChain.length > 0,
            localOnly: active.localOnly,
            toolCallingEnabled: (options.tools?.length ?? 0) > 0,
          });

          // ── P13-B2: Draft-fast / verify-heavy pipeline ──────────────
          // For grounded document QA on the heavy lane: let the fast MoE
          // draft the answer (~4-6× faster), then have the HEAVY model
          // act as a strict verifier (short output — cheap). VALID →
          // ship the fast draft; INVALID / tool-calls / any error →
          // fall through to the normal heavy completion unchanged.
          // Accuracy is preserved because the 70b remains the judge of
          // every shipped fast answer. Opt-out: AGENTX_FAST_DRAFT_VERIFY=false.
          if (
            process.env['AGENTX_FAST_DRAFT_VERIFY'] !== 'false' &&
            decision.taskType === 'retrieval-grounded-qa' &&
            decision.model === active.model && // heavy lane only
            (options.systemPrompt ?? '').includes('--- Retrieved Knowledge')
          ) {
            const fastModel = DEFAULT_TASK_MODEL_MAP['chat'];
            if (fastModel && (this._installedLocalModelCache ?? []).includes(fastModel)) {
              try {
                const t0 = Date.now();
                const draft = await this.provider.complete({
                  messages: options.messages,
                  systemPrompt: options.systemPrompt,
                  model: fastModel,
                  // No tools for the draft — tool loops belong to the
                  // heavy path.
                });
                const draftMs = Date.now() - t0;
                const draftText = draft?.content?.trim() ?? '';
                const hasToolCalls = Array.isArray((draft as { toolCalls?: unknown[] }).toolCalls) && ((draft as { toolCalls?: unknown[] }).toolCalls!.length > 0);
                if (draftText.length > 40 && !hasToolCalls) {
                  const verifyPrompt =
                    'You are a strict citation verifier. Below is a QUESTION, retrieved SOURCE EXCERPTS, and a DRAFT ANSWER. ' +
                    'Reply with exactly one word: VALID if every factual claim in the draft is supported by the excerpts, ' +
                    'or INVALID if any claim is unsupported, contradicted, or fabricated.';
                  const excerpts = (options.systemPrompt ?? '').split('--- Retrieved Knowledge')[1]?.slice(0, 6000) ?? '';
                  const t1 = Date.now();
                  const verdict = await this.provider.complete({
                    messages: [{
                      role: 'user',
                      content: `QUESTION:\n${userText.slice(0, 1000)}\n\nSOURCE EXCERPTS:\n${excerpts}\n\nDRAFT ANSWER:\n${draftText.slice(0, 4000)}\n\nReply VALID or INVALID only.`,
                      timestamp: Date.now(),
                    }],
                    systemPrompt: verifyPrompt,
                    model: active.model, // the heavy model judges
                    maxTokens: 8,
                    temperature: 0,
                  });
                  const verifyMs = Date.now() - t1;
                  const verdictText = (verdict?.content ?? '').trim().toUpperCase();
                  if (verdictText.startsWith('VALID')) {
                    log.info(
                      { draftMs, verifyMs, fastModel, totalMs: draftMs + verifyMs },
                      'P13-B2: fast draft VERIFIED by heavy model — shipping fast answer',
                    );
                    this._continuousContext?.recordDecision(
                      'fast_draft_verified',
                      `Grounded answer drafted by ${fastModel} and verified by ${active.model} (${draftMs + verifyMs}ms total)`,
                      { draftMs, verifyMs },
                    );
                    if (draft.usage) {
                      this.rateLimiter.recordTokenUsage(draft.usage.inputTokens + draft.usage.outputTokens);
                    }
                    return draft;
                  }
                  log.info(
                    { draftMs, verifyMs, verdict: verdictText.slice(0, 20) },
                    'P13-B2: draft rejected by verifier — regenerating on heavy model',
                  );
                }
              } catch (dvErr) {
                log.warn(
                  { err: dvErr instanceof Error ? dvErr.message : String(dvErr) },
                  'P13-B2: draft-verify attempt failed — falling through to heavy path',
                );
              }
            }
          }
        }
      } catch (routeErr) {
        // Routing must NEVER break a completion — fall through to the
        // default model on any classification/registry error.
        log.warn(
          { err: routeErr instanceof Error ? routeErr.message : String(routeErr) },
          'P12-1: non-stream routing threw — using default model',
        );
      }
    }

    // Estimate tokens for rate limiting
    const estimatedTokens = this.contextManager.estimateTokenCount(options.messages);

    // Acquire rate limit slot
    await this.rateLimiter.acquire(estimatedTokens);

    // Execute through circuit breaker + retry. P13-A3: when the call is
    // promoted to oMLX and oMLX fails, fall back to Ollama ONCE before
    // the normal retry policy — a stopped MLX server must never fail a
    // chat turn.
    const response = await this.llmCircuitBreaker.execute(() =>
      retryWithBackoff(
        async () => {
          if (execProvider !== this.provider) {
            try {
              return await execProvider.complete(options);
            } catch (omlxErr) {
              log.warn(
                { err: omlxErr instanceof Error ? omlxErr.message : String(omlxErr) },
                'P13-A3: oMLX completion failed — falling back to Ollama',
              );
              this._omlxAvailable = false;
              execProvider = this.provider;
              // Strip the oMLX model id so Ollama uses its routed/default model.
              const { model: _omlxModel, ...rest } = options;
              options = rest as typeof options;
            }
          }
          return this.provider.complete(options);
        },
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

  /** Conversation memory (per-session message history). Used by the integrity
   *  diagnostics probe and by anyone needing programmatic session-message
   *  access. */
  getConversationMemory(): ConversationMemory {
    return this.conversationMemory;
  }

  /** Currently-configured LLM provider instance. Exposed so integrity
   *  diagnostics can confirm provider availability without going through
   *  full chat(). */
  getProvider(): BaseLLMProvider {
    return this.provider;
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

    // P12-2 — Session bridge detection: a session with no prior turns
    // is a fresh start. If earlier sessions left an archive, prepare a
    // compact recap for injection into the system prompt below so the
    // new session never boots as a blank slate.
    const _wasFreshSession =
      this.conversationMemory.getMessages(session.id).length === 0;

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

    // P12-2 — Inject the previous-session recap on the FIRST turn of a
    // fresh session. Capped (~1.2k chars) so prompt overhead stays low.
    let bridgeBlock = '';
    if (_wasFreshSession && this._continuousContext) {
      try {
        const bridge = this._continuousContext.getBridgeContext(session.id);
        if (bridge) {
          bridgeBlock = '\n\n' + this._continuousContext.renderBridgeBlock(bridge);
          this._continuousContext.recordDecision(
            'session_bridge',
            `New session bridged with recap from ${bridge.lastSessionId ?? 'journal'}`,
            { fromSession: bridge.lastSessionId },
            session.id,
          );
          log.info({ sessionId: session.id, fromSession: bridge.lastSessionId }, 'P12-2: session bridged with previous recap');
        }
      } catch { /* bridge is best-effort */ }
    }

    // P12-2 — archive recall: queries that refer back to earlier
    // conversation pull the original archived turns into context.
    const archiveRecall = this._buildArchiveRecallBlock(input);

    const augmentedSystemPrompt =
      this.systemPrompt + (retrievalContext ?? '') + bridgeBlock + archiveRecall;

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

    // P12-3 — Learn from this turn. A completed, non-empty response is
    // a success signal for the (task type, query signature) playbook.
    this._recordPlaybookOutcome(input, finalResponse.content, session.id);

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

    // P12-2 — fresh-session detection for the bridge (see chat()).
    const _wasFreshSessionStream =
      this.conversationMemory.getMessages(session.id).length === 0;

    const userMessage: Message = {
      role: 'user',
      content: input,
      timestamp: Date.now(),
    };
    this.conversationMemory.addMessage(session.id, userMessage);

    // ── Batch 2 — apply persisted runtime settings BEFORE doing any work ──
    // Toggles consulted here change behaviour for THIS call.
    const settings = RuntimeSettingsStore.getInstance().get();
    // localOnly toggle: privacy-default policy — if EITHER the config-set
    // _localOnly OR the settings-store localOnly says "true", we run as
    // localOnly. We never use the settings store to TURN OFF a config-set
    // localOnly mid-call (that would be a privacy footgun). Updating
    // settings off→on still flips the flag for this call.
    if (settings.localOnly && !this._localOnly) {
      this._localOnly = true;
    }

    let allMessages = this.conversationMemory.getMessages(session.id);
    const contextResult = await this.contextManager.prepareContext(session.id, allMessages);
    const messages = contextResult.messages;

    // tool-calling toggle: when off, hand the provider an empty tool list
    // so it cannot emit tool_calls. Decision-trace records the override.
    let toolDefs = this.toolRegistry.getDefinitions();
    if (!settings.toolCallingEnabled) {
      this._decisionTrace.emit({ event: 'tool_fallback_blocked', tool: '(all)', reason: 'tool_calling_disabled_setting' });
      toolDefs = [];
    } else if (settings.autoRoutingMode === 'reliability-aware') {
      // Self-learning → routing influence. Drop tools whose last 10 calls
      // are below 50% success. Decision-trace records the demotion so
      // tests + UI can prove it actually happened.
      const demoted = ToolOutcomeStore.getInstance().demotedTools();
      if (demoted.length > 0) {
        const dropNames = new Set(demoted.map((d) => d.toolName));
        toolDefs = toolDefs.filter((t) => !dropNames.has(t.name));
        for (const d of demoted) {
          this._decisionTrace.emit({
            event: 'tool_fallback_blocked',
            tool: d.toolName,
            reason: `tool_routing_demoted (recent ${Math.round(d.recentSuccessRate * 100)}% over ${d.recentCalls})`,
          });
        }
      }
    }

    this._runIntelligenceObservation(input);

    // retrieval-enabled toggle: when off, skip retrieval entirely. Record
    // the skip as a RetrievalOutcome so the dashboard reflects it.
    let retrievalContextStream: string | null = null;
    const retrievalT0 = Date.now();
    if (settings.retrievalEnabled) {
      try {
        retrievalContextStream = await this._buildRetrievalContext(input);
        const meta = this._lastRetrievalMetadata;
        RetrievalOutcomeStore.getInstance().record({
          query: input.slice(0, 200),
          success: retrievalContextStream !== null,
          matchCount: meta?.retrievalMatchCount ?? 0,
          sufficient: this._lastSufficiencyDecision?.sufficient ?? null,
          fallbackUsed: false,
          latencyMs: Date.now() - retrievalT0,
          sourceTypes: meta?.retrievalSource ? [meta.retrievalSource] : [],
          groundedAnswer: null,
        });
      } catch (e) {
        RetrievalOutcomeStore.getInstance().record({
          query: input.slice(0, 200),
          success: false,
          matchCount: 0,
          sufficient: null,
          fallbackUsed: false,
          latencyMs: Date.now() - retrievalT0,
          sourceTypes: [],
          groundedAnswer: null,
          failureReason: e instanceof Error ? e.message : String(e),
        });
        // Don't crash the chat call — retrieval is best-effort.
        retrievalContextStream = null;
      }
    } else {
      this._decisionTrace.emit({ event: 'retrieval_sufficiency_decision', sufficient: false, reason: 'retrieval_disabled_setting' } as never);
    }
    // P12-2 — session bridge + archive recall (stream path).
    let bridgeBlockStream = '';
    if (_wasFreshSessionStream && this._continuousContext) {
      try {
        const bridge = this._continuousContext.getBridgeContext(session.id);
        if (bridge) {
          bridgeBlockStream = '\n\n' + this._continuousContext.renderBridgeBlock(bridge);
          this._continuousContext.recordDecision(
            'session_bridge',
            `New session bridged with recap from ${bridge.lastSessionId ?? 'journal'}`,
            { fromSession: bridge.lastSessionId },
            session.id,
          );
        }
      } catch { /* best-effort */ }
    }
    const archiveRecallStream = this._buildArchiveRecallBlock(input);

    const augmentedSystemPromptStream =
      this.systemPrompt + (retrievalContextStream ?? '') + bridgeBlockStream + archiveRecallStream;
    // R3: emit retrieval event BEFORE any model token streaming begins.
    if (this._lastRetrievalMetadata && callbacks.onRetrieval) {
      callbacks.onRetrieval(this._lastRetrievalMetadata);
    }

    // Batch 3 — real routing engine + classification before each provider call.
    // The decision is recorded with full provenance (pin? preferred? fallback?)
    // BEFORE the stream starts so the dashboard updates as soon as the call begins.
    const classification: TaskClassification = classifyTask(input);
    const active = this.getActiveModel();
    const decision: RoutingDecision = decideRoute({
      classification,
      defaultProvider: active.provider,
      defaultModel: active.model,
      pins: settings.modelPins,
      preferredModels: settings.preferredModels,
      disabledModels: settings.disabledModels,
      localOnly: active.localOnly,
      installedLocalModels: this._installedLocalModelCache ?? [],
      reliabilityAware: settings.autoRoutingMode === 'reliability-aware',
      // P12-1 — task-aware model defaults: light tasks route to fast
      // models; document / legal / medical / reasoning tasks stay on
      // the heavy default. User pins + preferred-models still win.
      taskDefaults: DEFAULT_TASK_MODEL_MAP,
      // P13-A3 — benchmark-evidence provider promotion (ollama↔omlx)
      ...this._providerEvidenceInputs(classification.primary),
      // Batch 6D — telemetry-driven model demotion. perModelHealth feeds
      // p95 latency + success rate so routing prefers healthy models.
      perModelHealth: TelemetryStore.getInstance().perModelHealth(),
      // Batch 8E — workflow-success-aware annotation. Surfaces recent
      // autonomous run health in the routing decision reason so the
      // operator dashboard shows whether the runtime is healthy.
      workflowReliability: (() => {
        try { return WorkflowRunStore.get(this.db).recentReliability(); } catch { return null; }
      })(),
    });
    const routingId = ModelRoutingHistory.getInstance().record({
      taskType: decision.taskType,
      model: decision.model,
      provider: decision.provider,
      reason: decision.reason,
      fallbackUsed: decision.fallbackChain.length > 0,
      localOnly: active.localOnly,
      toolCallingEnabled: active.toolCallingEnabled && toolDefs.length > 0,
    });
    const routingStartedAt = Date.now();

    // P13-A3 — stream execution provider: oMLX when promoted + alive,
    // with a one-shot Ollama fallback so a dead MLX server can't break
    // the stream.
    const streamProvider: BaseLLMProvider =
      decision.provider === 'omlx' && this._omlxProvider && this._omlxAvailable
        ? this._omlxProvider
        : this.provider;
    if (streamProvider !== this.provider) {
      log.info({ taskType: decision.taskType, model: decision.model }, 'P13-A3: stream promoted to oMLX provider');
    }

    // First response: stream it — pass the routed model as a per-call override
    // so the provider uses it without mutating shared state.
    let response: LLMResponse;
    try {
      try {
        response = await streamProvider.completeStream(
          {
            messages,
            systemPrompt: augmentedSystemPromptStream,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            model: decision.model,
            ...(this._resolveModelHint() ?? {}),
          },
          callbacks,
        );
      } catch (streamErr) {
        if (streamProvider === this.provider) throw streamErr;
        log.warn(
          { err: streamErr instanceof Error ? streamErr.message : String(streamErr) },
          'P13-A3: oMLX stream failed — falling back to Ollama',
        );
        this._omlxAvailable = false;
        response = await this.provider.completeStream(
          {
            messages,
            systemPrompt: augmentedSystemPromptStream,
            tools: toolDefs.length > 0 ? toolDefs : undefined,
            ...(this._resolveModelHint() ?? {}),
          },
          callbacks,
        );
      }
      const latencyMs = Date.now() - routingStartedAt;
      ModelRoutingHistory.getInstance().setLatency(routingId, latencyMs);
      // Batch 5 — telemetry: record per-call tokens-in/out + latency so the
      // dashboard's Telemetry surface can compute tokens/sec and p50/p95.
      TelemetryStore.getInstance().record({
        kind: 'llm.stream',
        label: `${decision.provider}:${decision.model}`,
        latencyMs,
        inputTokens: response.usage?.inputTokens,
        outputTokens: response.usage?.outputTokens,
        success: true,
      });
    } catch (error) {
      const latencyMs = Date.now() - routingStartedAt;
      ModelRoutingHistory.getInstance().setLatency(routingId, latencyMs);
      TelemetryStore.getInstance().record({
        kind: 'llm.stream',
        label: `${decision.provider}:${decision.model}`,
        latencyMs,
        success: false,
        errorReason: error instanceof Error ? error.message : String(error),
      });
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

    // Batch 3 — grounded-answer scoring. If retrieval was used and the
    // assistant did not cite [MEM-N] / [DOC-N], mark groundedAnswer=false
    // on the most-recent RetrievalOutcome. This patches the in-memory
    // record so the dashboard reflects it.
    if (settings.retrievalEnabled && retrievalContextStream) {
      const cited = /\[(MEM|DOC)-\d+\]/i.test(finalResponse.content);
      const store = RetrievalOutcomeStore.getInstance();
      const recent = store.recent(1);
      const last = recent[0];
      if (last) {
        // Mutate the underlying entry — store keeps a reference so this
        // is visible to subsequent reads. Reliability rollup recomputes
        // from this state on the next reliability() call.
        (last as { groundedAnswer: boolean | null }).groundedAnswer = cited;
      }
    }

    // P12-3 — Learn from this streamed turn (see chat()).
    this._recordPlaybookOutcome(input, finalResponse.content, session.id);

    return finalResponse.content;
  }

  private async executeToolCall(toolCall: ToolCall, sessionId: string): Promise<string> {
    // Batch A2 — Private-memory-first policy gate.
    // Network-class tools (TOOL_PERMISSION_MAP[name] === 'network') are
    // blocked when EITHER:
    //   - retrieval sufficiency for the current call is true, OR
    //   - localOnly mode is enabled.
    // Blocked calls return a synthetic result that informs the LLM the
    // tool was suppressed — the LLM's next turn answers from memory.
    // Non-network tools (shell, memory_*, current_time, etc.) are
    // unaffected. The decision is recorded in the decision trace for
    // tests + UI surfaces.
    const networkClass = TOOL_PERMISSION_MAP[toolCall.name] === 'network';
    if (networkClass) {
      const sufficient = this._lastSufficiencyDecision?.sufficient === true;
      if (this._localOnly) {
        this._decisionTrace.emit({ event: 'tool_fallback_blocked', tool: toolCall.name, reason: 'local_only' });
        this._decisionTrace.emit({ event: 'external_request_blocked', host: '(' + toolCall.name + ')', reason: 'local_only' });
        return JSON.stringify({
          blocked: true,
          reason: 'local_only',
          tool: toolCall.name,
          message: 'Network-class tool blocked: AgentX is running in localOnly mode. Answer from local memory only.',
        });
      }
      if (sufficient) {
        this._decisionTrace.emit({ event: 'tool_fallback_blocked', tool: toolCall.name, reason: 'sufficient_memory' });
        return JSON.stringify({
          blocked: true,
          reason: 'sufficient_memory',
          tool: toolCall.name,
          message: 'Network-class tool blocked: local memory was sufficient to answer. Answer from retrieved context.',
        });
      }
      this._decisionTrace.emit({ event: 'tool_fallback_allowed', tool: toolCall.name, reason: 'insufficient_memory' });
    } else {
      // Record allowance for non-network tools so the trace is complete.
      this._decisionTrace.emit({ event: 'tool_fallback_allowed', tool: toolCall.name, reason: 'non_network_tool' });
    }
    // Self-learning: time every tool call and record outcome to the
    // ToolOutcomeStore. Heuristic for failure detection lives in the store.
    const t0 = Date.now();
    let result: string;
    try {
      result = await this.toolRegistry.execute(toolCall.name, toolCall.arguments, {
        sessionId,
        agent: this,
      });
    } catch (e) {
      const errResult = `[${toolCall.name} error]: ${e instanceof Error ? e.message : String(e)}`;
      ToolOutcomeStore.getInstance().record(toolCall.name, errResult, Date.now() - t0);
      throw e;
    }
    ToolOutcomeStore.getInstance().record(toolCall.name, result, Date.now() - t0);
    return result;
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
