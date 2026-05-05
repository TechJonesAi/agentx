/**
 * Learning Engine — Structured experience capture
 *
 * Records success/failure signals from all subsystems.
 * Provides pattern analysis for success and failure modes.
 * Persists to SQLite learning_engine_signals table.
 *
 * This is NOT model training. This is structured experience capture
 * that enables subsystems to become smarter over time.
 */

import type { SqliteMemoryDb } from '../db/sqlite-memory.js';
import { createLogger } from '../logger.js';
import type { LearningSignal, LearningPattern, LearningDiagnostics } from './learning-types.js';

const log = createLogger('learning:engine');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS learning_engine_signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subsystem TEXT NOT NULL,
  input TEXT NOT NULL,
  output TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  score REAL,
  timestamp INTEGER NOT NULL,
  metadata_json TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_les_subsystem ON learning_engine_signals(subsystem);
CREATE INDEX IF NOT EXISTS idx_les_success ON learning_engine_signals(success);
CREATE INDEX IF NOT EXISTS idx_les_timestamp ON learning_engine_signals(timestamp);
`;

export class LearningEngine {
  private db: SqliteMemoryDb;

  constructor(db: SqliteMemoryDb) {
    this.db = db;
    this.ensureSchema();
    log.info('Learning engine initialized');
  }

  private ensureSchema(): void {
    try {
      this.db.exec(SCHEMA_SQL);
    } catch {
      // Table may already exist
    }
  }

  recordSignal(signal: LearningSignal): void {
    this.db.prepare<unknown[]>(
      `INSERT INTO learning_engine_signals (subsystem, input, output, success, score, timestamp, metadata_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      signal.subsystem,
      signal.input,
      signal.output,
      signal.success ? 1 : 0,
      signal.score ?? null,
      signal.timestamp,
      signal.metadata ? JSON.stringify(signal.metadata) : null,
    );
  }

  getSignals(subsystem: string, limit = 100): LearningSignal[] {
    const rows = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT * FROM learning_engine_signals WHERE subsystem = ? ORDER BY timestamp DESC LIMIT ?`
    ).all(subsystem, limit) as Record<string, unknown>[];

    return rows.map(r => this.rowToSignal(r));
  }

  getSuccessPatterns(subsystem: string, limit = 50): LearningPattern {
    const rows = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT * FROM learning_engine_signals WHERE subsystem = ? AND success = 1 ORDER BY score DESC, timestamp DESC LIMIT ?`
    ).all(subsystem, limit) as Record<string, unknown>[];

    const signals = rows.map(r => this.rowToSignal(r));
    const avgScore = signals.length > 0
      ? signals.reduce((sum, s) => sum + (s.score ?? 0), 0) / signals.length
      : 0;

    return {
      subsystem,
      patternType: 'success',
      count: signals.length,
      avgScore,
      examples: signals.slice(0, 10),
    };
  }

  getFailurePatterns(subsystem: string, limit = 50): LearningPattern {
    const rows = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT * FROM learning_engine_signals WHERE subsystem = ? AND success = 0 ORDER BY timestamp DESC LIMIT ?`
    ).all(subsystem, limit) as Record<string, unknown>[];

    const signals = rows.map(r => this.rowToSignal(r));
    const avgScore = signals.length > 0
      ? signals.reduce((sum, s) => sum + (s.score ?? 0), 0) / signals.length
      : 0;

    return {
      subsystem,
      patternType: 'failure',
      count: signals.length,
      avgScore,
      examples: signals.slice(0, 10),
    };
  }

  getSubsystems(): string[] {
    const rows = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT DISTINCT subsystem FROM learning_engine_signals ORDER BY subsystem`
    ).all() as Record<string, unknown>[];

    return rows.map(r => String(r.subsystem));
  }

  getSignalCount(subsystem?: string): number {
    if (subsystem) {
      const row = this.db.prepare<unknown[], Record<string, unknown>>(
        `SELECT COUNT(*) as cnt FROM learning_engine_signals WHERE subsystem = ?`
      ).get(subsystem) as Record<string, unknown> | undefined;
      return Number(row?.cnt ?? 0);
    }

    const row = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT COUNT(*) as cnt FROM learning_engine_signals`
    ).get() as Record<string, unknown> | undefined;
    return Number(row?.cnt ?? 0);
  }

  getDiagnostics(): LearningDiagnostics {
    const totalSignals = this.getSignalCount();
    const subsystems = this.getSubsystems();

    const subsystemHealth: Record<string, { total: number; successRate: number; avgScore: number }> = {};
    const signalsBySubsystem: Record<string, number> = {};

    let totalSuccess = 0;
    let totalScoreSum = 0;
    let totalScoreCount = 0;

    for (const sub of subsystems) {
      const stats = this.db.prepare<unknown[], Record<string, unknown>>(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
          AVG(score) as avg_score
        FROM learning_engine_signals WHERE subsystem = ?`
      ).get(sub) as Record<string, unknown> | undefined;

      const total = Number(stats?.total ?? 0);
      const successes = Number(stats?.successes ?? 0);
      const avgScore = Number(stats?.avg_score ?? 0);

      signalsBySubsystem[sub] = total;
      subsystemHealth[sub] = {
        total,
        successRate: total > 0 ? successes / total : 0,
        avgScore,
      };

      totalSuccess += successes;
      if (stats?.avg_score !== null) {
        totalScoreSum += avgScore * total;
        totalScoreCount += total;
      }
    }

    return {
      totalSignals,
      signalsBySubsystem,
      successRate: totalSignals > 0 ? totalSuccess / totalSignals : 0,
      avgScore: totalScoreCount > 0 ? totalScoreSum / totalScoreCount : 0,
      subsystemHealth,
    };
  }

  private rowToSignal(row: Record<string, unknown>): LearningSignal {
    return {
      subsystem: String(row.subsystem),
      input: String(row.input),
      output: String(row.output),
      success: Boolean(row.success),
      score: row.score !== null ? Number(row.score) : undefined,
      timestamp: Number(row.timestamp),
      metadata: row.metadata_json ? JSON.parse(String(row.metadata_json)) : undefined,
    };
  }
}
