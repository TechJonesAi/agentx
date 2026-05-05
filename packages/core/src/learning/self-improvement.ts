/**
 * Self-Improvement Service — Phase 12
 *
 * Enables AgentX to automatically tune its own decision thresholds
 * based on observed outcomes, while remaining safe, bounded, and reversible.
 *
 * Architecture:
 * 1. AUTO-TUNING ENGINE — analyses outcomes, adjusts parameters within bounds
 * 2. CONTROLLED A/B — validates changes before promotion
 * 3. SELF-EVALUATION LOOP — classifies each build and feeds learning
 * 4. CONFIG EVOLUTION — versioned configs with rollback
 * 5. SAFETY GUARDS — automatic rollback on degradation
 * 6. PERSONALIZATION-AWARE — global tuning only, user bias layer untouched
 * 7. DIAGNOSTICS — full visibility into tuning state
 */

import type { GlobalLearningService } from './global-learning.js';
import type { IntelligenceConfig } from './build-intelligence.js';
import { DEFAULT_INTELLIGENCE_CONFIG } from './build-intelligence.js';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** Bounds for a single tunable parameter. */
export interface ParameterBounds {
  min: number;
  max: number;
  step: number;
}

/** All tunable parameters with their bounds. */
export type TunableBoundsMap = Record<string, ParameterBounds>;

/** A versioned configuration snapshot. */
export interface ConfigVersion {
  version: number;
  config: Partial<IntelligenceConfig>;
  created_at: number;
  promoted_at: number | null;
  rolled_back: boolean;
  metrics_at_creation: ConfigMetrics;
  metrics_at_promotion: ConfigMetrics | null;
  source: 'initial' | 'auto_tune' | 'rollback' | 'manual';
}

/** Metrics snapshot for comparing config versions. */
export interface ConfigMetrics {
  success_rate: number;
  failure_rate: number;
  avg_retry_count: number;
  total_decisions: number;
  evidence_count: number;
  timestamp: number;
}

/** Result of a self-evaluation after a build. */
export interface BuildEvaluation {
  build_id: string;
  classification: 'success' | 'partial' | 'failure';
  expected_outcome: 'success' | 'unknown';
  actual_outcome: 'success' | 'partial' | 'failure';
  metrics: {
    total_tasks: number;
    succeeded_tasks: number;
    failed_tasks: number;
    retries_used: number;
    intelligence_decisions: number;
  };
  config_version: number;
  timestamp: number;
}

/** Tuning adjustment proposal. */
export interface TuningProposal {
  parameter: string;
  current_value: number;
  proposed_value: number;
  reason: string;
  evidence_count: number;
  confidence: number;
}

/** Safety guard status. */
export interface SafetyStatus {
  safe: boolean;
  reason: string | null;
  cooldown_until: number | null;
  rollback_triggered: boolean;
  consecutive_degradations: number;
}

/** Comprehensive diagnostics. */
export interface ImprovementDiagnostics {
  current_version: number;
  active_config: Partial<IntelligenceConfig>;
  version_history: ConfigVersion[];
  recent_evaluations: BuildEvaluation[];
  pending_proposals: TuningProposal[];
  safety_status: SafetyStatus;
  ab_status: { enabled: boolean; baseline_ratio: number; sample_count: number } | null;
  improvement_trend: { versions_tested: number; promotions: number; rollbacks: number };
}

/** Self-improvement configuration. */
export interface SelfImprovementConfig {
  /** Learning rate for parameter smoothing. Range [0.01, 0.5]. Default: 0.1. */
  learningRate: number;
  /** Minimum sample size for A/B decisions. Default: 20. */
  minABSamples: number;
  /** Success rate drop (absolute) that triggers rollback. Default: 0.10. */
  rollbackThreshold: number;
  /** Error rate spike multiplier that triggers rollback. Default: 2.0. */
  errorSpikeMultiplier: number;
  /** Cooldown period in ms after rollback before next tuning. Default: 300_000 (5 min). */
  cooldownMs: number;
  /** Maximum tuning proposals per cycle. Default: 3. */
  maxProposalsPerCycle: number;
  /** Minimum evaluations before tuning starts. Default: 10. */
  minEvaluationsForTuning: number;
  /** A/B baseline ratio when running experiments. Default: 0.20. */
  experimentBaselineRatio: number;
}

export const DEFAULT_SELF_IMPROVEMENT_CONFIG: SelfImprovementConfig = {
  learningRate: 0.1,
  minABSamples: 20,
  rollbackThreshold: 0.10,
  errorSpikeMultiplier: 2.0,
  cooldownMs: 300_000,
  maxProposalsPerCycle: 3,
  minEvaluationsForTuning: 10,
  experimentBaselineRatio: 0.20,
};

/** Default bounds for all tunable IntelligenceConfig parameters. */
export const DEFAULT_TUNABLE_BOUNDS: TunableBoundsMap = {
  minEvidence:              { min: 1,    max: 20,   step: 1    },
  successMargin:            { min: 0.02, max: 0.50, step: 0.02 },
  protectionFailureRate:    { min: 0.20, max: 0.90, step: 0.05 },
  protectionMinOutcomes:    { min: 1,    max: 20,   step: 1    },
  blockerMinOccurrences:    { min: 1,    max: 10,   step: 1    },
  defaultSinceDays:         { min: 7,    max: 90,   step: 7    },
  modelAvoidThreshold:      { min: 0.10, max: 0.60, step: 0.05 },
  recommendationConfidence: { min: 0.20, max: 0.90, step: 0.05 },
  decayHalfLifeDays:        { min: 3,    max: 60,   step: 1    },
};

const SUBSYSTEM = 'self_improvement' as const;

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class SelfImprovementService {
  private learning: GlobalLearningService;
  private config: SelfImprovementConfig;
  private bounds: TunableBoundsMap;

  private versions: ConfigVersion[] = [];
  private evaluations: BuildEvaluation[] = [];
  private proposals: TuningProposal[] = [];
  private safetyStatus: SafetyStatus = {
    safe: true,
    reason: null,
    cooldown_until: null,
    rollback_triggered: false,
    consecutive_degradations: 0,
  };

  constructor(
    learning: GlobalLearningService,
    config?: Partial<SelfImprovementConfig>,
    bounds?: Partial<TunableBoundsMap>,
  ) {
    this.learning = learning;
    this.config = { ...DEFAULT_SELF_IMPROVEMENT_CONFIG, ...config };
    this.bounds = { ...DEFAULT_TUNABLE_BOUNDS, ...(bounds as TunableBoundsMap) };
    this.hydrateState();
    // Ensure at least version 0 (initial)
    if (this.versions.length === 0) {
      this.createVersion({ ...DEFAULT_INTELLIGENCE_CONFIG }, 'initial');
    }
  }

  getConfig(): Readonly<SelfImprovementConfig> {
    return this.config;
  }

  getBounds(): Readonly<TunableBoundsMap> {
    return this.bounds;
  }

  /* ================================================================== */
  /*  1. Auto-Tuning Engine                                              */
  /* ================================================================== */

  /**
   * Analyse recent outcomes and generate tuning proposals.
   * Does NOT apply changes — call promoteProposal() to apply.
   */
  generateProposals(): TuningProposal[] {
    this.proposals = [];

    // Safety check: in cooldown or insufficient data
    if (!this.canTune()) return [];

    const current = this.getCurrentConfig();
    const recentEvals = this.evaluations.slice(-50);
    if (recentEvals.length < this.config.minEvaluationsForTuning) return [];

    const successRate = this.computeSuccessRate(recentEvals);
    const retryRate = this.computeAvgRetries(recentEvals);

    // Strategy effectiveness analysis from learning store
    const stratStats = this.learning.getStrategyStats('build', 'general', 'strategy', current.defaultSinceDays ?? 30);
    const modelStats = this.learning.getStrategyStats('build', 'general', 'model', current.defaultSinceDays ?? 30);

    let count = 0;

    // Proposal: adjust minEvidence based on data volume
    if (count < this.config.maxProposalsPerCycle) {
      const totalEvidence = stratStats.reduce((s, v) => s + v.total, 0) + modelStats.reduce((s, v) => s + v.total, 0);
      if (totalEvidence > 100 && (current.minEvidence ?? 3) < 5) {
        this.addProposal('minEvidence', current.minEvidence ?? 3, 5,
          `High evidence volume (${totalEvidence}) — raising minEvidence for more reliable recommendations`,
          totalEvidence, 0.7);
        count++;
      } else if (totalEvidence < 20 && (current.minEvidence ?? 3) > 2) {
        this.addProposal('minEvidence', current.minEvidence ?? 3, 2,
          `Low evidence volume (${totalEvidence}) — lowering minEvidence to start recommending sooner`,
          totalEvidence, 0.5);
        count++;
      }
    }

    // Proposal: adjust modelAvoidThreshold based on model performance
    if (count < this.config.maxProposalsPerCycle && modelStats.length > 0) {
      const worstRate = Math.min(...modelStats.filter(s => s.total >= 3).map(s => s.success_rate));
      const currentThreshold = current.modelAvoidThreshold ?? 0.30;
      if (!isNaN(worstRate) && worstRate > currentThreshold + 0.10) {
        const proposed = this.smoothAdjust(currentThreshold, worstRate - 0.05, 'modelAvoidThreshold');
        if (proposed !== currentThreshold) {
          this.addProposal('modelAvoidThreshold', currentThreshold, proposed,
            `Worst model success rate is ${(worstRate * 100).toFixed(0)}% — raising avoidance threshold`,
            modelStats.reduce((s, v) => s + v.total, 0), 0.6);
          count++;
        }
      }
    }

    // Proposal: adjust successMargin if one action clearly dominates
    if (count < this.config.maxProposalsPerCycle && stratStats.length >= 2) {
      const sorted = [...stratStats].sort((a, b) => b.success_rate - a.success_rate);
      const gap = sorted[0].success_rate - sorted[1].success_rate;
      const currentMargin = current.successMargin ?? 0.10;
      if (gap > 0.30 && currentMargin > 0.05) {
        const proposed = this.smoothAdjust(currentMargin, 0.05, 'successMargin');
        this.addProposal('successMargin', currentMargin, proposed,
          `Large strategy gap (${(gap * 100).toFixed(0)}%) — lowering margin to exploit clear winner faster`,
          sorted[0].total + sorted[1].total, 0.65);
        count++;
      } else if (gap < 0.05 && currentMargin < 0.15) {
        const proposed = this.smoothAdjust(currentMargin, 0.15, 'successMargin');
        this.addProposal('successMargin', currentMargin, proposed,
          `Strategies nearly equal (${(gap * 100).toFixed(0)}% gap) — raising margin to avoid noisy switches`,
          sorted[0].total + sorted[1].total, 0.55);
        count++;
      }
    }

    // Proposal: reduce defaultSinceDays if evidence is mostly stale
    if (count < this.config.maxProposalsPerCycle) {
      const events = this.learning.queryEvents({ subsystem: 'build', since_days: current.defaultSinceDays ?? 30, limit: 1000 });
      const now = Date.now();
      const halfLife = current.decayHalfLifeDays ?? 14;
      const stale = events.filter(e => (now - new Date(e.created_at).getTime()) / 86_400_000 > halfLife).length;
      if (events.length > 20 && stale / events.length > 0.7) {
        const currentDays = current.defaultSinceDays ?? 30;
        const proposed = this.smoothAdjust(currentDays, Math.max(halfLife * 2, 14), 'defaultSinceDays');
        if (proposed !== currentDays) {
          this.addProposal('defaultSinceDays', currentDays, proposed,
            `${((stale / events.length) * 100).toFixed(0)}% of evidence is stale — tightening lookback window`,
            events.length, 0.6);
          count++;
        }
      }
    }

    // Proposal: adjust retry-related signals (protectionFailureRate)
    if (count < this.config.maxProposalsPerCycle && retryRate > 3) {
      const currentPFR = current.protectionFailureRate ?? 0.50;
      if (currentPFR > 0.30) {
        const proposed = this.smoothAdjust(currentPFR, currentPFR - 0.05, 'protectionFailureRate');
        this.addProposal('protectionFailureRate', currentPFR, proposed,
          `High average retries (${retryRate.toFixed(1)}) — lowering protection threshold to catch failing files sooner`,
          recentEvals.length, 0.5);
        count++;
      }
    }

    return [...this.proposals];
  }

  /**
   * Apply a specific tuning proposal, creating a new config version.
   * Returns the new version number, or null if safety blocked.
   */
  applyProposal(proposal: TuningProposal): number | null {
    if (!this.canTune()) return null;

    const current = this.getCurrentConfig();
    const newConfig = { ...current, [proposal.parameter]: proposal.proposed_value };
    const version = this.createVersion(newConfig, 'auto_tune');
    this.persistState();
    return version.version;
  }

  /* ================================================================== */
  /*  2. Controlled A/B Optimisation                                     */
  /* ================================================================== */

  /**
   * Start an A/B experiment comparing current config vs a proposed version.
   * Returns the experiment baseline ratio to configure in BuildIntelligenceService.
   */
  startExperiment(): number {
    if (!this.canTune()) return 0;
    return this.config.experimentBaselineRatio;
  }

  /**
   * Evaluate A/B experiment results.
   * Returns whether the experimental (intelligence) config should be promoted.
   */
  evaluateExperiment(
    intelligenceSuccesses: number,
    intelligenceTotal: number,
    baselineSuccesses: number,
    baselineTotal: number,
  ): { promote: boolean; reason: string; confidence: number } {
    const totalSamples = intelligenceTotal + baselineTotal;

    // Not enough data
    if (totalSamples < this.config.minABSamples) {
      return {
        promote: false,
        reason: `Insufficient samples: ${totalSamples}/${this.config.minABSamples}`,
        confidence: 0,
      };
    }

    const intelRate = intelligenceTotal > 0 ? intelligenceSuccesses / intelligenceTotal : 0;
    const baseRate = baselineTotal > 0 ? baselineSuccesses / baselineTotal : 0;

    // Wilson score lower bounds for conservative comparison
    const intelLower = this.wilsonLower(intelligenceSuccesses, intelligenceTotal);
    const baseLower = this.wilsonLower(baselineSuccesses, baselineTotal);

    // Promote only if intelligence lower bound > baseline lower bound
    if (intelLower > baseLower) {
      const confidence = Math.min((intelLower - baseLower) * 5, 1.0);
      return {
        promote: true,
        reason: `Intelligence (${(intelRate * 100).toFixed(1)}%) > baseline (${(baseRate * 100).toFixed(1)}%), Wilson lower: ${intelLower.toFixed(3)} > ${baseLower.toFixed(3)}`,
        confidence,
      };
    }

    return {
      promote: false,
      reason: `No significant improvement: intelligence Wilson=${intelLower.toFixed(3)}, baseline Wilson=${baseLower.toFixed(3)}`,
      confidence: Math.max(0, (intelLower - baseLower) * 5),
    };
  }

  /**
   * Promote a config version (mark as promoted with metrics).
   */
  promoteVersion(versionNum: number): boolean {
    const version = this.versions.find(v => v.version === versionNum);
    if (!version) return false;
    version.promoted_at = Date.now();
    version.metrics_at_promotion = this.captureCurrentMetrics();
    this.persistState();
    return true;
  }

  /* ================================================================== */
  /*  3. Self-Evaluation Loop                                            */
  /* ================================================================== */

  /**
   * Evaluate a completed build and feed into the learning systems.
   */
  evaluateBuild(input: {
    build_id: string;
    total_tasks: number;
    succeeded_tasks: number;
    failed_tasks: number;
    retries_used: number;
    intelligence_decisions: number;
  }): BuildEvaluation {
    const succeededRatio = input.total_tasks > 0 ? input.succeeded_tasks / input.total_tasks : 0;

    let classification: BuildEvaluation['classification'];
    if (succeededRatio >= 1.0) classification = 'success';
    else if (succeededRatio >= 0.5) classification = 'partial';
    else classification = 'failure';

    const evaluation: BuildEvaluation = {
      build_id: input.build_id,
      classification,
      expected_outcome: 'success',
      actual_outcome: classification,
      metrics: {
        total_tasks: input.total_tasks,
        succeeded_tasks: input.succeeded_tasks,
        failed_tasks: input.failed_tasks,
        retries_used: input.retries_used,
        intelligence_decisions: input.intelligence_decisions,
      },
      config_version: this.getCurrentVersion(),
      timestamp: Date.now(),
    };

    this.evaluations.push(evaluation);
    // Keep bounded
    if (this.evaluations.length > 500) {
      this.evaluations = this.evaluations.slice(-250);
    }

    // Persist evaluation
    try {
      this.learning.recordEvent({
        subsystem: SUBSYSTEM,
        task_type: 'evaluation',
        tool: 'build_evaluation',
        outcome: classification === 'success' ? 'success' : classification === 'partial' ? 'partial' : 'failure',
        context: { evaluation },
      });
    } catch { /* non-fatal */ }

    // Check safety after each evaluation
    this.checkSafety();

    return evaluation;
  }

  /**
   * Get recent build evaluations.
   */
  getRecentEvaluations(limit: number = 20): BuildEvaluation[] {
    return this.evaluations.slice(-limit);
  }

  /* ================================================================== */
  /*  4. Configuration Evolution                                         */
  /* ================================================================== */

  /**
   * Get the current config version number.
   */
  getCurrentVersion(): number {
    return this.versions.length > 0 ? this.versions[this.versions.length - 1].version : 0;
  }

  /**
   * Get the current active config (latest non-rolled-back version).
   */
  getCurrentConfig(): Partial<IntelligenceConfig> {
    for (let i = this.versions.length - 1; i >= 0; i--) {
      if (!this.versions[i].rolled_back) {
        return { ...this.versions[i].config };
      }
    }
    return { ...DEFAULT_INTELLIGENCE_CONFIG };
  }

  /**
   * Get a specific config version.
   */
  getVersion(versionNum: number): ConfigVersion | null {
    return this.versions.find(v => v.version === versionNum) ?? null;
  }

  /**
   * Get all config versions.
   */
  getVersionHistory(): ConfigVersion[] {
    return [...this.versions];
  }

  /**
   * Diff two config versions.
   */
  diffVersions(v1: number, v2: number): Record<string, { from: number; to: number }> {
    const c1 = this.getVersion(v1)?.config ?? {};
    const c2 = this.getVersion(v2)?.config ?? {};
    const diff: Record<string, { from: number; to: number }> = {};

    const allKeys = new Set([...Object.keys(c1), ...Object.keys(c2)]);
    for (const key of allKeys) {
      const val1 = (c1 as unknown as Record<string, number>)[key] ?? (DEFAULT_INTELLIGENCE_CONFIG as unknown as Record<string, number>)[key];
      const val2 = (c2 as unknown as Record<string, number>)[key] ?? (DEFAULT_INTELLIGENCE_CONFIG as unknown as Record<string, number>)[key];
      if (val1 !== val2) {
        diff[key] = { from: val1, to: val2 };
      }
    }
    return diff;
  }

  /**
   * Rollback to a previous config version.
   */
  rollback(targetVersion?: number): ConfigVersion | null {
    // Mark current as rolled back
    const current = this.versions[this.versions.length - 1];
    if (!current) return null;

    current.rolled_back = true;

    if (targetVersion !== undefined) {
      // Rollback to specific version
      const target = this.versions.find(v => v.version === targetVersion);
      if (target) {
        const newVersion = this.createVersion({ ...target.config }, 'rollback');
        this.safetyStatus.rollback_triggered = true;
        this.safetyStatus.cooldown_until = Date.now() + this.config.cooldownMs;
        this.persistState();
        return newVersion;
      }
    }

    // Rollback to previous non-rolled-back version
    for (let i = this.versions.length - 2; i >= 0; i--) {
      if (!this.versions[i].rolled_back) {
        const newVersion = this.createVersion({ ...this.versions[i].config }, 'rollback');
        this.safetyStatus.rollback_triggered = true;
        this.safetyStatus.cooldown_until = Date.now() + this.config.cooldownMs;
        this.persistState();
        return newVersion;
      }
    }

    // Fallback to defaults
    const newVersion = this.createVersion({ ...DEFAULT_INTELLIGENCE_CONFIG }, 'rollback');
    this.safetyStatus.rollback_triggered = true;
    this.safetyStatus.cooldown_until = Date.now() + this.config.cooldownMs;
    this.persistState();
    return newVersion;
  }

  /* ================================================================== */
  /*  5. Safety + Stability Guards                                       */
  /* ================================================================== */

  /**
   * Check if tuning is currently safe.
   */
  canTune(): boolean {
    // In cooldown
    if (this.safetyStatus.cooldown_until && Date.now() < this.safetyStatus.cooldown_until) {
      return false;
    }
    // Reset cooldown if expired
    if (this.safetyStatus.cooldown_until && Date.now() >= this.safetyStatus.cooldown_until) {
      this.safetyStatus.cooldown_until = null;
      this.safetyStatus.rollback_triggered = false;
    }
    return this.safetyStatus.safe;
  }

  /**
   * Get current safety status.
   */
  getSafetyStatus(): SafetyStatus {
    // Refresh cooldown state
    if (this.safetyStatus.cooldown_until && Date.now() >= this.safetyStatus.cooldown_until) {
      this.safetyStatus.cooldown_until = null;
      this.safetyStatus.rollback_triggered = false;
      this.safetyStatus.safe = true;
    }
    return { ...this.safetyStatus };
  }

  /**
   * Check safety after each evaluation. Triggers rollback if degradation detected.
   */
  private checkSafety(): void {
    const recent = this.evaluations.slice(-10);
    if (recent.length < 5) return;

    const successRate = this.computeSuccessRate(recent);
    const currentVersion = this.getCurrentVersion();

    // Find baseline metrics (version 0 or last promoted)
    const baseline = this.findBaselineMetrics();
    if (!baseline) return;

    // Check for success rate drop
    if (baseline.success_rate - successRate > this.config.rollbackThreshold) {
      this.safetyStatus.consecutive_degradations++;
      if (this.safetyStatus.consecutive_degradations >= 2 && currentVersion > 0) {
        this.safetyStatus.safe = false;
        this.safetyStatus.reason = `Success rate dropped ${((baseline.success_rate - successRate) * 100).toFixed(1)}% below baseline`;
        this.rollback();
      }
    } else {
      this.safetyStatus.consecutive_degradations = 0;
    }

    // Check for error rate spike
    const failureRate = 1 - successRate;
    const baselineFailureRate = 1 - baseline.success_rate;
    if (baselineFailureRate > 0 && failureRate / baselineFailureRate > this.config.errorSpikeMultiplier) {
      if (currentVersion > 0) {
        this.safetyStatus.safe = false;
        this.safetyStatus.reason = `Error rate spiked ${(failureRate / baselineFailureRate).toFixed(1)}x above baseline`;
        this.rollback();
      }
    }
  }

  /* ================================================================== */
  /*  6. Personalization-Aware Tuning (enforced by design)               */
  /* ================================================================== */

  /**
   * Self-improvement only tunes IntelligenceConfig (global parameters).
   * User personalization is a separate bias layer applied AFTER global
   * intelligence, and is never modified by self-improvement.
   *
   * This is enforced structurally:
   * - TunableBoundsMap only contains IntelligenceConfig keys
   * - No PersonalizationConfig keys are tunable
   * - User profiles are not read or written by this service
   */

  /* ================================================================== */
  /*  7. Diagnostics & Visibility                                        */
  /* ================================================================== */

  /**
   * Get comprehensive diagnostics for the self-improvement system.
   */
  getDiagnostics(): ImprovementDiagnostics {
    const promotions = this.versions.filter(v => v.promoted_at !== null).length;
    const rollbacks = this.versions.filter(v => v.rolled_back).length;

    return {
      current_version: this.getCurrentVersion(),
      active_config: this.getCurrentConfig(),
      version_history: [...this.versions],
      recent_evaluations: this.evaluations.slice(-20),
      pending_proposals: [...this.proposals],
      safety_status: this.getSafetyStatus(),
      ab_status: {
        enabled: this.config.experimentBaselineRatio > 0,
        baseline_ratio: this.config.experimentBaselineRatio,
        sample_count: this.evaluations.length,
      },
      improvement_trend: {
        versions_tested: this.versions.length,
        promotions,
        rollbacks,
      },
    };
  }

  /* ================================================================== */
  /*  Internal helpers                                                   */
  /* ================================================================== */

  private createVersion(config: Partial<IntelligenceConfig>, source: ConfigVersion['source']): ConfigVersion {
    const version: ConfigVersion = {
      version: this.versions.length,
      config,
      created_at: Date.now(),
      promoted_at: source === 'initial' ? Date.now() : null,
      rolled_back: false,
      metrics_at_creation: this.captureCurrentMetrics(),
      metrics_at_promotion: source === 'initial' ? this.captureCurrentMetrics() : null,
      source,
    };
    this.versions.push(version);
    return version;
  }

  private captureCurrentMetrics(): ConfigMetrics {
    const recent = this.evaluations.slice(-20);
    return {
      success_rate: this.computeSuccessRate(recent),
      failure_rate: 1 - this.computeSuccessRate(recent),
      avg_retry_count: this.computeAvgRetries(recent),
      total_decisions: recent.reduce((s, e) => s + e.metrics.intelligence_decisions, 0),
      evidence_count: recent.length,
      timestamp: Date.now(),
    };
  }

  private computeSuccessRate(evals: BuildEvaluation[]): number {
    if (evals.length === 0) return 0;
    return evals.filter(e => e.classification === 'success').length / evals.length;
  }

  private computeAvgRetries(evals: BuildEvaluation[]): number {
    if (evals.length === 0) return 0;
    return evals.reduce((s, e) => s + e.metrics.retries_used, 0) / evals.length;
  }

  private findBaselineMetrics(): ConfigMetrics | null {
    // Use metrics from last promoted version, or version 0
    for (let i = this.versions.length - 1; i >= 0; i--) {
      if (this.versions[i].metrics_at_promotion) {
        return this.versions[i].metrics_at_promotion!;
      }
    }
    return this.versions[0]?.metrics_at_creation ?? null;
  }

  /**
   * Smooth parameter adjustment using EMA-style blending.
   * Result is clamped within bounds.
   */
  private smoothAdjust(current: number, target: number, param: string): number {
    const bounds = this.bounds[param];
    if (!bounds) return target;

    // EMA: new = current + learningRate * (target - current)
    let adjusted = current + this.config.learningRate * (target - current);

    // Snap to step grid
    adjusted = Math.round(adjusted / bounds.step) * bounds.step;

    // Clamp within bounds
    adjusted = Math.max(bounds.min, Math.min(bounds.max, adjusted));

    // Round to avoid float precision issues
    adjusted = Math.round(adjusted * 1000) / 1000;

    return adjusted;
  }

  private addProposal(param: string, current: number, proposed: number, reason: string, evidence: number, confidence: number): void {
    if (current === proposed) return;
    this.proposals.push({
      parameter: param,
      current_value: current,
      proposed_value: proposed,
      reason,
      evidence_count: evidence,
      confidence,
    });
  }

  private wilsonLower(successes: number, total: number): number {
    if (total === 0) return 0;
    const z = 1.96;
    const p = successes / total;
    const denom = 1 + z * z / total;
    const centre = p + z * z / (2 * total);
    const adj = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
    return Math.max(0, (centre - adj) / denom);
  }

  private hydrateState(): void {
    try {
      const events = this.learning.queryEvents({
        subsystem: SUBSYSTEM,
        tool: 'state_snapshot',
        limit: 10,
      });
      if (events.length > 0) {
        const ctx = JSON.parse(events[0].context_json ?? '{}');
        if (ctx.versions) this.versions = ctx.versions;
        if (ctx.evaluations) this.evaluations = ctx.evaluations;
        if (ctx.safety_status) this.safetyStatus = ctx.safety_status;
      }
    } catch { /* non-fatal — start fresh */ }
  }

  private persistState(): void {
    try {
      this.learning.recordEvent({
        subsystem: SUBSYSTEM,
        task_type: 'state',
        tool: 'state_snapshot',
        outcome: 'success',
        context: {
          versions: this.versions.slice(-20), // Keep last 20 versions
          evaluations: this.evaluations.slice(-50), // Keep last 50 evaluations
          safety_status: this.safetyStatus,
        },
      });
    } catch { /* non-fatal */ }
  }
}
