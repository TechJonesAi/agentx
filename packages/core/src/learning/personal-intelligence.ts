/**
 * Personal Intelligence — Continuous learning from user behaviour and task outcomes.
 *
 * Tracks:
 *   - Task outcomes (type, model, duration, success/failure, retries)
 *   - User preferences (detected patterns from behaviour)
 *   - Build patterns (successful project structures for reuse)
 *   - Model performance feedback (closes the loop to routing)
 *
 * This is NOT model training. This is structured experience that
 * makes AgentX smarter over time for THIS specific user.
 */

import { createLogger } from '../logger.js';
import type { SqliteMemoryDb } from '../db/sqlite-memory.js';

const log = createLogger('learning:personal-intelligence');

// ── Types ─────────────────────────────────────────────────────────

export interface TaskOutcome {
  taskType: string;       // 'build_app' | 'code' | 'chat' | 'research' | 'fix'
  taskDescription: string;
  modelUsed: string;
  capability: string;
  success: boolean;
  durationMs: number;
  retryCount: number;
  workerCount?: number;
  filesCreated?: number;
  errorSummary?: string;
}

export interface UserPreference {
  key: string;
  value: string;
  confidence: number;
  observedCount: number;
  lastObservedAt: number;
}

export interface BuildPattern {
  appType: string;        // 'ios_app' | 'web_app' | 'api_server' | 'cli_tool'
  framework: string;      // 'swiftui' | 'react' | 'express'
  architecture: string;   // 'mvvm' | 'mvc' | 'clean'
  fileStructure: string;  // JSON array of relative paths
  features: string;       // JSON array of feature names
  successCount: number;
  lastUsedAt: number;
}

export interface PersonalIntelligenceDiagnostics {
  taskOutcomes: { total: number; successRate: number; avgDuration: number; byType: Record<string, { count: number; successRate: number }> };
  preferences: UserPreference[];
  buildPatterns: BuildPattern[];
  modelInsights: Array<{ model: string; capability: string; successRate: number; avgLatency: number; uses: number }>;
}

// ── Schema ────────────────────────────────────────────────────────

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS pi_task_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_type TEXT NOT NULL,
  task_description TEXT NOT NULL,
  model_used TEXT NOT NULL,
  capability TEXT NOT NULL,
  success INTEGER NOT NULL DEFAULT 0,
  duration_ms REAL NOT NULL DEFAULT 0,
  retry_count INTEGER NOT NULL DEFAULT 0,
  worker_count INTEGER DEFAULT 0,
  files_created INTEGER DEFAULT 0,
  error_summary TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_pi_task_type ON pi_task_outcomes(task_type);
CREATE INDEX IF NOT EXISTS idx_pi_model ON pi_task_outcomes(model_used);

CREATE TABLE IF NOT EXISTS pi_user_preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.5,
  observed_count INTEGER NOT NULL DEFAULT 1,
  last_observed_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS pi_build_patterns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  app_type TEXT NOT NULL,
  framework TEXT NOT NULL,
  architecture TEXT NOT NULL,
  file_structure TEXT NOT NULL DEFAULT '[]',
  features TEXT NOT NULL DEFAULT '[]',
  success_count INTEGER NOT NULL DEFAULT 1,
  last_used_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS idx_pi_build_type ON pi_build_patterns(app_type, framework);
`;

// ── PersonalIntelligence ──────────────────────────────────────────

export class PersonalIntelligence {
  private db: SqliteMemoryDb;

  constructor(db: SqliteMemoryDb) {
    this.db = db;
    this.ensureSchema();
    log.info('Personal intelligence initialized');
  }

  private ensureSchema(): void {
    try { this.db.exec(SCHEMA_SQL); } catch { /* tables may exist */ }
  }

  // ── Task Outcome Tracking ─────────────────────────────────────

  recordTaskOutcome(outcome: TaskOutcome): void {
    this.db.prepare<unknown[]>(
      `INSERT INTO pi_task_outcomes (task_type, task_description, model_used, capability, success, duration_ms, retry_count, worker_count, files_created, error_summary)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      outcome.taskType, outcome.taskDescription.slice(0, 200),
      outcome.modelUsed, outcome.capability,
      outcome.success ? 1 : 0, outcome.durationMs,
      outcome.retryCount, outcome.workerCount ?? 0,
      outcome.filesCreated ?? 0, outcome.errorSummary ?? null,
    );

    // Auto-detect user preferences from task patterns
    this.detectPreferences(outcome);
  }

  getTaskHistory(taskType?: string, limit = 50): TaskOutcome[] {
    const sql = taskType
      ? `SELECT * FROM pi_task_outcomes WHERE task_type = ? ORDER BY created_at DESC LIMIT ?`
      : `SELECT * FROM pi_task_outcomes ORDER BY created_at DESC LIMIT ?`;
    const params = taskType ? [taskType, limit] : [limit];
    const rows = this.db.prepare<unknown[], Record<string, unknown>>(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => ({
      taskType: String(r.task_type),
      taskDescription: String(r.task_description),
      modelUsed: String(r.model_used),
      capability: String(r.capability),
      success: Boolean(r.success),
      durationMs: Number(r.duration_ms),
      retryCount: Number(r.retry_count),
      workerCount: Number(r.worker_count ?? 0),
      filesCreated: Number(r.files_created ?? 0),
      errorSummary: r.error_summary ? String(r.error_summary) : undefined,
    }));
  }

  /**
   * Get the best model for a task type based on historical success rate + speed.
   * Returns null if insufficient data.
   */
  getBestModelForTask(taskType: string, capability: string): { model: string; score: number; reason: string } | null {
    const rows = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT model_used,
              COUNT(*) as total,
              SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as successes,
              AVG(duration_ms) as avg_duration
       FROM pi_task_outcomes
       WHERE task_type = ? AND capability = ?
       GROUP BY model_used
       HAVING total >= 3
       ORDER BY (CAST(successes AS REAL) / total) DESC, avg_duration ASC
       LIMIT 1`
    ).all(taskType, capability) as Record<string, unknown>[];

    if (rows.length === 0) return null;

    const r = rows[0];
    const total = Number(r.total);
    const successes = Number(r.successes);
    const avgDuration = Number(r.avg_duration);
    const successRate = successes / total;

    return {
      model: String(r.model_used),
      score: successRate * 0.7 + (1 - Math.min(avgDuration / 30000, 1)) * 0.3,
      reason: `${successes}/${total} success (${(successRate * 100).toFixed(0)}%), avg ${(avgDuration / 1000).toFixed(1)}s`,
    };
  }

  // ── User Preference Learning ──────────────────────────────────

  private detectPreferences(outcome: TaskOutcome): void {
    // Detect preferred task types
    this.observePreference(`preferred_task_type`, outcome.taskType, 0.6);

    // Detect preferred frameworks from build tasks
    if (outcome.taskType === 'build_app' && outcome.success) {
      const desc = outcome.taskDescription.toLowerCase();
      if (desc.includes('swiftui') || desc.includes('ios')) {
        this.observePreference('preferred_platform', 'ios', 0.7);
        this.observePreference('preferred_framework', 'swiftui', 0.7);
      } else if (desc.includes('react')) {
        this.observePreference('preferred_framework', 'react', 0.7);
      } else if (desc.includes('express') || desc.includes('node')) {
        this.observePreference('preferred_framework', 'express', 0.7);
      }
    }

    // Detect speed preference
    if (outcome.durationMs < 10000 && outcome.success) {
      this.observePreference('execution_speed', 'fast', 0.5);
    } else if (outcome.durationMs > 60000 && outcome.success) {
      this.observePreference('execution_speed', 'thorough', 0.5);
    }
  }

  private observePreference(key: string, value: string, baseConfidence: number): void {
    const existing = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT * FROM pi_user_preferences WHERE key = ?`
    ).get(key) as Record<string, unknown> | undefined;

    if (existing && String(existing.value) === value) {
      // Reinforce
      const newCount = Number(existing.observed_count) + 1;
      const newConfidence = Math.min(1.0, baseConfidence + newCount * 0.05);
      this.db.prepare<unknown[]>(
        `UPDATE pi_user_preferences SET observed_count = ?, confidence = ?, last_observed_at = ? WHERE key = ?`
      ).run(newCount, newConfidence, Date.now(), key);
    } else if (!existing) {
      this.db.prepare<unknown[]>(
        `INSERT INTO pi_user_preferences (key, value, confidence, observed_count, last_observed_at) VALUES (?, ?, ?, 1, ?)`
      ).run(key, value, baseConfidence, Date.now());
    }
    // If existing but different value — only update if new observation is stronger
    // (avoids flip-flopping)
  }

  getPreferences(): UserPreference[] {
    const rows = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT * FROM pi_user_preferences ORDER BY confidence DESC`
    ).all() as Record<string, unknown>[];
    return rows.map(r => ({
      key: String(r.key),
      value: String(r.value),
      confidence: Number(r.confidence),
      observedCount: Number(r.observed_count),
      lastObservedAt: Number(r.last_observed_at),
    }));
  }

  getPreference(key: string): UserPreference | null {
    const r = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT * FROM pi_user_preferences WHERE key = ?`
    ).get(key) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      key: String(r.key),
      value: String(r.value),
      confidence: Number(r.confidence),
      observedCount: Number(r.observed_count),
      lastObservedAt: Number(r.last_observed_at),
    };
  }

  // ── Build Pattern Memory ──────────────────────────────────────

  recordBuildPattern(pattern: Omit<BuildPattern, 'successCount' | 'lastUsedAt'>): void {
    // Check for existing similar pattern
    const existing = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT id, success_count FROM pi_build_patterns WHERE app_type = ? AND framework = ? AND architecture = ?`
    ).get(pattern.appType, pattern.framework, pattern.architecture) as Record<string, unknown> | undefined;

    if (existing) {
      this.db.prepare<unknown[]>(
        `UPDATE pi_build_patterns SET success_count = success_count + 1, file_structure = ?, features = ?, last_used_at = ? WHERE id = ?`
      ).run(pattern.fileStructure, pattern.features, Date.now(), existing.id);
    } else {
      this.db.prepare<unknown[]>(
        `INSERT INTO pi_build_patterns (app_type, framework, architecture, file_structure, features, last_used_at) VALUES (?, ?, ?, ?, ?, ?)`
      ).run(pattern.appType, pattern.framework, pattern.architecture, pattern.fileStructure, pattern.features, Date.now());
    }
  }

  getBuildPattern(appType: string, framework?: string): BuildPattern | null {
    const sql = framework
      ? `SELECT * FROM pi_build_patterns WHERE app_type = ? AND framework = ? ORDER BY success_count DESC LIMIT 1`
      : `SELECT * FROM pi_build_patterns WHERE app_type = ? ORDER BY success_count DESC LIMIT 1`;
    const params = framework ? [appType, framework] : [appType];
    const r = this.db.prepare<unknown[], Record<string, unknown>>(sql).get(...params) as Record<string, unknown> | undefined;
    if (!r) return null;
    return {
      appType: String(r.app_type),
      framework: String(r.framework),
      architecture: String(r.architecture),
      fileStructure: String(r.file_structure),
      features: String(r.features),
      successCount: Number(r.success_count),
      lastUsedAt: Number(r.last_used_at),
    };
  }

  // ── Model Insights ────────────────────────────────────────────

  getModelInsights(): Array<{ model: string; capability: string; successRate: number; avgLatency: number; uses: number }> {
    const rows = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT model_used, capability,
              COUNT(*) as uses,
              ROUND(CAST(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS REAL) / COUNT(*), 3) as success_rate,
              ROUND(AVG(duration_ms)) as avg_lat
       FROM pi_task_outcomes
       GROUP BY model_used, capability
       ORDER BY uses DESC`
    ).all() as Record<string, unknown>[];

    return rows.map(r => ({
      model: String(r.model_used),
      capability: String(r.capability),
      successRate: Number(r.success_rate),
      avgLatency: Number(r.avg_lat),
      uses: Number(r.uses),
    }));
  }

  // ── Diagnostics ───────────────────────────────────────────────

  getDiagnostics(): PersonalIntelligenceDiagnostics {
    const totalRow = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT COUNT(*) as cnt, ROUND(CAST(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1), 3) as rate, ROUND(AVG(duration_ms)) as avg_dur FROM pi_task_outcomes`
    ).get() as Record<string, unknown>;

    const byTypeRows = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT task_type, COUNT(*) as cnt, ROUND(CAST(SUM(CASE WHEN success=1 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1), 3) as rate FROM pi_task_outcomes GROUP BY task_type`
    ).all() as Record<string, unknown>[];

    const byType: Record<string, { count: number; successRate: number }> = {};
    for (const r of byTypeRows) {
      byType[String(r.task_type)] = { count: Number(r.cnt), successRate: Number(r.rate) };
    }

    return {
      taskOutcomes: {
        total: Number(totalRow?.cnt ?? 0),
        successRate: Number(totalRow?.rate ?? 0),
        avgDuration: Number(totalRow?.avg_dur ?? 0),
        byType,
      },
      preferences: this.getPreferences(),
      buildPatterns: this.db.prepare<unknown[], Record<string, unknown>>(
        `SELECT * FROM pi_build_patterns ORDER BY success_count DESC LIMIT 10`
      ).all().map((r: Record<string, unknown>) => ({
        appType: String(r.app_type),
        framework: String(r.framework),
        architecture: String(r.architecture),
        fileStructure: String(r.file_structure),
        features: String(r.features),
        successCount: Number(r.success_count),
        lastUsedAt: Number(r.last_used_at),
      })),
      modelInsights: this.getModelInsights(),
    };
  }
}
