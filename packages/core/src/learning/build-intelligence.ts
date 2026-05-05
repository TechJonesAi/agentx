/**
 * Build Intelligence Service — Phase 10A
 *
 * Higher-level query layer on top of GlobalLearningService that provides
 * build-specific intelligence: file-class performance, repair patterns,
 * protection candidates, build summaries, and comprehensive recommendations.
 *
 * This does NOT replace BuildLearningAdapter. It extends the queryable
 * intelligence surface using the same underlying data store.
 *
 * All data is derived from global_learning_events records with subsystem='build'
 * that include enriched context (file_class, file_path, build_id, action_taken, etc.).
 */

import type { GlobalLearningService, GlobalLearningEvent } from './global-learning.js';
import type { BuildAction, BuildPhase } from './build-learning-adapter.js';

const SUBSYSTEM = 'build' as const;

/* ------------------------------------------------------------------ */
/*  Intelligence config — Phase 10D                                    */
/* ------------------------------------------------------------------ */

/** Configurable thresholds for the build intelligence system. */
export interface IntelligenceConfig {
  /** Minimum samples before intelligence can make recommendations (default: 3) */
  minEvidence: number;
  /** Minimum margin between repair/regenerate success rates to bias (default: 0.10) */
  successMargin: number;
  /** Cache TTL in ms for recommendation queries (default: 30000) */
  cacheTtlMs: number;
  /** File failure rate above which a file is promoted to protected (default: 0.50) */
  protectionFailureRate: number;
  /** Minimum total outcomes for a file before protection promotion (default: 3) */
  protectionMinOutcomes: number;
  /** Minimum occurrences for a recurring blocker (default: 3) */
  blockerMinOccurrences: number;
  /** Default lookback window in days for queries (default: 30) */
  defaultSinceDays: number;
  /** Model avoidance threshold — avoid if success rate below this (default: 0.30) */
  modelAvoidThreshold: number;
  /** Confidence threshold for model/strategy recommendation (default: 0.50) */
  recommendationConfidence: number;
  // ─── Phase 11A additions ──────────────────────────────────────
  /** Half-life for time decay in days. Events lose 50% weight after this many days. 0 = no decay. (default: 14) */
  decayHalfLifeDays: number;
  /** Fraction of decisions routed to baseline (non-intelligence) path for A/B comparison. 0–1. (default: 0) */
  abBaselineRatio: number;
}

export const DEFAULT_INTELLIGENCE_CONFIG: IntelligenceConfig = {
  minEvidence: 3,
  successMargin: 0.10,
  cacheTtlMs: 30_000,
  protectionFailureRate: 0.50,
  protectionMinOutcomes: 3,
  blockerMinOccurrences: 3,
  defaultSinceDays: 30,
  modelAvoidThreshold: 0.30,
  recommendationConfidence: 0.50,
  decayHalfLifeDays: 14,
  abBaselineRatio: 0,
};

/* ------------------------------------------------------------------ */
/*  Effectiveness tracking — Phase 10D                                 */
/* ------------------------------------------------------------------ */

/** Tracks whether intelligence-driven decisions improve outcomes. */
export interface IntelligenceEffectivenessRecord {
  timestamp: number;
  decision_type: 'model' | 'strategy' | 'fixer_bias' | 'file_protection' | 'blocker_avoidance';
  intelligence_driven: boolean;
  outcome: 'success' | 'failure';
  task_type: string;
  detail?: string;
  /** Phase 11A: Which comparison group this decision was assigned to */
  comparison_group?: 'intelligence' | 'baseline' | 'uncontrolled';
}

export interface IntelligenceEffectiveness {
  total_decisions: number;
  intelligence_driven: number;
  baseline_decisions: number;
  intelligence_success_rate: number;
  baseline_success_rate: number;
  improvement: number;
  by_type: Record<string, { intelligence: { total: number; successes: number }; baseline: { total: number; successes: number } }>;
}

/** Phase 11A: Comprehensive diagnostics snapshot */
export interface IntelligenceDiagnostics {
  effectiveness: IntelligenceEffectiveness;
  config: IntelligenceConfig;
  evidence: {
    total_events: number;
    fresh_events: number;
    stale_events: number;
    oldest_event_age_days: number | null;
    newest_event_age_days: number | null;
  };
  top_strategies: Array<{ key: string; success_rate: number; total: number; decayed_rate: number }>;
  top_failures: Array<{ error_class: string; occurrences: number; last_seen: string }>;
  confidence_summary: {
    model_confidence: number;
    strategy_confidence: number;
  };
  ab_comparison: {
    enabled: boolean;
    baseline_ratio: number;
    controlled_decisions: number;
  } | null;
}

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/** Performance stats for a file class (e.g., 'component', 'config', 'test') */
export interface FileClassStats {
  file_class: string;
  total: number;
  successes: number;
  failures: number;
  success_rate: number;
  common_errors: string[];
  common_models: string[];
  avg_fix_retries: number;
}

/** Risk profile for a specific file path */
export interface FileRiskProfile {
  file_path: string;
  total_outcomes: number;
  failure_count: number;
  failure_rate: number;
  error_classes: string[];
  last_failure: string | null;
  recommended_action: BuildAction | null;
  protected: boolean;
}

/** File that should be promoted to protected status */
export interface ProtectionCandidate {
  file_path: string;
  file_class: string | null;
  failure_count: number;
  failure_rate: number;
  reason: string;
}

/** Stats comparing regenerate vs repair effectiveness */
export interface ActionEffectiveness {
  action: BuildAction;
  total: number;
  successes: number;
  success_rate: number;
}

/** Summary of a single build run */
export interface BuildSummary {
  build_id: string;
  total_outcomes: number;
  successes: number;
  failures: number;
  phases_involved: string[];
  error_classes: string[];
  models_used: string[];
  files_affected: string[];
  duration_ms_total: number;
  overall_success: boolean;
}

/** Recurring blocker that impedes builds */
export interface RecurringBlocker {
  error_class: string;
  occurrences: number;
  affected_task_types: string[];
  affected_file_classes: string[];
  best_action: BuildAction | null;
}

/** Comprehensive build recommendations for a task type */
export interface BuildRecommendations {
  task_type: string;
  preferred_model: string | null;
  preferred_strategy: string | null;
  avoid_models: string[];
  avoid_strategies: string[];
  high_risk_files: string[];
  recurring_blockers: RecurringBlocker[];
  evidence_count: number;
}

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class BuildIntelligenceService {
  private learning: GlobalLearningService;
  private config: IntelligenceConfig;
  /** In-memory cache, hydrated from persistent store on construction */
  private effectivenessLog: IntelligenceEffectivenessRecord[] = [];
  private static readonly EFFECTIVENESS_SUBSYSTEM = 'intelligence' as const;

  constructor(learning: GlobalLearningService, config?: Partial<IntelligenceConfig>) {
    this.learning = learning;
    this.config = { ...DEFAULT_INTELLIGENCE_CONFIG, ...config };
    // Hydrate in-memory cache from persistent store
    this.hydrateEffectivenessLog();
  }

  /** Get the active configuration. */
  getConfig(): Readonly<IntelligenceConfig> {
    return this.config;
  }

  /* ================================================================== */
  /*  Area 1: Persistent Effectiveness Tracking                          */
  /* ================================================================== */

  /**
   * Record the outcome of a decision for effectiveness measurement.
   * Persists to the global_learning_events table (subsystem='intelligence')
   * AND keeps in-memory cache for fast queries.
   */
  recordDecisionOutcome(record: Omit<IntelligenceEffectivenessRecord, 'timestamp'>): void {
    const ts = Date.now();
    const group = record.comparison_group ?? (record.intelligence_driven ? 'intelligence' : 'baseline');
    const fullRecord: IntelligenceEffectivenessRecord = { ...record, timestamp: ts, comparison_group: group };
    this.effectivenessLog.push(fullRecord);
    // Keep in-memory cache bounded
    if (this.effectivenessLog.length > 2000) {
      this.effectivenessLog = this.effectivenessLog.slice(-1000);
    }
    // Persist to SQLite via GlobalLearningService
    try {
      this.learning.recordEvent({
        subsystem: BuildIntelligenceService.EFFECTIVENESS_SUBSYSTEM,
        task_type: record.task_type,
        tool: record.decision_type,
        outcome: record.outcome,
        context: {
          intelligence_driven: record.intelligence_driven,
          comparison_group: group,
          detail: record.detail,
        },
      });
    } catch { /* non-fatal — in-memory cache is still valid */ }
  }

  /** Hydrate in-memory effectiveness log from persistent store. */
  private hydrateEffectivenessLog(): void {
    try {
      const events = this.learning.queryEvents({
        subsystem: BuildIntelligenceService.EFFECTIVENESS_SUBSYSTEM,
        limit: 2000,
      });
      for (const ev of events) {
        const ctx = this.parseContext(ev.context_json);
        this.effectivenessLog.push({
          timestamp: new Date(ev.created_at).getTime(),
          decision_type: ev.tool as IntelligenceEffectivenessRecord['decision_type'],
          intelligence_driven: ctx.intelligence_driven === true,
          outcome: ev.outcome as 'success' | 'failure',
          task_type: ev.task_type,
          detail: ctx.detail as string | undefined,
          comparison_group: ctx.comparison_group as IntelligenceEffectivenessRecord['comparison_group'],
        });
      }
    } catch { /* non-fatal — start with empty cache */ }
  }

  /**
   * Get effectiveness metrics comparing intelligence-driven vs baseline decisions.
   * Reads from persistent store for durability across restarts.
   */
  getEffectiveness(): IntelligenceEffectiveness {
    const records = this.effectivenessLog;
    const intel = records.filter(r => r.intelligence_driven);
    const baseline = records.filter(r => !r.intelligence_driven);

    const intelSuccesses = intel.filter(r => r.outcome === 'success').length;
    const baselineSuccesses = baseline.filter(r => r.outcome === 'success').length;

    const intelRate = intel.length > 0 ? intelSuccesses / intel.length : 0;
    const baselineRate = baseline.length > 0 ? baselineSuccesses / baseline.length : 0;

    const byType: IntelligenceEffectiveness['by_type'] = {};
    for (const r of records) {
      if (!byType[r.decision_type]) {
        byType[r.decision_type] = {
          intelligence: { total: 0, successes: 0 },
          baseline: { total: 0, successes: 0 },
        };
      }
      const bucket = r.intelligence_driven ? byType[r.decision_type].intelligence : byType[r.decision_type].baseline;
      bucket.total++;
      if (r.outcome === 'success') bucket.successes++;
    }

    return {
      total_decisions: records.length,
      intelligence_driven: intel.length,
      baseline_decisions: baseline.length,
      intelligence_success_rate: intelRate,
      baseline_success_rate: baselineRate,
      improvement: intelRate - baselineRate,
      by_type: byType,
    };
  }

  /** Get raw effectiveness log (for diagnostics). */
  getEffectivenessLog(): IntelligenceEffectivenessRecord[] {
    return [...this.effectivenessLog];
  }

  /* ================================================================== */
  /*  Area 2: Time Decay / Staleness                                     */
  /* ================================================================== */

  /**
   * Apply exponential time decay to a weight based on event age.
   * w(t) = 2^(-age_days / half_life_days)
   * At age=0 → 1.0, at age=halfLife → 0.5, at age=2*halfLife → 0.25
   */
  applyTimeDecay(ageDays: number): number {
    const halfLife = this.config.decayHalfLifeDays;
    if (halfLife <= 0 || ageDays <= 0) return 1.0;
    return Math.pow(2, -ageDays / halfLife);
  }

  /**
   * Get time-decay-weighted action effectiveness.
   * Newer events count more than older events.
   */
  getDecayedActionEffectiveness(taskType?: string): ActionEffectiveness[] {
    const events = this.learning.queryEvents({
      subsystem: SUBSYSTEM,
      task_type: taskType,
      since_days: this.config.defaultSinceDays,
      limit: 10000,
    });

    const now = Date.now();
    const byAction = new Map<string, { weightedSuccess: number; weightedTotal: number; rawTotal: number; rawSuccesses: number }>();

    for (const ev of events) {
      const ctx = this.parseContext(ev.context_json);
      const action = ctx.action_taken as string | undefined;
      if (!action) continue;
      if (!byAction.has(action)) byAction.set(action, { weightedSuccess: 0, weightedTotal: 0, rawTotal: 0, rawSuccesses: 0 });
      const entry = byAction.get(action)!;
      const ageDays = (now - new Date(ev.created_at).getTime()) / 86_400_000;
      const weight = this.applyTimeDecay(ageDays);
      entry.weightedTotal += weight;
      entry.rawTotal++;
      if (ev.outcome === 'success') {
        entry.weightedSuccess += weight;
        entry.rawSuccesses++;
      }
    }

    const results: ActionEffectiveness[] = [];
    for (const [action, stats] of byAction) {
      results.push({
        action: action as BuildAction,
        total: stats.rawTotal,
        successes: stats.rawSuccesses,
        success_rate: stats.weightedTotal > 0 ? stats.weightedSuccess / stats.weightedTotal : 0,
      });
    }
    return results.sort((a, b) => b.success_rate - a.success_rate);
  }

  /**
   * Get evidence freshness breakdown: how many events are "fresh" vs "stale".
   * Fresh = within first half-life; Stale = older than one half-life.
   */
  getEvidenceFreshness(): { total: number; fresh: number; stale: number; oldestAgeDays: number | null; newestAgeDays: number | null } {
    const events = this.learning.queryEvents({
      subsystem: SUBSYSTEM,
      since_days: this.config.defaultSinceDays,
      limit: 10000,
    });
    if (events.length === 0) return { total: 0, fresh: 0, stale: 0, oldestAgeDays: null, newestAgeDays: null };

    const now = Date.now();
    const halfLife = this.config.decayHalfLifeDays;
    let fresh = 0;
    let stale = 0;
    let oldest = 0;
    let newest = Infinity;

    for (const ev of events) {
      const ageDays = (now - new Date(ev.created_at).getTime()) / 86_400_000;
      if (ageDays <= halfLife) fresh++;
      else stale++;
      if (ageDays > oldest) oldest = ageDays;
      if (ageDays < newest) newest = ageDays;
    }

    return {
      total: events.length,
      fresh,
      stale,
      oldestAgeDays: Math.round(oldest * 100) / 100,
      newestAgeDays: newest === Infinity ? null : Math.round(newest * 100) / 100,
    };
  }

  /* ================================================================== */
  /*  Area 3: Confidence Weighting                                       */
  /* ================================================================== */

  /**
   * Wilson score lower bound for a binomial proportion.
   * Gives a conservative estimate of the true success rate
   * that accounts for sample size uncertainty.
   * z = 1.96 for 95% confidence interval.
   */
  wilsonScoreLower(successes: number, total: number, z: number = 1.96): number {
    if (total === 0) return 0;
    const p = successes / total;
    const denominator = 1 + z * z / total;
    const centre = p + z * z / (2 * total);
    const adjustment = z * Math.sqrt((p * (1 - p) + z * z / (4 * total)) / total);
    return Math.max(0, (centre - adjustment) / denominator);
  }

  /**
   * Compute enhanced recommendation confidence incorporating:
   * - Wilson score lower bound (sample size aware)
   * - Recency weighting (fresher data → higher confidence)
   * - Separation from second-best option
   */
  computeEnhancedConfidence(
    topSuccesses: number,
    topTotal: number,
    secondRate: number,
    avgAgeDays: number,
  ): number {
    // Wilson score lower bound — conservative success rate
    const wilsonLower = this.wilsonScoreLower(topSuccesses, topTotal);

    // Separation from second best
    const rawRate = topTotal > 0 ? topSuccesses / topTotal : 0;
    const separation = rawRate - secondRate;

    // Recency factor: decay confidence if average evidence is old
    const recencyFactor = this.applyTimeDecay(avgAgeDays);

    // Sample factor: ramp up with evidence
    const sampleFactor = Math.min(topTotal / 10, 1.0);

    // Blend: Wilson lower bound is primary signal; separation, recency, sample are modifiers
    return Math.min(
      wilsonLower * 0.40 + separation * 0.20 + recencyFactor * 0.20 + sampleFactor * 0.20,
      1.0,
    );
  }

  /* ================================================================== */
  /*  Area 4: Controlled A/B Comparison                                  */
  /* ================================================================== */

  /**
   * Determine whether this decision should use the intelligence path or baseline path.
   * Returns 'intelligence' or 'baseline' based on configured abBaselineRatio.
   * When abBaselineRatio = 0, always returns 'intelligence' (no A/B testing).
   */
  assignComparisonGroup(): 'intelligence' | 'baseline' {
    if (this.config.abBaselineRatio <= 0) return 'intelligence';
    if (this.config.abBaselineRatio >= 1) return 'baseline';
    return Math.random() < this.config.abBaselineRatio ? 'baseline' : 'intelligence';
  }

  /**
   * Get A/B comparison results: success rates for intelligence vs baseline groups.
   */
  getABComparison(): { enabled: boolean; intelligence: { total: number; successes: number; rate: number }; baseline: { total: number; successes: number; rate: number }; delta: number } {
    const enabled = this.config.abBaselineRatio > 0;
    const records = this.effectivenessLog;
    const intelGroup = records.filter(r => r.comparison_group === 'intelligence');
    const baseGroup = records.filter(r => r.comparison_group === 'baseline');

    const intelSuccesses = intelGroup.filter(r => r.outcome === 'success').length;
    const baseSuccesses = baseGroup.filter(r => r.outcome === 'success').length;
    const intelRate = intelGroup.length > 0 ? intelSuccesses / intelGroup.length : 0;
    const baseRate = baseGroup.length > 0 ? baseSuccesses / baseGroup.length : 0;

    return {
      enabled,
      intelligence: { total: intelGroup.length, successes: intelSuccesses, rate: intelRate },
      baseline: { total: baseGroup.length, successes: baseSuccesses, rate: baseRate },
      delta: intelRate - baseRate,
    };
  }

  /* ================================================================== */
  /*  Area 5: Diagnostics / Visibility                                   */
  /* ================================================================== */

  /**
   * Get comprehensive diagnostics snapshot of the intelligence system.
   */
  getDiagnostics(taskType: string = 'general'): IntelligenceDiagnostics {
    const effectiveness = this.getEffectiveness();
    const freshness = this.getEvidenceFreshness();

    // Top strategies (with decay)
    const stats = this.learning.getStrategyStats(SUBSYSTEM, taskType, 'strategy', this.config.defaultSinceDays);
    const now = Date.now();
    const topStrategies = stats.slice(0, 5).map(s => {
      const ageDays = s.last_used ? (now - new Date(s.last_used).getTime()) / 86_400_000 : this.config.defaultSinceDays;
      return {
        key: s.key,
        success_rate: s.success_rate,
        total: s.total,
        decayed_rate: s.success_rate * this.applyTimeDecay(ageDays),
      };
    });

    // Top failures
    const failures = this.learning.getFailurePatterns({
      subsystem: SUBSYSTEM,
      sinceDays: this.config.defaultSinceDays,
      minOccurrences: 2,
    });
    const topFailures = failures.slice(0, 5).map(f => ({
      error_class: f.error_class,
      occurrences: f.occurrences,
      last_seen: f.last_seen,
    }));

    // Confidence summary
    const modelRec = this.learning.getBestStrategy(SUBSYSTEM, taskType, 'model', {
      sinceDays: this.config.defaultSinceDays,
      minSamples: this.config.minEvidence,
    });
    const stratRec = this.learning.getBestStrategy(SUBSYSTEM, taskType, 'strategy', {
      sinceDays: this.config.defaultSinceDays,
      minSamples: this.config.minEvidence,
    });

    // A/B comparison
    const ab = this.getABComparison();

    return {
      effectiveness,
      config: this.config,
      evidence: {
        total_events: freshness.total,
        fresh_events: freshness.fresh,
        stale_events: freshness.stale,
        oldest_event_age_days: freshness.oldestAgeDays,
        newest_event_age_days: freshness.newestAgeDays,
      },
      top_strategies: topStrategies,
      top_failures: topFailures,
      confidence_summary: {
        model_confidence: modelRec.recommendation_confidence,
        strategy_confidence: stratRec.recommendation_confidence,
      },
      ab_comparison: {
        enabled: ab.enabled,
        baseline_ratio: this.config.abBaselineRatio,
        controlled_decisions: ab.intelligence.total + ab.baseline.total,
      },
    };
  }

  /**
   * Get performance stats grouped by file class.
   */
  getFileClassStats(sinceDays: number = 30): FileClassStats[] {
    const events = this.learning.queryEvents({
      subsystem: SUBSYSTEM,
      since_days: sinceDays,
      limit: 10000,
    });

    const byClass = new Map<string, GlobalLearningEvent[]>();
    for (const ev of events) {
      const ctx = this.parseContext(ev.context_json);
      const fc = ctx.file_class as string | undefined;
      if (!fc) continue;
      if (!byClass.has(fc)) byClass.set(fc, []);
      byClass.get(fc)!.push(ev);
    }

    const results: FileClassStats[] = [];
    for (const [fc, evs] of byClass) {
      const successes = evs.filter(e => e.outcome === 'success').length;
      const failures = evs.filter(e => e.outcome === 'failure').length;

      const errors = new Set<string>();
      const models = new Set<string>();
      let totalRetries = 0;
      let retryCount = 0;
      for (const e of evs) {
        if (e.error_class) errors.add(e.error_class);
        if (e.model) models.add(e.model);
        const ctx = this.parseContext(e.context_json);
        if (typeof ctx.fix_retries === 'number') {
          totalRetries += ctx.fix_retries;
          retryCount++;
        }
      }

      results.push({
        file_class: fc,
        total: evs.length,
        successes,
        failures,
        success_rate: evs.length > 0 ? successes / evs.length : 0,
        common_errors: [...errors],
        common_models: [...models],
        avg_fix_retries: retryCount > 0 ? totalRetries / retryCount : 0,
      });
    }

    return results.sort((a, b) => b.total - a.total);
  }

  /**
   * Get risk profile for a specific file path.
   */
  getFileRiskProfile(filePath: string, sinceDays: number = 30): FileRiskProfile {
    const events = this.learning.queryEvents({
      subsystem: SUBSYSTEM,
      since_days: sinceDays,
      limit: 10000,
    });

    const fileEvents = events.filter(e => {
      const ctx = this.parseContext(e.context_json);
      return ctx.file_path === filePath;
    });

    const failures = fileEvents.filter(e => e.outcome === 'failure');
    const errorClasses = [...new Set(failures.map(e => e.error_class).filter(Boolean))] as string[];
    const lastFailure = failures.length > 0 ? failures[0].created_at : null;
    const isProtected = fileEvents.some(e => {
      const ctx = this.parseContext(e.context_json);
      return ctx.protected_file === true;
    });

    let recommendedAction: BuildAction | null = null;
    if (failures.length >= 5) {
      recommendedAction = 'protect';
    } else if (failures.length >= 3) {
      recommendedAction = 'regenerate';
    } else if (failures.length >= 1) {
      recommendedAction = 'repair';
    }

    return {
      file_path: filePath,
      total_outcomes: fileEvents.length,
      failure_count: failures.length,
      failure_rate: fileEvents.length > 0 ? failures.length / fileEvents.length : 0,
      error_classes: errorClasses,
      last_failure: lastFailure,
      recommended_action: recommendedAction,
      protected: isProtected,
    };
  }

  /**
   * Get files that should be promoted to protected status.
   * Criteria: failure rate > 50% with at least 3 outcomes, OR 3+ consecutive failures.
   */
  getProtectionCandidates(sinceDays: number = 30): ProtectionCandidate[] {
    const events = this.learning.queryEvents({
      subsystem: SUBSYSTEM,
      since_days: sinceDays,
      limit: 10000,
    });

    const byFile = new Map<string, { events: GlobalLearningEvent[]; file_class: string | null }>();
    for (const ev of events) {
      const ctx = this.parseContext(ev.context_json);
      const fp = ctx.file_path as string | undefined;
      if (!fp) continue;
      if (!byFile.has(fp)) byFile.set(fp, { events: [], file_class: (ctx.file_class as string) || null });
      byFile.get(fp)!.events.push(ev);
    }

    const candidates: ProtectionCandidate[] = [];
    for (const [fp, data] of byFile) {
      const failures = data.events.filter(e => e.outcome === 'failure').length;
      const total = data.events.length;
      const failureRate = total > 0 ? failures / total : 0;

      // Already protected — skip
      const alreadyProtected = data.events.some(e => {
        const ctx = this.parseContext(e.context_json);
        return ctx.protected_file === true;
      });
      if (alreadyProtected) continue;

      if (total >= this.config.protectionMinOutcomes && failureRate > this.config.protectionFailureRate) {
        candidates.push({
          file_path: fp,
          file_class: data.file_class,
          failure_count: failures,
          failure_rate: failureRate,
          reason: `High failure rate: ${(failureRate * 100).toFixed(0)}% over ${total} outcomes`,
        });
      }
    }

    return candidates.sort((a, b) => b.failure_rate - a.failure_rate);
  }

  /**
   * Get effectiveness of regenerate vs repair vs skip actions.
   */
  getActionEffectiveness(taskType?: string, sinceDays: number = 30): ActionEffectiveness[] {
    const events = this.learning.queryEvents({
      subsystem: SUBSYSTEM,
      task_type: taskType,
      since_days: sinceDays,
      limit: 10000,
    });

    const byAction = new Map<BuildAction, { total: number; successes: number }>();
    for (const ev of events) {
      const ctx = this.parseContext(ev.context_json);
      const action = ctx.action_taken as BuildAction | undefined;
      if (!action) continue;
      if (!byAction.has(action)) byAction.set(action, { total: 0, successes: 0 });
      const entry = byAction.get(action)!;
      entry.total++;
      if (ev.outcome === 'success') entry.successes++;
    }

    const results: ActionEffectiveness[] = [];
    for (const [action, stats] of byAction) {
      results.push({
        action,
        total: stats.total,
        successes: stats.successes,
        success_rate: stats.total > 0 ? stats.successes / stats.total : 0,
      });
    }

    return results.sort((a, b) => b.success_rate - a.success_rate);
  }

  /**
   * Get a summary of what happened in a specific build run.
   */
  getBuildSummary(buildId: string): BuildSummary | null {
    const events = this.learning.queryEvents({
      subsystem: SUBSYSTEM,
      limit: 10000,
    });

    const buildEvents = events.filter(e => {
      const ctx = this.parseContext(e.context_json);
      return ctx.build_id === buildId;
    });

    if (buildEvents.length === 0) return null;

    const successes = buildEvents.filter(e => e.outcome === 'success').length;
    const failures = buildEvents.filter(e => e.outcome === 'failure').length;
    const phases = new Set<string>();
    const errors = new Set<string>();
    const models = new Set<string>();
    const files = new Set<string>();
    let totalDuration = 0;

    for (const e of buildEvents) {
      if (e.tool) phases.add(e.tool);  // phase is stored in tool dimension
      if (e.error_class) errors.add(e.error_class);
      if (e.model) models.add(e.model);
      if (e.duration_ms) totalDuration += e.duration_ms;
      const ctx = this.parseContext(e.context_json);
      if (ctx.file_path) files.add(ctx.file_path as string);
    }

    return {
      build_id: buildId,
      total_outcomes: buildEvents.length,
      successes,
      failures,
      phases_involved: [...phases],
      error_classes: [...errors],
      models_used: [...models],
      files_affected: [...files],
      duration_ms_total: totalDuration,
      overall_success: failures === 0,
    };
  }

  /**
   * Get recurring blockers across builds.
   */
  getRecurringBlockers(sinceDays?: number, minOccurrences?: number): RecurringBlocker[] {
    sinceDays = sinceDays ?? this.config.defaultSinceDays;
    minOccurrences = minOccurrences ?? this.config.blockerMinOccurrences;
    const patterns = this.learning.getFailurePatterns({
      subsystem: SUBSYSTEM,
      sinceDays,
      minOccurrences,
    });

    const events = this.learning.queryEvents({
      subsystem: SUBSYSTEM,
      outcome: 'failure',
      since_days: sinceDays,
      limit: 10000,
    });

    return patterns.map(p => {
      const errorEvents = events.filter(e => e.error_class === p.error_class);
      const fileClasses = new Set<string>();
      const actions = new Map<BuildAction, { total: number; successes: number }>();

      for (const e of errorEvents) {
        const ctx = this.parseContext(e.context_json);
        if (ctx.file_class) fileClasses.add(ctx.file_class as string);
      }

      // Check which actions worked for this error class (look at successes too)
      const allWithError = this.learning.queryEvents({
        subsystem: SUBSYSTEM,
        error_class: p.error_class,
        since_days: sinceDays,
        limit: 1000,
      });
      for (const e of allWithError) {
        const ctx = this.parseContext(e.context_json);
        const action = ctx.action_taken as BuildAction | undefined;
        if (!action) continue;
        if (!actions.has(action)) actions.set(action, { total: 0, successes: 0 });
        const entry = actions.get(action)!;
        entry.total++;
        if (e.outcome === 'success') entry.successes++;
      }

      let bestAction: BuildAction | null = null;
      let bestRate = 0;
      for (const [action, stats] of actions) {
        const rate = stats.total > 0 ? stats.successes / stats.total : 0;
        if (rate > bestRate) {
          bestRate = rate;
          bestAction = action;
        }
      }

      return {
        error_class: p.error_class,
        occurrences: p.occurrences,
        affected_task_types: p.task_types,
        affected_file_classes: [...fileClasses],
        best_action: bestAction,
      };
    });
  }

  /**
   * Get comprehensive build recommendations for a task type.
   */
  getBuildRecommendations(taskType: string, sinceDays?: number): BuildRecommendations {
    sinceDays = sinceDays ?? this.config.defaultSinceDays;
    const modelRec = this.learning.getBestStrategy(SUBSYSTEM, taskType, 'model', {
      sinceDays,
      minSamples: this.config.minEvidence,
    });

    const strategyRec = this.learning.getBestStrategy(SUBSYSTEM, taskType, 'strategy', {
      sinceDays,
      minSamples: this.config.minEvidence,
    });

    const protectionCandidates = this.getProtectionCandidates(sinceDays);
    const blockers = this.getRecurringBlockers(sinceDays);

    return {
      task_type: taskType,
      preferred_model: modelRec.recommended,
      preferred_strategy: strategyRec.recommended,
      avoid_models: modelRec.avoid,
      avoid_strategies: strategyRec.avoid,
      high_risk_files: protectionCandidates.map(c => c.file_path),
      recurring_blockers: blockers,
      evidence_count: modelRec.evidence_count + strategyRec.evidence_count,
    };
  }

  /* ================================================================== */
  /*  Internal helpers                                                   */
  /* ================================================================== */

  private parseContext(contextJson: string | null): Record<string, unknown> {
    if (!contextJson) return {};
    try {
      return JSON.parse(contextJson);
    } catch {
      return {};
    }
  }
}
