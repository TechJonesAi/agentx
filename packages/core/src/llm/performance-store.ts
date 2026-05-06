/**
 * Model Performance Store — Minimal runtime stub.
 * Tracks model performance for build outcome learning.
 */
import type Database from 'better-sqlite3';

export interface ModelPerformanceRecord {
  model: string;
  capability: string;
  successCount: number;
  failureCount: number;
  successRate: number;
}

/**
 * Tool-use outcome per model. Populated by the chat pipeline after each turn
 * that was classified as "action-shaped" by the tool-use detector. Feeds into
 * model ranking: models with low tool_use_success_pct get demoted for
 * capabilities that are heavy in tool_use (code, automation, etc.).
 */
export interface ToolUseOutcomeRecord {
  model: string;
  capability: string;
  /** How many action-shaped turns this model actually emitted tool calls for. */
  successCount: number;
  /** How many turns this model failed to emit tool calls when expected. */
  failureCount: number;
  successRate: number;
}

export interface ModelRunResult {
  model: string;
  success: boolean;
  durationMs: number;
}

export class ModelPerformanceStore {
  constructor(private db: Database.Database) {
    // Ensure table exists
    try {
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS model_performance (
          model TEXT NOT NULL,
          capability TEXT NOT NULL,
          success_count INTEGER DEFAULT 0,
          failure_count INTEGER DEFAULT 0,
          PRIMARY KEY (model, capability)
        )
      `);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS build_file_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          build_id TEXT,
          file_path TEXT,
          file_category TEXT,
          stage TEXT,
          model TEXT,
          success INTEGER,
          error_class TEXT,
          task_category TEXT,
          created_at INTEGER DEFAULT (unixepoch())
        )
      `);
      // Tool-use quality per (model, capability).
      // Populated after each action-shaped chat turn via recordToolUseOutcome().
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS model_tool_use (
          model TEXT NOT NULL,
          capability TEXT NOT NULL,
          success_count INTEGER DEFAULT 0,
          failure_count INTEGER DEFAULT 0,
          last_miss_reason TEXT,
          updated_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (model, capability)
        )
      `);
    } catch {
      // Table may already exist with different schema
    }
  }

  /**
   * Record whether the model emitted tool_use when the request expected it.
   * Called once per chat turn by the auto-escalation loop in agent.ts.
   * @param missReason  Optional — if success === false, the detector's reason code.
   */
  recordToolUseOutcome(
    model: string,
    capability: string,
    success: boolean,
    missReason?: string,
  ): void {
    try {
      this.db.prepare(`
        INSERT INTO model_tool_use (model, capability, success_count, failure_count, last_miss_reason, updated_at)
        VALUES (?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(model, capability) DO UPDATE SET
          success_count = success_count + excluded.success_count,
          failure_count = failure_count + excluded.failure_count,
          last_miss_reason = COALESCE(excluded.last_miss_reason, last_miss_reason),
          updated_at = unixepoch()
      `).run(
        model,
        capability,
        success ? 1 : 0,
        success ? 0 : 1,
        success ? null : (missReason ?? null),
      );
    } catch { /* never break a chat on telemetry failure */ }
  }

  /**
   * List tool-use quality for all models on a given capability.
   * Used by the fabric's ranking logic to demote weak tool-callers.
   */
  listToolUseOutcomes(capability: string): ToolUseOutcomeRecord[] {
    try {
      return (this.db.prepare(`
        SELECT model, capability,
               success_count AS successCount,
               failure_count AS failureCount,
               CAST(success_count AS REAL) / MAX(success_count + failure_count, 1) AS successRate
        FROM model_tool_use WHERE capability = ?
      `).all(capability) as ToolUseOutcomeRecord[]) ?? [];
    } catch { return []; }
  }

  /** True if we have at least `minSamples` turns recorded for this (model,capability). */
  hasToolUseSignal(model: string, capability: string, minSamples = 3): boolean {
    try {
      const row = this.db.prepare(`
        SELECT (success_count + failure_count) AS total
        FROM model_tool_use WHERE model = ? AND capability = ?
      `).get(model, capability) as { total: number } | undefined;
      return (row?.total ?? 0) >= minSamples;
    } catch { return false; }
  }

  /**
   * Record post-turn QUALITY score from the tool-call evaluator.
   * Complements `recordToolUseOutcome` (which records PRESENCE/absence of a
   * tool call) by tracking whether the tool call was actually correct.
   *
   * Rolling average: every new sample updates `avg_quality` via
   *   new_avg = old_avg + (sample - old_avg) / new_count
   * so we keep a smooth signal without storing every individual score.
   */
  recordToolCallQuality(
    model: string,
    capability: string,
    score: number,
    weak: boolean,
  ): void {
    try {
      // Clamp to 0..1 defensively.
      const s = Math.max(0, Math.min(1, score));
      // Upsert into a quality table. Schema: model, capability, sample_count,
      // avg_quality, weak_count, updated_at.
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS model_tool_call_quality (
          model TEXT NOT NULL,
          capability TEXT NOT NULL,
          sample_count INTEGER DEFAULT 0,
          avg_quality REAL DEFAULT 0,
          weak_count INTEGER DEFAULT 0,
          updated_at INTEGER DEFAULT (unixepoch()),
          PRIMARY KEY (model, capability)
        )
      `);
      // Two-step upsert so we can compute the rolling mean without SQLite
      // math tricks: read existing, then write merged row.
      const existing = this.db.prepare(`
        SELECT sample_count, avg_quality, weak_count
        FROM model_tool_call_quality WHERE model = ? AND capability = ?
      `).get(model, capability) as { sample_count: number; avg_quality: number; weak_count: number } | undefined;

      const prevCount = existing?.sample_count ?? 0;
      const prevAvg = existing?.avg_quality ?? 0;
      const prevWeak = existing?.weak_count ?? 0;
      const newCount = prevCount + 1;
      const newAvg = prevAvg + (s - prevAvg) / newCount;
      const newWeak = prevWeak + (weak ? 1 : 0);

      this.db.prepare(`
        INSERT INTO model_tool_call_quality (model, capability, sample_count, avg_quality, weak_count, updated_at)
        VALUES (?, ?, ?, ?, ?, unixepoch())
        ON CONFLICT(model, capability) DO UPDATE SET
          sample_count = excluded.sample_count,
          avg_quality = excluded.avg_quality,
          weak_count = excluded.weak_count,
          updated_at = unixepoch()
      `).run(model, capability, newCount, newAvg, newWeak);
    } catch { /* never break a chat on telemetry failure */ }
  }

  /** List quality records for a capability. Used by the fabric's ranking pass. */
  listToolCallQuality(capability: string): Array<{ model: string; sampleCount: number; avgQuality: number; weakCount: number }> {
    try {
      return this.db.prepare(`
        SELECT model, sample_count AS sampleCount, avg_quality AS avgQuality, weak_count AS weakCount
        FROM model_tool_call_quality WHERE capability = ?
      `).all(capability) as Array<{ model: string; sampleCount: number; avgQuality: number; weakCount: number }>;
    } catch { return []; }
  }

  recordBuildFileOutcome(outcome: {
    buildId: string; filePath: string; fileCategory?: string;
    stage: string; model: string; success: boolean;
    errorClass?: string; taskCategory?: string; attempt?: number;
  }): void {
    try {
      this.db.prepare(`
        INSERT INTO build_file_outcomes (build_id, file_path, file_category, stage, model, success, error_class, task_category)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(outcome.buildId, outcome.filePath, outcome.fileCategory ?? null,
        outcome.stage, outcome.model, outcome.success ? 1 : 0,
        outcome.errorClass ?? null, outcome.taskCategory ?? null);
    } catch { /* non-critical */ }
  }

  getBestModel(capability: string): string | null {
    try {
      const row = this.db.prepare(`
        SELECT model FROM model_performance
        WHERE capability = ? AND (success_count + failure_count) >= 1
        ORDER BY CAST(success_count AS REAL) / MAX(success_count + failure_count, 1) DESC
        LIMIT 1
      `).get(capability) as { model: string } | undefined;
      return row?.model ?? null;
    } catch { return null; }
  }

  listPerformance(capability: string): ModelPerformanceRecord[] {
    try {
      return (this.db.prepare(`
        SELECT model, capability, success_count as successCount, failure_count as failureCount,
               CAST(success_count AS REAL) / MAX(success_count + failure_count, 1) as successRate
        FROM model_performance WHERE capability = ?
      `).all(capability) as ModelPerformanceRecord[]) ?? [];
    } catch { return []; }
  }

  getBestModelForErrorClass(_errorClass: string): string | null {
    return null;
  }

  getChronicallyFailingFiles(): string[] {
    return [];
  }

  getEscalationEffectiveness(): Record<string, number> {
    return {};
  }
}
