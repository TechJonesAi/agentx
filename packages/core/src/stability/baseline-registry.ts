/**
 * Baseline Registry — Persistent feature baseline tracking
 *
 * Tracks features through candidate → validated → locked lifecycle.
 * Locked features trigger CRITICAL regression if they fail.
 * Persists to SQLite baseline_features table.
 */

import type { SqliteMemoryDb } from '../db/sqlite-memory.js';
import { createLogger } from '../logger.js';
import type { BaselineFeature, BaselineStatus, BaselineDiagnostics } from './baseline-types.js';

const log = createLogger('stability:baseline-registry');

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS baseline_features (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  subsystem TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'candidate',
  validation_score REAL NOT NULL DEFAULT 0,
  last_validated_at INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_baseline_status ON baseline_features(status);
CREATE INDEX IF NOT EXISTS idx_baseline_subsystem ON baseline_features(subsystem);
`;

export class BaselineRegistry {
  private db: SqliteMemoryDb;

  constructor(db: SqliteMemoryDb) {
    this.db = db;
    this.ensureSchema();
    log.info('Baseline registry initialized');
  }

  private ensureSchema(): void {
    try {
      this.db.exec(SCHEMA_SQL);
    } catch {
      // Table may already exist
    }
  }

  registerFeature(feature: Omit<BaselineFeature, 'locked'> & { locked?: boolean }): BaselineFeature {
    const now = Date.now();
    const locked = feature.locked ?? (feature.status === 'locked');

    this.db.prepare<unknown[]>(
      `INSERT OR REPLACE INTO baseline_features (id, name, subsystem, status, validation_score, last_validated_at, locked, notes, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      feature.id, feature.name, feature.subsystem, feature.status,
      feature.validationScore, feature.lastValidatedAt || now,
      locked ? 1 : 0, feature.notes ?? null, now
    );

    log.info({ id: feature.id, status: feature.status }, 'Feature registered');

    return { ...feature, locked };
  }

  updateStatus(id: string, status: BaselineStatus): void {
    const now = Date.now();
    const locked = status === 'locked' ? 1 : 0;

    const result = this.db.prepare<unknown[]>(
      `UPDATE baseline_features SET status = ?, locked = ?, updated_at = ? WHERE id = ?`
    ).run(status, locked, now, id);

    if ((result as { changes: number }).changes === 0) {
      throw new Error(`Feature '${id}' not found`);
    }

    log.info({ id, status }, 'Feature status updated');
  }

  lockFeature(id: string): void {
    const now = Date.now();

    const result = this.db.prepare<unknown[]>(
      `UPDATE baseline_features SET status = 'locked', locked = 1, updated_at = ? WHERE id = ?`
    ).run(now, id);

    if ((result as { changes: number }).changes === 0) {
      throw new Error(`Feature '${id}' not found`);
    }

    log.info({ id }, 'Feature locked — will trigger CRITICAL regression if it fails');
  }

  getFeature(id: string): BaselineFeature | null {
    const row = this.db.prepare<unknown[]>(
      `SELECT * FROM baseline_features WHERE id = ?`
    ).get(id) as Record<string, unknown> | undefined;

    return row ? this.rowToFeature(row) : null;
  }

  getLockedFeatures(): BaselineFeature[] {
    const rows = this.db.prepare<unknown[]>(
      `SELECT * FROM baseline_features WHERE locked = 1 ORDER BY subsystem, name`
    ).all() as Record<string, unknown>[];

    return rows.map(r => this.rowToFeature(r));
  }

  getAllFeatures(): BaselineFeature[] {
    const rows = this.db.prepare<unknown[]>(
      `SELECT * FROM baseline_features ORDER BY subsystem, status, name`
    ).all() as Record<string, unknown>[];

    return rows.map(r => this.rowToFeature(r));
  }

  getFeaturesBySubsystem(subsystem: string): BaselineFeature[] {
    const rows = this.db.prepare<unknown[]>(
      `SELECT * FROM baseline_features WHERE subsystem = ? ORDER BY status, name`
    ).all(subsystem) as Record<string, unknown>[];

    return rows.map(r => this.rowToFeature(r));
  }

  getDiagnostics(): BaselineDiagnostics {
    const all = this.getAllFeatures();
    return {
      totalFeatures: all.length,
      candidateFeatures: all.filter(f => f.status === 'candidate').length,
      validatedFeatures: all.filter(f => f.status === 'validated').length,
      lockedFeatures: all.filter(f => f.status === 'locked').length,
      regressionHistory: [],
      lastCheckAt: all.length > 0 ? Math.max(...all.map(f => f.lastValidatedAt)) : null,
    };
  }

  private rowToFeature(row: Record<string, unknown>): BaselineFeature {
    return {
      id: String(row.id),
      name: String(row.name),
      subsystem: String(row.subsystem),
      status: String(row.status) as BaselineStatus,
      validationScore: Number(row.validation_score ?? 0),
      lastValidatedAt: Number(row.last_validated_at ?? 0),
      locked: Boolean(row.locked),
      notes: row.notes ? String(row.notes) : undefined,
    };
  }
}
