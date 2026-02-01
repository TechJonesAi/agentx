import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';
import { redactSecrets } from './keychain.js';

const log = createLogger('security:audit');

// ─── Audit Event Types ───────────────────────────────────────────────────────

export type AuditAction =
  | 'shell_execute'
  | 'tool_call'
  | 'tool_result'
  | 'message_sent'
  | 'message_received'
  | 'file_read'
  | 'file_write'
  | 'network_request'
  | 'skill_loaded'
  | 'skill_unloaded'
  | 'session_created'
  | 'session_ended'
  | 'credential_read'
  | 'credential_write'
  | 'credential_delete'
  | 'auth_attempt'
  | 'auth_success'
  | 'auth_failure'
  | 'config_change'
  | 'data_export'
  | 'data_delete';

export interface AuditEntry {
  id: string;
  timestamp: number;
  action: AuditAction;
  sessionId?: string;
  platform?: string;
  details: string;
  metadata?: Record<string, unknown>;
  success: boolean;
}

export interface AuditQueryOptions {
  action?: AuditAction;
  sessionId?: string;
  platform?: string;
  since?: number;
  until?: number;
  limit?: number;
  offset?: number;
}

// ─── Audit Logger ────────────────────────────────────────────────────────────

export class AuditLogger {
  private db: Database.Database;
  private enabled: boolean;
  private retentionDays: number;

  constructor(db: Database.Database, enabled = true, retentionDays = 90) {
    this.db = db;
    this.enabled = enabled;
    this.retentionDays = retentionDays;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        action TEXT NOT NULL,
        session_id TEXT,
        platform TEXT,
        details TEXT NOT NULL,
        metadata TEXT,
        success INTEGER NOT NULL DEFAULT 1
      );

      CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);
      CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id);
    `);
  }

  log(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
    if (!this.enabled) return;

    const id = uuid();
    const timestamp = Date.now();

    // Redact any secrets that might appear in details
    const safeDetails = redactSecrets(entry.details);

    try {
      this.db.prepare(`
        INSERT INTO audit_log (id, timestamp, action, session_id, platform, details, metadata, success)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        timestamp,
        entry.action,
        entry.sessionId ?? null,
        entry.platform ?? null,
        safeDetails,
        entry.metadata ? JSON.stringify(entry.metadata) : null,
        entry.success ? 1 : 0,
      );
    } catch (error) {
      log.error({ error }, 'Failed to write audit log entry');
    }
  }

  query(options: AuditQueryOptions = {}): AuditEntry[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.action) {
      conditions.push('action = ?');
      params.push(options.action);
    }
    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }
    if (options.platform) {
      conditions.push('platform = ?');
      params.push(options.platform);
    }
    if (options.since) {
      conditions.push('timestamp >= ?');
      params.push(options.since);
    }
    if (options.until) {
      conditions.push('timestamp <= ?');
      params.push(options.until);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const rows = this.db.prepare(`
      SELECT * FROM audit_log
      ${where}
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as Array<{
      id: string;
      timestamp: number;
      action: string;
      session_id: string | null;
      platform: string | null;
      details: string;
      metadata: string | null;
      success: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      action: row.action as AuditAction,
      sessionId: row.session_id ?? undefined,
      platform: row.platform ?? undefined,
      details: row.details,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      success: row.success === 1,
    }));
  }

  count(options: AuditQueryOptions = {}): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (options.action) {
      conditions.push('action = ?');
      params.push(options.action);
    }
    if (options.since) {
      conditions.push('timestamp >= ?');
      params.push(options.since);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = this.db.prepare(`SELECT COUNT(*) as count FROM audit_log ${where}`).get(...params) as { count: number };
    return result.count;
  }

  /**
   * Export audit log as JSON for review.
   */
  export(options?: AuditQueryOptions): string {
    const entries = this.query({ ...options, limit: 10000 });
    return JSON.stringify(entries, null, 2);
  }

  /**
   * Purge entries older than retention period.
   */
  purgeOld(): number {
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    const result = this.db.prepare('DELETE FROM audit_log WHERE timestamp < ?').run(cutoff);
    const deleted = result.changes;
    if (deleted > 0) {
      log.info({ deleted, retentionDays: this.retentionDays }, 'Purged old audit entries');
    }
    return deleted;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
