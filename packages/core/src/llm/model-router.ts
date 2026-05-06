/**
 * Model Router — Capability-based routing with fallback chains.
 * Routes requests to the appropriate model based on task capability.
 */
import { createLogger } from '../logger.js';
import type { LLMModelRegistry, ModelCapability, RegisteredModel } from './model-registry.js';
import type { RoutingPolicy } from './routing-policy.js';

const log = createLogger('llm:router');

export interface ModelSelectionRequest {
  capability: string;
  taskCategory?: string;
  preferredModel?: string;
}

export interface ModelSelectionResult {
  provider: string;
  model: string;
  reason: string;
}

/**
 * Richer selection result returned by `selectModelWithReason`. The API layer
 * consumes the `model` field as a RegisteredModel-like object so it can surface
 * provider + specialization alongside the chosen model id.
 */
export interface ModelSelectionWithReasonResult {
  model: {
    model: string;
    provider: string;
    specialization?: string;
  };
  reason: string;
  performanceScore?: number;
}

/**
 * Default fallback chains — used when config doesn't specify them.
 *
 * Updated April 2026 based on BFCL v4 / τ-bench data:
 *   - Tool-call specialist `xLAM-2` added to `code` chain at slot 2, so that
 *     when qwen3-coder:30b misses a tool call (parallel-call weakness on
 *     BFCL v3: 0.375), the fabric's auto-escalation jumps straight to a
 *     purpose-built function-calling model.
 *   - `reasoning` upgraded: llama3.3:70b (405B-class quality, native parallel
 *     calls) replaces llama3.1:70b-32k as primary. 3.1 kept as a warm fallback.
 *   - `text` upgraded: qwen3:30b-a3b MoE (July 2025 instruct) replaces
 *     qwen3:14b as primary — better reasoning at similar active-param cost.
 *
 * `qwen3-vl:32b` (vision) and the local qwen3-TTS service (separate, port
 * 9880) are explicitly untouched.
 */
const DEFAULT_FALLBACK_CHAINS: Record<string, string[]> = {
  code: [
    'qwen3-coder:30b',
    'robbiemu/Salesforce_Llama-xLAM-2:8b-fc-r-q5_K_M',
    'qwen2.5-coder:32b',
    'codestral:22b',
    'deepseek-coder-v2:16b',
    'llama3.1:8b',
  ],
  reasoning: [
    'llama3.3:70b-instruct-q4_K_M',
    'qwen3:30b-a3b-instruct-2507-q4_K_M',
    'llama3.1:70b-32k',
    'qwen3:14b',
    'qwen3-coder:30b',
  ],
  text: [
    'qwen3:30b-a3b-instruct-2507-q4_K_M',
    'qwen3:14b',
    'llama3.1:8b',
    'qwen3-coder:30b',
  ],
  vision: ['qwen3-vl:32b'],
};

export class ModelRouter {
  private fallbackChains: Record<string, string[]>;

  constructor(
    private registry: LLMModelRegistry,
    private policy: RoutingPolicy,
    fallbackChains?: Record<string, string[]>,
  ) {
    this.fallbackChains = fallbackChains ?? DEFAULT_FALLBACK_CHAINS;
  }

  /** Public accessor for the underlying model registry. */
  getRegistry(): LLMModelRegistry {
    return this.registry;
  }

  /**
   * Set fallback chains from config (e.g., parsed from default.yaml routing.fallbackChains).
   */
  setFallbackChains(chains: Record<string, string[]>): void {
    this.fallbackChains = chains;
    log.info({ capabilities: Object.keys(chains) }, 'Fallback chains configured');
  }

  /**
   * Select the best model for a given capability, respecting fallback chains
   * and available (registered) models.
   */
  selectModel(request: ModelSelectionRequest): ModelSelectionResult {
    // 1. Honour explicit preferred model
    if (request.preferredModel) {
      const models = this.registry.getModels();
      const match = models.find(m => m.id === request.preferredModel);
      if (match) {
        return { provider: match.provider, model: match.id, reason: 'preferred' };
      }
    }

    // 1b. Honour capability pin from the policy (hard user override).
    const pinned = this.policy.getCapabilityPin(request.capability);
    if (pinned) {
      const models = this.registry.getModels();
      const match = models.find(m => m.id === pinned);
      if (match) {
        log.debug({ capability: request.capability, model: pinned }, 'Routed via capability pin');
        return { provider: match.provider, model: match.id, reason: 'capability_pin' };
      }
      log.warn({ capability: request.capability, pinned }, 'Capability pin refers to unregistered model — falling back');
    }

    // 2. Walk the fallback chain for the requested capability
    const capability = request.capability as ModelCapability;
    const chain = this.fallbackChains[capability];
    if (chain && chain.length > 0) {
      const registeredIds = new Set(this.registry.getModels().map(m => m.id));
      for (const modelId of chain) {
        if (registeredIds.has(modelId)) {
          log.debug({ capability, model: modelId }, 'Routed via fallback chain');
          return { provider: 'ollama', model: modelId, reason: `chain:${capability}` };
        }
      }
      // No chain model registered — return first in chain as best-effort
      log.warn({ capability, chain }, 'No chain model registered — returning first');
      return { provider: 'ollama', model: chain[0], reason: `chain:${capability}:unregistered` };
    }

    // 3. Capability-based lookup from registry
    const byCapability = this.registry.getModelsByCapability(capability);
    if (byCapability.length > 0) {
      return { provider: byCapability[0].provider, model: byCapability[0].id, reason: `registry:${capability}` };
    }

    // 4. Absolute fallback — first registered model
    const models = this.registry.getModels();
    if (models.length > 0) {
      return { provider: models[0].provider, model: models[0].id, reason: 'fallback' };
    }

    return { provider: 'ollama', model: 'default', reason: 'no-models' };
  }

  /**
   * Get the full fallback chain for a capability (for failure retry).
   */
  getFallbackChain(capability: string): string[] {
    return this.fallbackChains[capability] ?? [];
  }

  /**
   * Convenience wrapper over `selectModel` that attaches a specialization field
   * when available. Returns null if no model can be chosen. Used by the UI
   * (`GET /api/models/routing`) to render the live per-capability routing table.
   */
  selectModelWithReason(request: ModelSelectionRequest): ModelSelectionWithReasonResult | null {
    try {
      const result = this.selectModel(request);
      if (!result || !result.model) return null;

      const models = this.registry.getModels();
      const match = models.find(m => m.id === result.model) as (RegisteredModel & { specialization?: string }) | undefined;

      return {
        model: {
          model: result.model,
          provider: result.provider,
          ...(match && (match as any).specialization ? { specialization: (match as any).specialization } : {}),
        },
        reason: result.reason,
      };
    } catch {
      return null;
    }
  }

  /**
   * Accessor for the routing policy (used by API/UI to read current pins + mode).
   */
  getPolicy(): RoutingPolicy {
    return this.policy;
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      fallbackChains: this.fallbackChains,
      registeredModels: this.registry.getModels().map(m => m.id),
    };
  }
}
