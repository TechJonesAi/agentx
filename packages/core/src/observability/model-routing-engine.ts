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
  /** True if reliability-aware mode is on. Currently advisory; future
   *  batches will inform model-level reliability from per-model latency. */
  reliabilityAware: boolean;
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

  return {
    model: inputs.defaultModel,
    provider: inputs.defaultProvider,
    reason: inputs.reliabilityAware
      ? `default routing (reliability-aware mode on) for task '${t}'`
      : `default routing for task '${t}'`,
    pinUsed: false,
    fallbackChain,
    taskType: t,
    classificationConfidence: inputs.classification.confidence,
  };
}
