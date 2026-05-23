/**
 * ModelRoutingEngine — Batch 3 real routing decision.
 *
 * Inputs: task classification, runtime settings (pins/preferred/disabled,
 * localOnly), tool reliability snapshot, model latency history.
 *
 * Outputs: { model, provider, reason, fallbackChain, pinUsed }.
 *
 * Rules (in order — first matching wins):
 *   1. Pinned for this task → use pin (unless pin is in disabled list,
 *      in which case fall through with a note).
 *   2. localOnly enforcement: only consider local-provider models.
 *   3. Preferred-models list (in order): use first not-disabled, not-broken.
 *   4. Default model from agent config.
 *
 * Fallback chain: the candidates that were considered but lost the decision.
 */

import type { TaskClassification, TaskType } from './task-classifier.js';

export interface RoutingInputs {
  classification: TaskClassification;
  defaultProvider: string;
  defaultModel: string;
  pins: Partial<Record<TaskType, string>>;
  preferredModels: string[];
  disabledModels: string[];
  localOnly: boolean;
  installedLocalModels: string[];
  /** True if reliability-aware mode is on. When on, the engine consults
   *  perModelHealth and demotes models whose recent p95 latency exceeds
   *  the threshold (Batch 6 telemetry-driven intelligence). */
  reliabilityAware: boolean;
  /** Per-model recent health derived from TelemetryStore. Models whose
   *  p95Latency exceeds slowThresholdMs and have totalCalls >= minCalls
   *  are treated as degraded. */
  perModelHealth?: Record<string, { totalCalls: number; p95LatencyMs: number; successRate: number }>;
  /** A model with p95 latency above this many ms is demoted. Default 15000. */
  slowThresholdMs?: number;
  /** Minimum total calls before demotion is considered. Default 5. */
  minCallsForDemotion?: number;
  /** Batch 8E — workflow-success-aware routing input. When recent
   *  autonomous workflow success rate is low, the engine annotates
   *  the decision reason so the operator sees that the runtime is
   *  currently struggling. Future batches may use this to bias
   *  toward smaller / faster models. */
  workflowReliability?: { totalCompleted: number; successRate: number } | null;
  /** Batch 10 — provider evidence input. When a ProviderBenchmarkStore
   *  comparison for the current task category has a clear winner that
   *  is NOT the default provider, the engine promotes that provider
   *  for this call. Requires:
   *    - reliabilityAware = true
   *    - winner !== current default provider
   *    - winner is among the providers in `availableProviders`
   *    - user has NOT pinned a model (pins override evidence)
   *  Recorded reason: "provider promoted via benchmark: ${reason}". */
  providerEvidence?: {
    winner: string | null;
    reasons: string[];
    perProvider: Array<{ provider: string; samples: number; avgScore: number }>;
  } | null;
  /** Providers available locally. The engine only considers candidates
   *  in this set when promoting via evidence. */
  availableProviders?: string[];
  /** Optional override map: provider name → default model when promotion
   *  fires (e.g. omlx → "mlx-community/Llama-3.2-3B-Instruct-4bit"). */
  providerDefaultModel?: Record<string, string>;
}

export interface RoutingDecision {
  model: string;
  provider: string;
  reason: string;
  pinUsed: boolean;
  fallbackChain: Array<{ model: string; skipped: string }>;
  taskType: TaskType;
  classificationConfidence: number;
}

const LOCAL_PROVIDERS = new Set(['ollama', 'local', 'llama-cpp']);

/** True when telemetry says this model has been consistently slow/failing
 *  and we should prefer something else. Pure helper — no side effects. */
function isDegradedByTelemetry(model: string, inputs: RoutingInputs): { degraded: boolean; reason?: string } {
  if (!inputs.reliabilityAware) return { degraded: false };
  if (!inputs.perModelHealth) return { degraded: false };
  const h = inputs.perModelHealth[`${inputs.defaultProvider}:${model}`] ?? inputs.perModelHealth[model];
  if (!h) return { degraded: false };
  const min = inputs.minCallsForDemotion ?? 5;
  if (h.totalCalls < min) return { degraded: false };
  const threshold = inputs.slowThresholdMs ?? 15000;
  if (h.p95LatencyMs > threshold) {
    return { degraded: true, reason: `telemetry: p95 ${h.p95LatencyMs}ms exceeds ${threshold}ms over ${h.totalCalls} call(s)` };
  }
  if (h.successRate < 0.5 && h.totalCalls >= min) {
    return { degraded: true, reason: `telemetry: successRate ${Math.round(h.successRate * 100)}% over ${h.totalCalls} call(s)` };
  }
  return { degraded: false };
}

export function decideRoute(inputs: RoutingInputs): RoutingDecision {
  const fallbackChain: Array<{ model: string; skipped: string }> = [];
  const t = inputs.classification.primary;

  // 1. Per-task pin
  const pinned = inputs.pins[t];
  if (pinned) {
    if (inputs.disabledModels.includes(pinned)) {
      fallbackChain.push({ model: pinned, skipped: 'disabled' });
    } else if (inputs.localOnly && inputs.installedLocalModels.length > 0 && !inputs.installedLocalModels.includes(pinned)) {
      fallbackChain.push({ model: pinned, skipped: `localOnly: ${pinned} not installed locally` });
    } else {
      const degr = isDegradedByTelemetry(pinned, inputs);
      if (degr.degraded) {
        fallbackChain.push({ model: pinned, skipped: degr.reason ?? 'telemetry-degraded' });
      } else {
        return {
          model: pinned,
          provider: inputs.defaultProvider,
          reason: `pinned via Models page for task '${t}'`,
          pinUsed: true,
          fallbackChain,
          taskType: t,
          classificationConfidence: inputs.classification.confidence,
        };
      }
    }
  }

  // 2. Preferred-models list (first that survives filters)
  for (const m of inputs.preferredModels) {
    if (inputs.disabledModels.includes(m)) {
      fallbackChain.push({ model: m, skipped: 'disabled' });
      continue;
    }
    if (inputs.localOnly && inputs.installedLocalModels.length > 0 && !inputs.installedLocalModels.includes(m)) {
      fallbackChain.push({ model: m, skipped: 'localOnly: not installed' });
      continue;
    }
    const degr = isDegradedByTelemetry(m, inputs);
    if (degr.degraded) {
      fallbackChain.push({ model: m, skipped: degr.reason ?? 'telemetry-degraded' });
      continue;
    }
    return {
      model: m,
      provider: inputs.defaultProvider,
      reason: `preferred-list pick for task '${t}'`,
      pinUsed: false,
      fallbackChain,
      taskType: t,
      classificationConfidence: inputs.classification.confidence,
    };
  }

  // 3. Default — but verify it isn't disabled.
  if (inputs.disabledModels.includes(inputs.defaultModel)) {
    fallbackChain.push({ model: inputs.defaultModel, skipped: 'disabled (default)' });
    // No good options — return default anyway, but flag the reason honestly.
    return {
      model: inputs.defaultModel,
      provider: inputs.defaultProvider,
      reason: `default model is in disabled list — using anyway; configure preferred-models to override`,
      pinUsed: false,
      fallbackChain,
      taskType: t,
      classificationConfidence: inputs.classification.confidence,
    };
  }

  // 4. localOnly + we have installed-list info, prefer first installed.
  if (inputs.localOnly && LOCAL_PROVIDERS.has(inputs.defaultProvider) && inputs.installedLocalModels.length > 0 && !inputs.installedLocalModels.includes(inputs.defaultModel)) {
    const first = inputs.installedLocalModels.find((m) => !inputs.disabledModels.includes(m));
    if (first) {
      fallbackChain.push({ model: inputs.defaultModel, skipped: 'localOnly: not installed locally' });
      return {
        model: first,
        provider: inputs.defaultProvider,
        reason: `localOnly fallback to first installed local model for task '${t}'`,
        pinUsed: false,
        fallbackChain,
        taskType: t,
        classificationConfidence: inputs.classification.confidence,
      };
    }
  }

  // Batch 10 — evidence-based provider promotion. ONLY fires when:
  //   - reliabilityAware is on
  //   - no pin / preferred matched (we're in the default branch)
  //   - benchmark has a clear winner AND it's not the current default
  //   - winner is in availableProviders
  // Promotion swaps to the winning provider's default model.
  if (
    inputs.reliabilityAware
    && inputs.providerEvidence
    && inputs.providerEvidence.winner
    && inputs.providerEvidence.winner !== inputs.defaultProvider
    && (inputs.availableProviders ?? []).includes(inputs.providerEvidence.winner)
  ) {
    const newProvider = inputs.providerEvidence.winner;
    const newModel = inputs.providerDefaultModel?.[newProvider] ?? inputs.defaultModel;
    const promotionReason = inputs.providerEvidence.reasons.join(' · ');
    return {
      model: newModel,
      provider: newProvider,
      reason: `provider promoted via benchmark for task '${t}': ${promotionReason}`,
      pinUsed: false,
      fallbackChain: [
        ...fallbackChain,
        { model: inputs.defaultModel, skipped: `provider demoted: benchmark winner is ${newProvider}` },
      ],
      taskType: t,
      classificationConfidence: inputs.classification.confidence,
    };
  }

  // Batch 8E — append a workflow-success annotation when the data is
  // available so the operator sees runtime-level health in the routing
  // reason. This is informational only; it does not change which model
  // is chosen.
  const baseReason = inputs.reliabilityAware
    ? `default routing (reliability-aware mode on) for task '${t}'`
    : `default routing for task '${t}'`;
  const reasonWithWf = inputs.workflowReliability
    ? `${baseReason} · workflow recent success ${Math.round(inputs.workflowReliability.successRate * 100)}% over ${inputs.workflowReliability.totalCompleted}`
    : baseReason;
  return {
    model: inputs.defaultModel,
    provider: inputs.defaultProvider,
    reason: reasonWithWf,
    pinUsed: false,
    fallbackChain,
    taskType: t,
    classificationConfidence: inputs.classification.confidence,
  };
}
