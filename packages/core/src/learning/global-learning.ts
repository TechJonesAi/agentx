/**
 * Global Learning Service
 *
 * System-wide outcome recording and strategy recommendation engine.
 * Designed to be used by ANY AgentX subsystem — build pipeline, retrieval,
 * ingestion, research, tools, or future features.
 *
 * What this does:
 *   - Records outcome events from any subsystem with uniform schema
 *   - Queries past outcomes for strategy/model/tool effectiveness
 *   - Provides "best strategy" recommendations based on historical success
 *   - Identifies repeated failure patterns for avoidance
 *   - Tracks success/failure rates per subsystem × task_type × strategy
 *
 * What this does NOT do:
 *   - Replace subsystem-specific learning (build artifacts, retrieval boosts)
 *   - Perform hidden ML or LLM calls
 *   - Invent knowledge — all data comes from recorded real outcomes
 *
 * Design principles:
 *   - Subsystem-agnostic schema: no build-specific assumptions in core
 *   - Reusable by current and future features via simple record/query API
 *   - SQLite-backed for persistence across sessions
 *   - Deterministic recommendations based on aggregate statistics
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';

const log = createLogger('learning:global');

/* ------------------------------------------------------------------ */
/*  Public types                                                       */
/* ------------------------------------------------------------------ */

/** Subsystems that can record learning events */
export type LearningSubsystem =
  | 'build'
  | 'retrieval'
  | 'ingestion'
  | 'research'
  | 'search'
  | 'memory'
  | 'tool'
  | 'model'
  | 'automation'
  | 'chat'
  | string; // extensible for future subsystems

/** Outcome of the recorded event */
export type LearningOutcome = 'success' | 'failure' | 'partial' | 'timeout' | 'skipped';

/** A single learning event record */
export interface GlobalLearningEvent {
  event_id: string;
  subsystem: LearningSubsystem;
  task_type: string;
  strategy: string | null;
  model: string | null;
  tool: string | null;
  outcome: LearningOutcome;
  error_class: string | null;
  duration_ms: number | null;
  cost_tokens: number | null;
  confidence: number | null;
  context_json: string | null;
  session_id: string | null;
  created_at: string;
}

/** Input for recording a new event (auto-generates id and timestamp) */
export interface RecordEventInput {
  subsystem: LearningSubsystem;
  task_type: string;
  strategy?: string;
  model?: string;
  tool?: string;
  outcome: LearningOutcome;
  error_class?: string;
  duration_ms?: number;
  cost_tokens?: number;
  confidence?: number;
  context?: Record<string, unknown>;
  session_id?: string;
}

/** Aggregated statistics for a strategy/model/tool combination */
export interface StrategyStats {
  key: string; // strategy name, model name, or tool name
  total: number;
  successes: number;
  failures: number;
  partials: number;
  success_rate: number;
  avg_duration_ms: number | null;
  avg_confidence: number | null;
  last_used: string;
}

/** Recommendation returned by getBestStrategy */
export interface StrategyRecommendation {
  recommended: string | null;
  alternatives: string[];
  avoid: string[];
  evidence_count: number;
  recommendation_confidence: number;
}

/** Query filter for searching past events */
export interface EventQuery {
  subsystem?: LearningSubsystem;
  task_type?: string;
  strategy?: string;
  model?: string;
  tool?: string;
  outcome?: LearningOutcome;
  error_class?: string;
  since_days?: number;
  limit?: number;
}

/** Repeated failure pattern detection result */
export interface FailurePattern {
  error_class: string;
  occurrences: number;
  subsystems: string[];
  task_types: string[];
  last_seen: string;
  affected_strategies: string[];
}

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class GlobalLearningService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.ensureSchema();
  }

  /* ============================================================== */
  /*  Schema                                                         */
  /* ============================================================== */

  private ensureSchema(): void {
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS global_learning_events (
          event_id TEXT PRIMARY KEY,
          subsystem TEXT NOT NULL,
          task_type TEXT NOT NULL,
          strategy TEXT,
          model TEXT,
          tool TEXT,
          outcome TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'partial', 'timeout', 'skipped')),
          error_class TEXT,
          duration_ms INTEGER,
          cost_tokens INTEGER,
          confidence REAL,
          context_json TEXT,
          session_id TEXT,
          created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
        );

        CREATE INDEX IF NOT EXISTS idx_gle_subsystem ON global_learning_events(subsystem);
        CREATE INDEX IF NOT EXISTS idx_gle_task_type ON global_learning_events(subsystem, task_type);
        CREATE INDEX IF NOT EXISTS idx_gle_strategy ON global_learning_events(subsystem, strategy);
        CREATE INDEX IF NOT EXISTS idx_gle_outcome ON global_learning_events(outcome);
        CREATE INDEX IF NOT EXISTS idx_gle_error_class ON global_learning_events(error_class);
        CREATE INDEX IF NOT EXISTS idx_gle_created ON global_learning_events(created_at);
        CREATE INDEX IF NOT EXISTS idx_gle_model ON global_learning_events(model);
      `);
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'GlobalLearningService schema init failed',
      );
    }
  }

  /* ============================================================== */
  /*  Record events                                                  */
  /* ============================================================== */

  /**
   * Record a learning event from any subsystem.
   * Returns the generated event_id.
   */
  recordEvent(input: RecordEventInput): string {
    const eventId = randomUUID();
    const now = new Date().toISOString();

    try {
      this.db
        .prepare(
          `INSERT INTO global_learning_events
             (event_id, subsystem, task_type, strategy, model, tool, outcome,
              error_class, duration_ms, cost_tokens, confidence, context_json, session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          eventId,
          input.subsystem,
          input.task_type,
          input.strategy ?? null,
          input.model ?? null,
          input.tool ?? null,
          input.outcome,
          input.error_class ?? null,
          input.duration_ms ?? null,
          input.cost_tokens ?? null,
          input.confidence ?? null,
          input.context ? JSON.stringify(input.context) : null,
          input.session_id ?? null,
          now,
        );

      return eventId;
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'GlobalLearningService.recordEvent failed',
      );
      throw error;
    }
  }

  /**
   * Record multiple events in a single transaction.
   */
  recordEvents(inputs: RecordEventInput[]): string[] {
    const ids: string[] = [];
    const runTx = this.db.transaction(() => {
      for (const input of inputs) {
        ids.push(this.recordEvent(input));
      }
    });
    runTx();
    return ids;
  }

  /* ============================================================== */
  /*  Query events                                                   */
  /* ============================================================== */

  /**
   * Query past learning events with filters.
   */
  queryEvents(query: EventQuery): GlobalLearningEvent[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.subsystem) {
      conditions.push('subsystem = ?');
      params.push(query.subsystem);
    }
    if (query.task_type) {
      conditions.push('task_type = ?');
      params.push(query.task_type);
    }
    if (query.strategy) {
      conditions.push('strategy = ?');
      params.push(query.strategy);
    }
    if (query.model) {
      conditions.push('model = ?');
      params.push(query.model);
    }
    if (query.tool) {
      conditions.push('tool = ?');
      params.push(query.tool);
    }
    if (query.outcome) {
      conditions.push('outcome = ?');
      params.push(query.outcome);
    }
    if (query.error_class) {
      conditions.push('error_class = ?');
      params.push(query.error_class);
    }
    if (query.since_days) {
      conditions.push("created_at >= datetime('now', '-' || ? || ' days')");
      params.push(query.since_days);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = query.limit ?? 100;

    try {
      const rows = this.db
        .prepare(
          `SELECT * FROM global_learning_events ${where}
           ORDER BY created_at DESC LIMIT ?`,
        )
        .all(...params, limit) as any[];

      return rows.map((r) => this.rowToEvent(r));
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'GlobalLearningService.queryEvents failed',
      );
      return [];
    }
  }

  /* ============================================================== */
  /*  Strategy recommendations                                       */
  /* ============================================================== */

  /**
   * Get aggregated statistics for strategies used in a subsystem+task_type.
   * Groups by the specified dimension (strategy, model, or tool).
   */
  getStrategyStats(
    subsystem: LearningSubsystem,
    taskType: string,
    dimension: 'strategy' | 'model' | 'tool' = 'strategy',
    sinceDays: number = 30,
  ): StrategyStats[] {
    try {
      const rows = this.db
        .prepare(
          `SELECT
             ${dimension} as key,
             COUNT(*) as total,
             SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
             SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures,
             SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partials,
             AVG(duration_ms) as avg_duration_ms,
             AVG(confidence) as avg_confidence,
             MAX(created_at) as last_used
           FROM global_learning_events
           WHERE subsystem = ? AND task_type = ?
             AND ${dimension} IS NOT NULL
             AND created_at >= datetime('now', '-' || ? || ' days')
           GROUP BY ${dimension}
           ORDER BY successes DESC, total DESC`,
        )
        .all(subsystem, taskType, sinceDays) as any[];

      return rows.map((r) => ({
        key: r.key as string,
        total: r.total as number,
        successes: r.successes as number,
        failures: r.failures as number,
        partials: r.partials as number,
        success_rate: r.total > 0 ? (r.successes as number) / (r.total as number) : 0,
        avg_duration_ms: r.avg_duration_ms as number | null,
        avg_confidence: r.avg_confidence as number | null,
        last_used: r.last_used as string,
      }));
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'GlobalLearningService.getStrategyStats failed',
      );
      return [];
    }
  }

  /**
   * Get the best strategy recommendation for a subsystem+task_type.
   * Uses success rate with a minimum sample threshold.
   */
  getBestStrategy(
    subsystem: LearningSubsystem,
    taskType: string,
    dimension: 'strategy' | 'model' | 'tool' = 'strategy',
    options?: { sinceDays?: number; minSamples?: number },
  ): StrategyRecommendation {
    const sinceDays = options?.sinceDays ?? 30;
    const minSamples = options?.minSamples ?? 3;

    const stats = this.getStrategyStats(subsystem, taskType, dimension, sinceDays);

    // Filter to strategies with enough data
    const qualified = stats.filter((s) => s.total >= minSamples);

    // Sort by success rate, then by total attempts
    qualified.sort((a, b) => {
      const rateDiff = b.success_rate - a.success_rate;
      if (Math.abs(rateDiff) > 0.05) return rateDiff;
      return b.total - a.total;
    });

    // Best = highest success rate with enough data
    const recommended = qualified.length > 0 ? qualified[0].key : null;

    // Alternatives = other strategies with > 50% success rate
    const alternatives = qualified
      .slice(1)
      .filter((s) => s.success_rate >= 0.5)
      .map((s) => s.key);

    // Avoid = strategies with < 30% success rate
    const avoid = qualified
      .filter((s) => s.success_rate < 0.3 && s.total >= minSamples)
      .map((s) => s.key);

    // Confidence = higher if more data, lower if close success rates
    const evidenceCount = stats.reduce((sum, s) => sum + s.total, 0);
    let recommendationConfidence = 0;
    if (recommended && qualified.length > 0) {
      const topRate = qualified[0].success_rate;
      const secondRate = qualified.length > 1 ? qualified[1].success_rate : 0;
      const separation = topRate - secondRate;
      const sampleFactor = Math.min(qualified[0].total / 10, 1.0);
      recommendationConfidence = Math.min(
        (topRate * 0.5 + separation * 0.3 + sampleFactor * 0.2),
        1.0,
      );
    }

    return {
      recommended,
      alternatives,
      avoid,
      evidence_count: evidenceCount,
      recommendation_confidence: recommendationConfidence,
    };
  }

  /* ============================================================== */
  /*  Failure pattern detection                                      */
  /* ============================================================== */

  /**
   * Detect repeated failure patterns across the system.
   * Groups failures by error_class to find systemic issues.
   */
  getFailurePatterns(
    options?: {
      subsystem?: LearningSubsystem;
      sinceDays?: number;
      minOccurrences?: number;
    },
  ): FailurePattern[] {
    const sinceDays = options?.sinceDays ?? 14;
    const minOccurrences = options?.minOccurrences ?? 2;

    try {
      const subsystemFilter = options?.subsystem
        ? 'AND subsystem = ?'
        : '';
      const params: unknown[] = [sinceDays];
      if (options?.subsystem) params.push(options.subsystem);
      params.push(minOccurrences);

      const rows = this.db
        .prepare(
          `SELECT
             error_class,
             COUNT(*) as occurrences,
             GROUP_CONCAT(DISTINCT subsystem) as subsystems,
             GROUP_CONCAT(DISTINCT task_type) as task_types,
             MAX(created_at) as last_seen,
             GROUP_CONCAT(DISTINCT strategy) as strategies
           FROM global_learning_events
           WHERE outcome = 'failure'
             AND error_class IS NOT NULL
             AND created_at >= datetime('now', '-' || ? || ' days')
             ${subsystemFilter}
           GROUP BY error_class
           HAVING COUNT(*) >= ?
           ORDER BY occurrences DESC`,
        )
        .all(...params) as any[];

      return rows.map((r) => ({
        error_class: r.error_class as string,
        occurrences: r.occurrences as number,
        subsystems: (r.subsystems as string || '').split(',').filter(Boolean),
        task_types: (r.task_types as string || '').split(',').filter(Boolean),
        last_seen: r.last_seen as string,
        affected_strategies: (r.strategies as string || '').split(',').filter(Boolean),
      }));
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'GlobalLearningService.getFailurePatterns failed',
      );
      return [];
    }
  }

  /**
   * Get success patterns — strategies/models/tools that consistently work.
   */
  getSuccessPatterns(
    subsystem: LearningSubsystem,
    options?: { sinceDays?: number; minSuccesses?: number },
  ): StrategyStats[] {
    const sinceDays = options?.sinceDays ?? 30;
    const minSuccesses = options?.minSuccesses ?? 3;

    try {
      const rows = this.db
        .prepare(
          `SELECT
             COALESCE(strategy, model, tool, 'default') as key,
             COUNT(*) as total,
             SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes,
             SUM(CASE WHEN outcome = 'failure' THEN 1 ELSE 0 END) as failures,
             SUM(CASE WHEN outcome = 'partial' THEN 1 ELSE 0 END) as partials,
             AVG(duration_ms) as avg_duration_ms,
             AVG(confidence) as avg_confidence,
             MAX(created_at) as last_used
           FROM global_learning_events
           WHERE subsystem = ?
             AND created_at >= datetime('now', '-' || ? || ' days')
           GROUP BY COALESCE(strategy, model, tool, 'default')
           HAVING SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) >= ?
           ORDER BY successes DESC`,
        )
        .all(subsystem, sinceDays, minSuccesses) as any[];

      return rows.map((r) => ({
        key: r.key as string,
        total: r.total as number,
        successes: r.successes as number,
        failures: r.failures as number,
        partials: r.partials as number,
        success_rate: r.total > 0 ? (r.successes as number) / (r.total as number) : 0,
        avg_duration_ms: r.avg_duration_ms as number | null,
        avg_confidence: r.avg_confidence as number | null,
        last_used: r.last_used as string,
      }));
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'GlobalLearningService.getSuccessPatterns failed',
      );
      return [];
    }
  }

  /* ============================================================== */
  /*  Cross-subsystem queries                                        */
  /* ============================================================== */

  /**
   * Get overall health of a model across all subsystems.
   */
  getModelHealth(model: string, sinceDays: number = 30): {
    model: string;
    total: number;
    success_rate: number;
    subsystem_breakdown: Array<{ subsystem: string; total: number; success_rate: number }>;
  } {
    try {
      const overall = this.db
        .prepare(
          `SELECT COUNT(*) as total,
                  SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes
           FROM global_learning_events
           WHERE model = ? AND created_at >= datetime('now', '-' || ? || ' days')`,
        )
        .get(model, sinceDays) as any;

      const breakdown = this.db
        .prepare(
          `SELECT subsystem,
                  COUNT(*) as total,
                  SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) as successes
           FROM global_learning_events
           WHERE model = ? AND created_at >= datetime('now', '-' || ? || ' days')
           GROUP BY subsystem
           ORDER BY total DESC`,
        )
        .all(model, sinceDays) as any[];

      return {
        model,
        total: overall?.total ?? 0,
        success_rate: overall?.total > 0 ? (overall.successes / overall.total) : 0,
        subsystem_breakdown: breakdown.map((r: any) => ({
          subsystem: r.subsystem,
          total: r.total,
          success_rate: r.total > 0 ? r.successes / r.total : 0,
        })),
      };
    } catch (error) {
      log.error(
        { error: error instanceof Error ? error.message : String(error) },
        'GlobalLearningService.getModelHealth failed',
      );
      return { model, total: 0, success_rate: 0, subsystem_breakdown: [] };
    }
  }

  /* ============================================================== */
  /*  Diagnostics                                                    */
  /* ============================================================== */

  /**
   * Get diagnostic summary for the global learning system.
   */
  getDiagnostics(): {
    total_events: number;
    subsystem_counts: Record<string, number>;
    outcome_counts: Record<string, number>;
    oldest_event: string | null;
    newest_event: string | null;
    health: 'healthy' | 'degraded' | 'unhealthy';
  } {
    try {
      const total = (this.db
        .prepare('SELECT COUNT(*) as cnt FROM global_learning_events')
        .get() as { cnt: number } | undefined)?.cnt ?? 0;

      const subsystemRows = this.db
        .prepare(
          'SELECT subsystem, COUNT(*) as cnt FROM global_learning_events GROUP BY subsystem',
        )
        .all() as Array<{ subsystem: string; cnt: number }>;

      const outcomeRows = this.db
        .prepare(
          'SELECT outcome, COUNT(*) as cnt FROM global_learning_events GROUP BY outcome',
        )
        .all() as Array<{ outcome: string; cnt: number }>;

      const range = this.db
        .prepare(
          'SELECT MIN(created_at) as oldest, MAX(created_at) as newest FROM global_learning_events',
        )
        .get() as { oldest: string | null; newest: string | null } | undefined;

      const subsystemCounts: Record<string, number> = {};
      for (const r of subsystemRows) subsystemCounts[r.subsystem] = r.cnt;

      const outcomeCounts: Record<string, number> = {};
      for (const r of outcomeRows) outcomeCounts[r.outcome] = r.cnt;

      return {
        total_events: total,
        subsystem_counts: subsystemCounts,
        outcome_counts: outcomeCounts,
        oldest_event: range?.oldest ?? null,
        newest_event: range?.newest ?? null,
        health: 'healthy',
      };
    } catch {
      return {
        total_events: 0,
        subsystem_counts: {},
        outcome_counts: {},
        oldest_event: null,
        newest_event: null,
        health: 'unhealthy',
      };
    }
  }

  /* ============================================================== */
  /*  Internal helpers                                               */
  /* ============================================================== */

  private rowToEvent(row: any): GlobalLearningEvent {
    return {
      event_id: row.event_id,
      subsystem: row.subsystem,
      task_type: row.task_type,
      strategy: row.strategy ?? null,
      model: row.model ?? null,
      tool: row.tool ?? null,
      outcome: row.outcome,
      error_class: row.error_class ?? null,
      duration_ms: row.duration_ms ?? null,
      cost_tokens: row.cost_tokens ?? null,
      confidence: row.confidence ?? null,
      context_json: row.context_json ?? null,
      session_id: row.session_id ?? null,
      created_at: row.created_at,
    };
  }
}
