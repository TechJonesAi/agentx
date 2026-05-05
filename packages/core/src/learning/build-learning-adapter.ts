/**
 * Build Learning Adapter
 *
 * Records build pipeline outcomes to the global learning system in parallel
 * with the existing build-local KnowledgeLearningStore / OutcomeTracker.
 *
 * This is ADDITIVE — it does NOT replace existing build learning.
 * It enables cross-subsystem queries (e.g., "which model works best
 * across builds, retrieval, and ingestion?").
 *
 * Integration point: call recordBuildOutcome() from code-pipeline.ts
 * recordPipelineEnd() method, AFTER existing OutcomeTracker / KnowledgeExtractor
 * writes have completed.
 */

import type { GlobalLearningService, StrategyRecommendation } from './global-learning.js';
import { createLogger } from '../logger.js';

const log = createLogger('learning:build-adapter');

const SUBSYSTEM = 'build' as const;

/** Build pipeline phase that produced the outcome */
export type BuildPhase = 'builder' | 'validator' | 'fixer' | 'supervisor' | 'planner';

/** Action taken on a file or error during build */
export type BuildAction = 'regenerate' | 'repair' | 'skip' | 'protect' | 'escalate';

export interface BuildOutcomeInput {
  task_type: string;           // e.g., 'ios_app', 'web_app', 'python_script'
  strategy?: string;           // e.g., 'scaffold_first', 'direct_generate'
  model?: string;              // e.g., 'qwen2.5-coder:32b'
  success: boolean;
  error_class?: string;        // e.g., 'naming_conflict', 'import_error'
  duration_ms?: number;
  file_count?: number;
  fix_retries?: number;
  escalation_used?: boolean;
  first_build_passed?: boolean;
  context?: Record<string, unknown>;
  session_id?: string;
  // ─── Phase 10A: Build Intelligence enrichment ──────────────
  build_id?: string;           // groups outcomes from the same build run
  phase?: BuildPhase;          // which build phase produced this outcome
  file_path?: string;          // specific file involved
  file_class?: string;         // e.g., 'config', 'component', 'test', 'style', 'entry_point'
  protected_file?: boolean;    // was this file under protected/deterministic generation
  action_taken?: BuildAction;  // what action was chosen for this file/error
}

export class BuildLearningAdapter {
  private learning: GlobalLearningService;

  constructor(learning: GlobalLearningService) {
    this.learning = learning;
  }

  /**
   * Record a build pipeline outcome into the global learning system.
   * Call this AFTER existing OutcomeTracker/KnowledgeExtractor writes.
   */
  recordBuildOutcome(input: BuildOutcomeInput): string {
    return this.learning.recordEvent({
      subsystem: SUBSYSTEM,
      task_type: input.task_type,
      strategy: input.strategy,
      model: input.model,
      tool: input.phase,  // store phase in the 'tool' dimension for queryability
      outcome: input.success ? 'success' : 'failure',
      error_class: input.error_class,
      duration_ms: input.duration_ms,
      context: {
        file_count: input.file_count,
        fix_retries: input.fix_retries,
        escalation_used: input.escalation_used,
        first_build_passed: input.first_build_passed,
        build_id: input.build_id,
        file_path: input.file_path,
        file_class: input.file_class,
        protected_file: input.protected_file,
        action_taken: input.action_taken,
        ...input.context,
      },
      session_id: input.session_id,
    });
  }

  /**
   * Get best model recommendation for a build task type.
   */
  getBestModel(taskType: string): StrategyRecommendation {
    return this.learning.getBestStrategy(SUBSYSTEM, taskType, 'model', {
      sinceDays: 30,
      minSamples: 3,
    });
  }

  /**
   * Get best build strategy recommendation.
   */
  getBestStrategy(taskType: string): StrategyRecommendation {
    return this.learning.getBestStrategy(SUBSYSTEM, taskType, 'strategy', {
      sinceDays: 30,
      minSamples: 3,
    });
  }

  /**
   * Get build failure patterns.
   */
  getBuildFailurePatterns() {
    return this.learning.getFailurePatterns({
      subsystem: SUBSYSTEM,
      sinceDays: 14,
      minOccurrences: 2,
    });
  }

  /**
   * Check if a model should be avoided for a task type.
   */
  shouldAvoidModel(taskType: string, model: string): boolean {
    const stats = this.learning.getStrategyStats(SUBSYSTEM, taskType, 'model', 30);
    const modelStats = stats.find((s) => s.key === model);
    if (!modelStats || modelStats.total < 3) return false;
    return modelStats.success_rate < 0.3;
  }

  /* ================================================================== */
  /*  Exploitation methods — active decision control                     */
  /* ================================================================== */

  /**
   * Get adaptive retry budget based on historical error patterns.
   * Returns a recommended retry count (1–6) that adjusts based on
   * how often this task/error class succeeds with retries.
   *
   * Structural errors (high occurrence) → fewer retries (don't waste time).
   * Transient errors (low occurrence) → more retries (likely to recover).
   * Unknown errors → default budget.
   */
  getAdaptiveRetryBudget(taskType: string, errorClass?: string): number {
    const DEFAULT_RETRIES = 3;

    if (!errorClass) {
      const stats = this.learning.getStrategyStats(SUBSYSTEM, taskType, 'strategy', 30);
      if (stats.length === 0) return DEFAULT_RETRIES;
      const avgSuccess = stats.reduce((s, v) => s + v.success_rate, 0) / stats.length;
      if (avgSuccess > 0.8) return 2;  // high success → fewer retries needed
      if (avgSuccess < 0.3) return 5;  // low success → invest more retries
      return DEFAULT_RETRIES;
    }

    const patterns = this.learning.getFailurePatterns({
      subsystem: SUBSYSTEM,
      sinceDays: 30,
      minOccurrences: 2,
    });
    const pattern = patterns.find((p) => p.error_class === errorClass);
    if (!pattern) return DEFAULT_RETRIES;

    // High-frequency error → likely structural, retries won't help
    if (pattern.occurrences > 10) return 1;
    if (pattern.occurrences > 5) return 2;
    // Low-frequency error → might be transient, give more budget
    return 4;
  }

  /**
   * Get preferred model for a task type based on historical success.
   * Returns model name if there's a confident recommendation, null otherwise.
   */
  getPreferredModel(taskType: string): string | null {
    const rec = this.getBestModel(taskType);
    if (rec.recommendation_confidence > 0.5 && rec.recommended) {
      return rec.recommended;
    }
    return null;
  }

  /**
   * Get high-risk error patterns from build history.
   * These indicate structural problems that warrant protective measures
   * (e.g., deterministic generation, constrained output, file protection).
   */
  getHighRiskPatterns(): Array<{ error_class: string; occurrences: number; subsystems: string[] }> {
    return this.learning.getFailurePatterns({
      subsystem: SUBSYSTEM,
      sinceDays: 14,
      minOccurrences: 3,
    });
  }

  /**
   * Check if an error class is high-risk (recurring structural failure).
   * When true, the build should use a protected/deterministic path
   * instead of standard generation.
   */
  isHighRiskError(errorClass: string): boolean {
    const patterns = this.getHighRiskPatterns();
    return patterns.some((p) => p.error_class === errorClass && p.occurrences >= 3);
  }

  /**
   * Select the best model from a candidate list, filtering out
   * models that should be avoided for this task type.
   * Returns the candidates reordered: preferred first, avoided last.
   */
  rankModels(taskType: string, candidates: string[]): string[] {
    if (candidates.length <= 1) return candidates;

    const preferred = this.getPreferredModel(taskType);
    const ranked = candidates.filter((m) => !this.shouldAvoidModel(taskType, m));
    const avoided = candidates.filter((m) => this.shouldAvoidModel(taskType, m));

    // Put preferred model first if it's in the non-avoided list
    if (preferred && ranked.includes(preferred)) {
      const idx = ranked.indexOf(preferred);
      ranked.splice(idx, 1);
      ranked.unshift(preferred);
    }

    // Append avoided models as last-resort fallbacks
    return [...ranked, ...avoided];
  }

  /**
   * Get the recommended strategy for an error class.
   * Returns 'regenerate' if the error is structural (whole-file rewrite needed),
   * 'repair' if it's a minor/transient issue, or 'skip' if historically unrecoverable.
   */
  getErrorClassAction(taskType: string, errorClass: string): 'regenerate' | 'repair' | 'skip' {
    const patterns = this.learning.getFailurePatterns({
      subsystem: SUBSYSTEM,
      sinceDays: 30,
      minOccurrences: 2,
    });
    const pattern = patterns.find((p) => p.error_class === errorClass);
    if (!pattern) return 'repair'; // unknown error → try repair first

    // Very high occurrence → likely unrecoverable with same approach
    if (pattern.occurrences >= 10) return 'skip';
    // Moderate → full regeneration more likely to fix structural issues
    if (pattern.occurrences >= 5) return 'regenerate';
    // Low → simple repair might work
    return 'repair';
  }
}
