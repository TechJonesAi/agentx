/**
 * Model Fabric — Runtime LLM routing layer.
 * Routes LLM calls through registered providers with capability-based selection
 * and automatic fallback on failure.
 */
import { createLogger } from '../logger.js';
import type { BaseLLMProvider } from './base.js';
import type { LLMModelRegistry } from './model-registry.js';
import type { ModelRouter } from './model-router.js';
import type { RoutingPolicy } from './routing-policy.js';
import type { RoutingMode } from './model-registry.js';
import type { Message, LLMResponse, StreamCallbacks, ToolDefinition } from '../types.js';
import { analyzeToolUse } from './tool-use-detector.js';
import { eventBus } from '../agent-loop/event-bus.js';
import { withLLMSpan } from '../observability/otel.js';

const log = createLogger('llm:fabric');

/**
 * Rough token estimate — 4 chars ≈ 1 token for English text. Deliberately
 * approximate; used only to decide when to escalate to the subscription
 * provider in COMBINATION mode.
 */
function estimateInputTokens(opts: { messages: Message[]; systemPrompt?: string }): number {
  let chars = (opts.systemPrompt ?? '').length;
  for (const m of opts.messages) {
    chars += (typeof m.content === 'string' ? m.content.length : JSON.stringify(m.content ?? '').length);
  }
  return Math.ceil(chars / 4);
}

interface ModelFabricConfig {
  registry: LLMModelRegistry;
  router: ModelRouter;
  policy: RoutingPolicy;
}

interface CompletionOptions {
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

export interface FabricCompletionInput {
  messages: Message[];
  systemPrompt?: string;
  tools?: ToolDefinition[];
}

export interface FabricCompletionResult extends LLMResponse {}

export class ModelFabric {
  private providers = new Map<string, BaseLLMProvider>();
  private defaultProvider: string | null = null;
  private _performanceStore: any = null;
  private _personalizationService: any = null;
  private _buildIntelligenceService: any = null;
  private registry: LLMModelRegistry;
  private router: ModelRouter;
  private policy: RoutingPolicy;

  /** Tracks the model actually used for the last completion (for diagnostics). */
  private _lastUsedModel: string | null = null;

  constructor(config: ModelFabricConfig) {
    this.registry = config.registry;
    this.router = config.router;
    this.policy = config.policy;
  }

  registerProvider(name: string, provider: BaseLLMProvider): void {
    this.providers.set(name, provider);
    if (!this.defaultProvider) this.defaultProvider = name;
    log.debug({ name, totalProviders: this.providers.size }, 'Provider registered');
  }

  setPerformanceStore(store: any): void {
    this._performanceStore = store;
  }

  /** Phase 4.4: Wire UserPersonalizationService for model ranking bias. */
  setPersonalizationService(service: any): void {
    this._personalizationService = service;
    log.info('Personalization service wired into ModelFabric');
  }

  /** Phase 4.4: Wire BuildIntelligenceService for avoid-model intelligence. */
  setBuildIntelligenceService(service: any): void {
    this._buildIntelligenceService = service;
    log.info('BuildIntelligence service wired into ModelFabric');
  }

  /**
   * Runtime toggle for Build-Learning bias. When the Settings page disables
   * the `buildLearning` feature flag, we skip the BuildIntelligence rerank
   * pass without unloading the service itself. Returning true re-enables it.
   */
  private _buildLearningEnabled = true;
  setBuildLearningEnabled(enabled: boolean): void {
    this._buildLearningEnabled = enabled;
    log.info({ enabled }, 'BuildLearning flag updated');
  }

  /**
   * Phase 4.4: Apply personalization + intelligence bias to a model ordering.
   * Returns the reordered list. Non-destructive — never removes models.
   *
   * Bias order (each pass is stable / non-removing):
   *   1. Tool-use quality — models that historically missed tool_use when it
   *      was expected drift toward the BACK of the list. This is the newest
   *      signal and the simplest to reason about, so it runs first.
   *   2. BuildIntelligence preferred / avoid recommendations.
   *   3. UserPersonalization ranking bias.
   */
  private applyPersonalizationBias(models: string[], taskCategory?: string): string[] {
    if (!models.length) return models;

    let ranked = [...models];

    // 0. Tool-use quality: rerank based on historical miss rate. Models with
    //    a poor success rate (below 50 %) AND meaningful sample size get
    //    demoted behind any model with a better record. This is what makes
    //    AgentX actually "learn" from past weak tool-use — qwen3:14b missing
    //    several saves in a row starts falling below qwen3-coder:30b for the
    //    code capability on subsequent turns, without any manual config.
    //
    //    Signals considered:
    //      (a) tool_use PRESENCE (listToolUseOutcomes) — did the model
    //          actually emit a tool call when one was expected?
    //      (b) tool_call QUALITY (listToolCallQuality) — when it DID call
    //          a tool, was the call correct + the final response grounded?
    //    Either one being weak drops the model into the back bucket.
    if (this._performanceStore && typeof (this._performanceStore as any).listToolUseOutcomes === 'function' && this._buildLearningEnabled) {
      try {
        const capability = taskCategory ?? 'text';
        const outcomes = (this._performanceStore as any).listToolUseOutcomes(capability) as Array<{ model: string; successCount: number; failureCount: number; successRate: number }>;
        const qualities = typeof (this._performanceStore as any).listToolCallQuality === 'function'
          ? ((this._performanceStore as any).listToolCallQuality(capability) as Array<{ model: string; sampleCount: number; avgQuality: number; weakCount: number }>)
          : [];
        const MIN_SAMPLES = 3;
        const WEAK_RATE = 0.5;
        const WEAK_QUALITY = 0.55;

        const weakByPresence = new Set(
          outcomes
            .filter(o => (o.successCount + o.failureCount) >= MIN_SAMPLES && o.successRate < WEAK_RATE)
            .map(o => o.model),
        );
        const weakByQuality = new Set(
          qualities
            .filter(q => q.sampleCount >= MIN_SAMPLES && q.avgQuality < WEAK_QUALITY)
            .map(q => q.model),
        );
        const weakSet = new Set<string>([...weakByPresence, ...weakByQuality]);

        if (weakSet.size > 0) {
          const strong = ranked.filter(m => !weakSet.has(m));
          const weak = ranked.filter(m => weakSet.has(m));
          // Sort the weak bucket worst-first-removed by a combined score
          // (quality avg when available, otherwise success rate).
          const scoreOf = (m: string): number => {
            const q = qualities.find(x => x.model === m);
            if (q && q.sampleCount >= MIN_SAMPLES) return q.avgQuality;
            const o = outcomes.find(x => x.model === m);
            return o?.successRate ?? 1;
          };
          weak.sort((a, b) => scoreOf(b) - scoreOf(a));
          ranked = [...strong, ...weak];
          log.debug({
            capability,
            weakByPresence: Array.from(weakByPresence),
            weakByQuality: Array.from(weakByQuality),
          }, 'Tool-use signal: demoted weak tool-callers');
        }
      } catch { /* non-critical */ }
    }

    // 1. Apply BuildIntelligence: promote preferred model + demote avoid-list.
    //    Honours the Settings → features.buildLearning flag.
    if (this._buildIntelligenceService && this._buildLearningEnabled) {
      try {
        const recs = this._buildIntelligenceService.getBuildRecommendations(taskCategory ?? 'build');

        // 1a. Promote preferred_model to front of list (if present in chain)
        if (recs?.preferred_model && ranked.includes(recs.preferred_model)) {
          ranked = [
            recs.preferred_model,
            ...ranked.filter(m => m !== recs.preferred_model),
          ];
          log.debug({ preferred: recs.preferred_model }, 'BuildIntelligence: promoted preferred model to front');
        }

        // 1b. Demote avoid-list models to end
        if (recs?.avoid_models?.length) {
          const avoidSet = new Set(recs.avoid_models);
          const good = ranked.filter(m => !avoidSet.has(m));
          const bad = ranked.filter(m => avoidSet.has(m));
          if (good.length > 0) {
            ranked = [...good, ...bad];
            log.debug({ avoided: recs.avoid_models }, 'BuildIntelligence: demoted avoid-list models');
          }
        }
      } catch { /* non-critical */ }
    }

    // 2. Apply UserPersonalization bias: rerank based on user preference history
    if (this._personalizationService) {
      try {
        ranked = this._personalizationService.biasModelRanking(
          ranked,
          'default', // userId
          null,      // globalRecs — let service fetch internally
          null,      // globalConfidence
        );
        log.debug({ ranked }, 'UserPersonalization: model ranking biased');
      } catch { /* non-critical */ }
    }

    return ranked;
  }

  getRouter(): ModelRouter {
    return this.router;
  }

  getRegistry(): LLMModelRegistry {
    return this.registry;
  }

  getPolicy(): RoutingPolicy {
    return this.policy;
  }

  getPerformanceStore(): any {
    return this._performanceStore;
  }

  getMode(): RoutingMode {
    return this.policy.getMode();
  }

  setMode(mode: RoutingMode): void {
    this.policy.setMode(mode);
  }

  getLastUsedModel(): string | null {
    return this._lastUsedModel;
  }

  getDiagnostics(): Record<string, unknown> {
    const registered = this.registry.getModels();
    const byProvider: Record<string, number> = {};
    const byCapability: Record<string, number> = {};
    let localCount = 0;
    let cloudCount = 0;
    for (const m of registered) {
      byProvider[m.provider] = (byProvider[m.provider] ?? 0) + 1;
      for (const cap of m.capabilities) {
        byCapability[cap] = (byCapability[cap] ?? 0) + 1;
      }
      if (m.privacyLevel === 'cloud') cloudCount++; else localCount++;
    }
    return {
      registeredProviders: Array.from(this.providers.keys()),
      defaultProvider: this.defaultProvider,
      lastUsedModel: this._lastUsedModel,
      mode: this.policy.getMode(),
      routerDiagnostics: this.router.getDiagnostics(),
      registry: {
        totalRegistered: registered.length,
        enabledCount: registered.length,
        localCount,
        cloudCount,
        byProvider,
        byCapability,
      },
      policy: {
        ...this.policy.getConfig(),
        mode: this.policy.getMode(),
        cloudAllowed: this.policy.getMode() === 'COMBINATION',
      },
    };
  }

  /**
   * Resolve a provider by model name or key.
   * Checks: exact key match → model name match → default → first available.
   */
  /**
   * Public accessor for resolving a provider by model ID.
   * Used by ToolControllerPool to get provider instances for benchmarking.
   */
  getProviderByModel(modelId: string): { key: string; provider: BaseLLMProvider } | null {
    return this.resolveProvider(modelId);
  }

  private resolveProvider(modelId?: string): { key: string; provider: BaseLLMProvider } | null {
    if (modelId) {
      // Exact key match (e.g., "ollama:qwen3-coder:30b")
      const byKey = this.providers.get(modelId);
      if (byKey) return { key: modelId, provider: byKey };

      // Try "ollama:<modelId>" key format
      const ollamaKey = `ollama:${modelId}`;
      const byOllamaKey = this.providers.get(ollamaKey);
      if (byOllamaKey) return { key: ollamaKey, provider: byOllamaKey };
    }

    // Default provider
    if (this.defaultProvider) {
      const prov = this.providers.get(this.defaultProvider);
      if (prov) return { key: this.defaultProvider, provider: prov };
    }

    // First available
    for (const [key, prov] of this.providers) {
      if (prov.isConfigured()) return { key, provider: prov };
    }

    return null;
  }

  /**
   * Select and return a provider for the given capability, using the router
   * to determine the best model and resolving to a registered provider.
   */
  private getProvider(capability?: string, taskCategory?: string, preferredModel?: string): BaseLLMProvider {
    // Use router for capability-based selection
    const selection = this.router.selectModel({
      capability: capability ?? 'text',
      taskCategory,
      preferredModel,
    });

    const resolved = this.resolveProvider(selection.model);
    if (resolved) {
      this._lastUsedModel = selection.model;
      log.debug({ capability, model: selection.model, reason: selection.reason, key: resolved.key }, 'Provider selected');
      return resolved.provider;
    }

    throw new Error('No LLM providers available');
  }

  async completeWithMessages(
    options: CompletionOptions,
    capability?: string,
    taskCategory?: string,
    preferredModel?: string,
  ): Promise<LLMResponse> {
    // OTel span (no-op when tracing is disabled — zero runtime cost).
    // We wrap the whole call so retries / escalations / tool-use misses are
    // visible as a single span covering the logical "fabric turn" with
    // attributes for model + token usage. Finer-grained spans could be
    // added later if debugging requires.
    return withLLMSpan(
      {
        system: 'ollama',
        model: preferredModel ?? this.policy.getForceModel() ?? (this._lastUsedModel ?? 'auto'),
        capability,
        operation: 'chat',
        toolCount: options.tools?.length ?? 0,
      },
      () => this._completeWithMessagesInner(options, capability, taskCategory, preferredModel),
    );
  }

  private async _completeWithMessagesInner(
    options: CompletionOptions,
    capability?: string,
    taskCategory?: string,
    preferredModel?: string,
  ): Promise<LLMResponse> {
    const mode = this.policy.getMode();

    // Rough token estimate (4 chars ≈ 1 token) used for COMBINATION mode's
    // "context too large" → subscription escalation check.
    const estInputTokens = estimateInputTokens(options);

    // ── SUBSCRIPTION_ONLY: always route to the subscription provider. ──────
    if (mode === 'SUBSCRIPTION_ONLY') {
      const sub = this.providers.get('anthropic-subscription');
      if (sub) {
        this._lastUsedModel = 'claude-subscription';
        log.info({ reason: 'subscription_only' }, 'Routing to Claude subscription');
        return sub.complete({ messages: options.messages, systemPrompt: options.systemPrompt, tools: options.tools });
      }
      throw new Error('SUBSCRIPTION_ONLY mode active but no Claude subscription connected. Go to Models → Subscription Accounts → Connect Claude.');
    }

    // ── COMBINATION: escalate early if context exceeds local capacity. ─────
    if (mode === 'COMBINATION' && this.policy.shouldRouteToCloud(capability ?? 'text', 0, estInputTokens)) {
      const sub = this.providers.get('anthropic-subscription');
      if (sub) {
        this._lastUsedModel = 'claude-subscription';
        log.info({ estInputTokens, reason: 'context_overflow' }, 'Context too large for local — routing to Claude subscription');
        return sub.complete({ messages: options.messages, systemPrompt: options.systemPrompt, tools: options.tools });
      }
      // No subscription connected → fall through and attempt local anyway.
      log.warn({ estInputTokens }, 'Context overflow detected but no Claude subscription connected — attempting local');
    }

    // ── LOCAL path (LOCAL_ONLY or COMBINATION below thresholds) ────────────
    //
    // User-set forceModel from the Settings page wins over everything in the
    // local path. This is the explicit "I picked this model, use it" contract.
    // Falls through to normal routing only if the forced model isn't registered.
    const forceModel = this.policy.getForceModel();
    if (forceModel) {
      const forced = this.resolveProvider(forceModel);
      if (forced) {
        try {
          this._lastUsedModel = forceModel;
          log.info({ model: forceModel, reason: 'force_model' }, 'Using user-forced model (Settings → Default Model)');
          const response = await forced.provider.complete({
            messages: options.messages,
            systemPrompt: options.systemPrompt,
            tools: options.tools,
          });
          return response;
        } catch (err) {
          // If the forced model errors, don't silently fall back — surface it.
          log.error({ model: forceModel, err: (err as Error).message }, 'User-forced model failed');
          throw err;
        }
      }
      log.warn({ forceModel }, 'Force-model is set but unregistered — falling through to normal routing');
    }

    const selection = this.router.selectModel({
      capability: capability ?? 'text',
      taskCategory,
      preferredModel,
    });

    const chain = this.router.getFallbackChain(capability ?? 'text');
    const baseOrder = [selection.model, ...chain.filter(m => m !== selection.model)];
    const tryOrder = this.applyPersonalizationBias(baseOrder, taskCategory);

    // The last user message is the one whose tool-use expectations we judge.
    const lastUserMessage = [...options.messages].reverse().find(m => m.role === 'user')?.content ?? '';
    const availableToolNames = (options.tools ?? []).map(t => t.name);

    /**
     * Skip the tool-use detector when this completion is a FOLLOW-UP inside an
     * ongoing tool loop. Telltale sign: the conversation already contains at
     * least one tool_result (role === 'tool') OR an assistant message with
     * tool_calls. In that case the model's job here is to summarise what
     * just happened, not to issue new tool calls — and "no tool call" is a
     * valid reply. Running the detector on this would cause a false positive.
     */
    const isFollowUp = options.messages.some(
      m => m.role === 'tool' || (m.role === 'assistant' && Array.isArray(m.toolCalls) && m.toolCalls.length > 0),
    );

    let lastError: Error | null = null;
    let localFailures = 0;
    /**
     * Track tool-use misses across this invocation so we can (a) emit a
     * summarising miss event, (b) cap how many models we cycle through before
     * giving up, and (c) tell the performance store which models were weak
     * for this specific turn.
     */
    const toolUseMisses: Array<{ model: string; reason: string; detail: string }> = [];
    /** Cap how many sequential tool-use-miss retries we do per request. */
    const MAX_TOOL_USE_RETRIES = 2;
    let weakResponseBestCandidate: LLMResponse | null = null;
    let weakResponseBestModel: string | null = null;

    for (const modelId of tryOrder) {
      const resolved = this.resolveProvider(modelId);
      if (!resolved) continue;

      try {
        this._lastUsedModel = modelId;
        log.debug({ model: modelId, capability, reason: selection.reason }, 'Attempting completion');

        const response = await resolved.provider.complete({
          messages: options.messages,
          systemPrompt: options.systemPrompt,
          tools: options.tools,
        });

        // ── Semantic-quality check ─────────────────────────────────────
        // The provider returned 200, but did the model actually DO the work
        // when tools were required? Small models (e.g. qwen3:14b) sometimes
        // echo a tool call back as text instead of emitting a tool_use block.
        // If that happens AND we still have retry budget, move on to the next
        // model in the chain and record the weak outcome so the performance
        // store can demote this model for similar future requests.
        //
        // Skip this on follow-up iterations (tool already executed earlier in
        // this turn) — the model is supposed to emit a text summary there.
        if (availableToolNames.length > 0 && !isFollowUp) {
          const verdict = analyzeToolUse({
            userMessage: lastUserMessage,
            availableTools: availableToolNames,
            responseContent: response.content ?? '',
            toolCallCount: response.toolCalls?.length ?? 0,
          });

          // Record every verdict so performance store builds up signal over time.
          try {
            if (this._performanceStore && typeof (this._performanceStore as any).recordToolUseOutcome === 'function' && verdict.expectedToolUse) {
              (this._performanceStore as any).recordToolUseOutcome(
                modelId,
                capability ?? 'text',
                !verdict.toolUseMissed,
                verdict.toolUseMissed ? verdict.reason : undefined,
              );
            }
          } catch { /* non-critical */ }

          if (verdict.toolUseMissed) {
            toolUseMisses.push({ model: modelId, reason: verdict.reason, detail: verdict.detail });
            log.warn({ model: modelId, reason: verdict.reason, detail: verdict.detail }, 'Tool-use missed — escalating to next model');

            // Emit an observability event so the Logs tab can surface it.
            try {
              eventBus.emit('model.tool_use_miss', {
                model: modelId,
                capability: capability ?? 'text',
                reason: verdict.reason,
                detail: verdict.detail,
                userMessage: lastUserMessage.slice(0, 200),
                availableTools: availableToolNames,
                timestamp: Date.now(),
              } as any);
            } catch { /* bus optional */ }

            // Keep this response as a fallback in case no later model succeeds
            // (best-effort: prefer the one with the longest content).
            if (!weakResponseBestCandidate || (response.content?.length ?? 0) > (weakResponseBestCandidate.content?.length ?? 0)) {
              weakResponseBestCandidate = response;
              weakResponseBestModel = modelId;
            }

            // If we're within the retry budget, continue to the next model.
            if (toolUseMisses.length <= MAX_TOOL_USE_RETRIES) {
              continue;
            }
            // Exhausted tool-use retries — fall through to return the best we have.
            break;
          }
        }

        log.info({ model: modelId, capability, tokens: response.usage?.outputTokens }, 'Completion succeeded');
        return response;
      } catch (err) {
        lastError = err as Error;
        localFailures++;
        log.warn({ model: modelId, error: lastError.message }, 'Completion failed — trying next in chain');

        // COMBINATION: if we've now crossed the failure threshold, escalate to subscription.
        if (mode === 'COMBINATION' && this.policy.shouldRouteToCloud(capability ?? 'text', localFailures)) {
          const sub = this.providers.get('anthropic-subscription');
          if (sub) {
            this._lastUsedModel = 'claude-subscription';
            log.info({ localFailures, reason: 'failure_threshold' }, 'Local failure threshold reached — routing to Claude subscription');
            return sub.complete({ messages: options.messages, systemPrompt: options.systemPrompt, tools: options.tools });
          }
        }
      }
    }

    // If we got here having only seen weak tool-use responses (no hard errors),
    // return the best weak response we collected rather than failing.
    // The performance store has already recorded the misses — over time those
    // models will drift to the back of the ranking for this capability.
    if (weakResponseBestCandidate && weakResponseBestModel) {
      log.warn({
        attempted: toolUseMisses.map(m => m.model),
        finalModel: weakResponseBestModel,
      }, 'All chain models missed tool-use — returning best weak response');
      this._lastUsedModel = weakResponseBestModel;
      return weakResponseBestCandidate;
    }

    // All local models failed — try absolute default
    const fallback = this.resolveProvider();
    if (fallback) {
      log.warn({ key: fallback.key }, 'All chain models failed — trying default provider');
      this._lastUsedModel = fallback.key;
      return fallback.provider.complete({
        messages: options.messages,
        systemPrompt: options.systemPrompt,
        tools: options.tools,
      });
    }

    throw lastError ?? new Error('No LLM providers available');
  }

  async streamWithMessages(
    options: CompletionOptions,
    callbacks: StreamCallbacks,
    capability?: string,
    taskCategory?: string,
  ): Promise<LLMResponse> {
    const provider = this.getProvider(capability, taskCategory);
    // If provider supports streaming, use it; otherwise fall back to complete
    if (typeof (provider as any).stream === 'function') {
      return (provider as any).stream({
        messages: options.messages,
        systemPrompt: options.systemPrompt,
        tools: options.tools,
      }, callbacks);
    }
    // Fallback: complete then emit all at once
    const response = await provider.complete({
      messages: options.messages,
      systemPrompt: options.systemPrompt,
      tools: options.tools,
    });
    if (callbacks.onToken) callbacks.onToken(response.content);
    if (callbacks.onComplete) callbacks.onComplete(response as any);
    return response;
  }
}
