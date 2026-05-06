/**
 * Routing Policy — Runtime model-routing rules.
 *
 * Holds the mutable routing configuration used by ModelRouter / ModelFabric:
 *   - mode:                  LOCAL_ONLY (offline) or COMBINATION (local → cloud fallback)
 *   - capabilityPins:        per-capability hard override (e.g. { code: 'qwen3-coder:30b' })
 *   - failure thresholds:    when COMBINATION may escalate to cloud
 *
 * API endpoints (GET/POST /api/models/routing) read and mutate this instance
 * on the live ModelFabric. Changes are also persisted to ~/.agentx/config.json
 * under `routing` so they survive restarts.
 */
import type { RoutingMode } from './model-registry.js';

export interface RoutingPolicyConfig {
  mode: RoutingMode;
  /** Hard per-capability model override — bypasses fallback chains. */
  capabilityPins?: Record<string, string>;
  /**
   * Global hard override set from the Settings page. When populated, the
   * fabric uses this model for every LOCAL completion, ignoring the router's
   * capability-based choice, BuildIntelligence bias, personalization, and
   * per-capability pins. The user's explicit pick wins — this is the "I
   * know what I want, stop being clever" escape hatch.
   *
   * Null / undefined / empty string = Auto (normal routing applies).
   * Subscription mode still wins over forceModel because that's a different
   * axis of user intent (route to cloud, not local).
   */
  forceModel?: string | null;
  maxLocalFailuresBeforeCloud?: number;
  allowCloudForLatencySensitiveTasks?: boolean;
  latencySensitiveThresholdMs?: number;
  /**
   * In COMBINATION mode, escalate to the subscription provider when the
   * estimated input token count exceeds this threshold. Local models (even
   * large ones like llama3.1:70b-32k) have context limits; this lets very
   * long conversations / large contexts spill to Claude automatically.
   * Default: 28_000 tokens (below the 32k local ceiling, with safety margin).
   */
  contextOverflowTokens?: number;
}

export const DEFAULT_ROUTING_POLICY_CONFIG: RoutingPolicyConfig = {
  mode: 'LOCAL_ONLY',
};

export class RoutingPolicy {
  public config: RoutingPolicyConfig;

  constructor(config: Partial<RoutingPolicyConfig> = {}) {
    this.config = { ...DEFAULT_ROUTING_POLICY_CONFIG, ...config };
  }

  getMode(): RoutingMode { return this.config.mode; }

  setMode(mode: RoutingMode): void {
    this.config = { ...this.config, mode };
  }

  getConfig(): RoutingPolicyConfig {
    // Return a shallow clone so callers can't mutate internal state directly.
    return { ...this.config, capabilityPins: { ...(this.config.capabilityPins ?? {}) } };
  }

  getCapabilityPin(capability: string): string | undefined {
    return this.config.capabilityPins?.[capability];
  }

  /** Current global force-model override, or null when auto. */
  getForceModel(): string | null {
    const v = this.config.forceModel;
    return (typeof v === 'string' && v.trim().length > 0) ? v : null;
  }

  /** Set or clear the force-model override. Pass null / '' / 'auto' to clear. */
  setForceModel(model: string | null | undefined): void {
    if (!model || model === 'auto' || model.trim().length === 0) {
      this.config = { ...this.config, forceModel: null };
    } else {
      this.config = { ...this.config, forceModel: model.trim() };
    }
  }

  /**
   * Replace (not merge) the capability-pin map.
   * Pass {} to clear all pins.
   */
  setCapabilityPins(pins: Record<string, string>): void {
    // Drop empty-string / null values so "Auto" (no pin) is represented by absence.
    const cleaned: Record<string, string> = {};
    for (const [cap, model] of Object.entries(pins)) {
      if (typeof model === 'string' && model.trim().length > 0) {
        cleaned[cap] = model.trim();
      }
    }
    this.config = { ...this.config, capabilityPins: cleaned };
  }

  /**
   * Decide whether a given request should bypass local models and go
   * straight to the subscription-backed cloud provider.
   *
   * COMBINATION semantics (per user spec): local LLM first, escalate to
   * Claude subscription when:
   *   - the task repeatedly fails locally (maxLocalFailuresBeforeCloud), OR
   *   - the estimated input token count exceeds contextOverflowTokens.
   *
   * `estimatedInputTokens` is optional — callers without a token estimate
   * can omit it and only the failure-count path will apply.
   */
  shouldRouteToCloud(
    _capability: string,
    _localFailures: number,
    estimatedInputTokens?: number,
  ): boolean {
    // SUBSCRIPTION_ONLY — always route to the subscription-backed provider.
    if (this.config.mode === 'SUBSCRIPTION_ONLY') return true;
    if (this.config.mode === 'LOCAL_ONLY') return false;

    // COMBINATION: context-size escalation.
    const overflow = this.config.contextOverflowTokens ?? 28_000;
    if (typeof estimatedInputTokens === 'number' && estimatedInputTokens > overflow) {
      return true;
    }

    // COMBINATION: failure-count escalation.
    return (_localFailures ?? 0) >= (this.config.maxLocalFailuresBeforeCloud ?? 3);
  }
}
