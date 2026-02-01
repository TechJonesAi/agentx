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

  constructor(configPath?: string) {
    super();

    this.config = loadConfig(configPath);
    const dataDir = ensureDataDir();

    this.db = createDatabase(dataDir);
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

    log.info({ provider: this.config.agent.defaultProvider }, 'Agent initialized');
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

    let response: LLMResponse;
    try {
      response = await this.completeWithResilience({
        messages,
        systemPrompt: this.systemPrompt,
        tools: toolDefs.length > 0 ? toolDefs : undefined,
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

    // First response: stream it
    let response: LLMResponse;
    try {
      response = await this.provider.completeStream(
        {
          messages,
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
