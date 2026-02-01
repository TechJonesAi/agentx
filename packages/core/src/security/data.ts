import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('security:data');

// ─── Data Isolation & Management ─────────────────────────────────────────────

export interface DataExport {
  exportedAt: string;
  version: string;
  sessions: ExportedSession[];
  longTermMemory: ExportedMemory[];
  auditLog: ExportedAuditEntry[];
}

interface ExportedSession {
  id: string;
  platform: string | null;
  userId: string | null;
  createdAt: number;
  updatedAt: number;
  messages: ExportedMessage[];
}

interface ExportedMessage {
  role: string;
  content: string;
  timestamp: number;
}

interface ExportedMemory {
  id: string;
  content: string;
  tags: string[];
  createdAt: number;
}

interface ExportedAuditEntry {
  timestamp: number;
  action: string;
  details: string;
  platform: string | null;
}

export class DataManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /**
   * Export all data for a specific platform (GDPR-style takeout).
   */
  exportByPlatform(platform: string): DataExport {
    log.info({ platform }, 'Exporting platform data');

    const sessions = this.db.prepare(`
      SELECT * FROM sessions WHERE platform = ?
    `).all(platform) as Array<{
      id: string; user_id: string | null; platform: string | null;
      metadata: string; created_at: number; updated_at: number;
    }>;

    const exportedSessions: ExportedSession[] = sessions.map((s) => {
      const messages = this.db.prepare(`
        SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC
      `).all(s.id) as ExportedMessage[];

      return {
        id: s.id,
        platform: s.platform,
        userId: s.user_id,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        messages,
      };
    });

    const auditEntries = this.db.prepare(`
      SELECT timestamp, action, details, platform FROM audit_log WHERE platform = ? ORDER BY timestamp ASC
    `).all(platform) as ExportedAuditEntry[];

    return {
      exportedAt: new Date().toISOString(),
      version: '0.1.0',
      sessions: exportedSessions,
      longTermMemory: [], // LTM is not platform-specific
      auditLog: auditEntries,
    };
  }

  /**
   * Export all data.
   */
  exportAll(): DataExport {
    log.info('Exporting all data');

    const sessions = this.db.prepare('SELECT * FROM sessions').all() as Array<{
      id: string; user_id: string | null; platform: string | null;
      metadata: string; created_at: number; updated_at: number;
    }>;

    const exportedSessions: ExportedSession[] = sessions.map((s) => {
      const messages = this.db.prepare(`
        SELECT role, content, timestamp FROM messages WHERE session_id = ? ORDER BY timestamp ASC
      `).all(s.id) as ExportedMessage[];

      return {
        id: s.id,
        platform: s.platform,
        userId: s.user_id,
        createdAt: s.created_at,
        updatedAt: s.updated_at,
        messages,
      };
    });

    const memories = this.db.prepare('SELECT * FROM long_term_memory ORDER BY created_at ASC').all() as Array<{
      id: string; content: string; tags: string; created_at: number;
    }>;

    const auditEntries = this.db.prepare(
      'SELECT timestamp, action, details, platform FROM audit_log ORDER BY timestamp ASC',
    ).all() as ExportedAuditEntry[];

    return {
      exportedAt: new Date().toISOString(),
      version: '0.1.0',
      sessions: exportedSessions,
      longTermMemory: memories.map((m) => ({
        id: m.id,
        content: m.content,
        tags: JSON.parse(m.tags),
        createdAt: m.created_at,
      })),
      auditLog: auditEntries,
    };
  }

  /**
   * Write export to a JSON file.
   */
  exportToFile(filePath: string, platform?: string): void {
    const data = platform ? this.exportByPlatform(platform) : this.exportAll();
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    log.info({ filePath, platform }, 'Data exported to file');
  }

  /**
   * Delete all data for a specific platform.
   */
  deleteByPlatform(platform: string): DeleteResult {
    log.warn({ platform }, 'Deleting all platform data');

    const sessions = this.db.prepare('SELECT id FROM sessions WHERE platform = ?').all(platform) as Array<{ id: string }>;
    const sessionIds = sessions.map((s) => s.id);

    let messagesDeleted = 0;
    for (const sid of sessionIds) {
      const result = this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid);
      messagesDeleted += result.changes;
    }

    const sessionsResult = this.db.prepare('DELETE FROM sessions WHERE platform = ?').run(platform);
    const auditResult = this.db.prepare('DELETE FROM audit_log WHERE platform = ?').run(platform);

    return {
      sessionsDeleted: sessionsResult.changes,
      messagesDeleted,
      auditEntriesDeleted: auditResult.changes,
    };
  }

  /**
   * Delete a specific session and all its messages.
   */
  deleteSession(sessionId: string): DeleteResult {
    log.warn({ sessionId }, 'Deleting session');

    const messagesResult = this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
    const sessionResult = this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);

    return {
      sessionsDeleted: sessionResult.changes,
      messagesDeleted: messagesResult.changes,
      auditEntriesDeleted: 0,
    };
  }

  /**
   * Delete ALL data (nuclear option).
   */
  deleteAll(): DeleteResult {
    log.warn('Deleting ALL data');

    const messages = this.db.prepare('DELETE FROM messages').run();
    const sessions = this.db.prepare('DELETE FROM sessions').run();
    const memory = this.db.prepare('DELETE FROM long_term_memory').run();
    const audit = this.db.prepare('DELETE FROM audit_log').run();
    const tasks = this.db.prepare('DELETE FROM scheduled_tasks').run();

    // VACUUM to reclaim space and overwrite deleted data
    this.db.pragma('wal_checkpoint(TRUNCATE)');
    this.db.exec('VACUUM');

    return {
      sessionsDeleted: sessions.changes,
      messagesDeleted: messages.changes,
      auditEntriesDeleted: audit.changes,
      memoryEntriesDeleted: memory.changes,
    };
  }

  /**
   * Get data statistics per platform.
   */
  getStats(): PlatformStats[] {
    const rows = this.db.prepare(`
      SELECT
        s.platform,
        COUNT(DISTINCT s.id) as session_count,
        COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON m.session_id = s.id
      GROUP BY s.platform
    `).all() as Array<{
      platform: string | null;
      session_count: number;
      message_count: number;
    }>;

    return rows.map((r) => ({
      platform: r.platform ?? 'unknown',
      sessionCount: r.session_count,
      messageCount: r.message_count,
    }));
  }
}

export interface DeleteResult {
  sessionsDeleted: number;
  messagesDeleted: number;
  auditEntriesDeleted: number;
  memoryEntriesDeleted?: number;
}

export interface PlatformStats {
  platform: string;
  sessionCount: number;
  messageCount: number;
}
