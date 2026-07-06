import type Database from 'better-sqlite3';
import type { Message, MemoryEntry } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('memory:conversation');

export class ConversationMemory {
  private db: Database.Database;
  private maxHistory: number;
  private summarizeAfter: number;

  constructor(db: Database.Database, maxHistory = 100, summarizeAfter = 50) {
    this.db = db;
    this.maxHistory = maxHistory;
    this.summarizeAfter = summarizeAfter;
  }

  addMessage(sessionId: string, message: Message): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (session_id, role, content, tool_call_id, tool_calls, timestamp, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      sessionId,
      message.role,
      message.content,
      message.toolCallId ?? null,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.timestamp,
      null,
    );
  }

  getMessages(sessionId: string, limit?: number): Message[] {
    const effectiveLimit = limit ?? this.maxHistory;
    // Keep the most RECENT N messages, returned in chronological order.
    // (ASC LIMIT kept the OLDEST N — once a session grew past the limit the
    // model stopped seeing its own latest work and "forgot" mid-conversation.)
    const stmt = this.db.prepare(`
      SELECT role, content, tool_call_id, tool_calls, timestamp FROM (
        SELECT rowid AS rid, role, content, tool_call_id, tool_calls, timestamp
        FROM messages
        WHERE session_id = ?
        ORDER BY timestamp DESC, rid DESC
        LIMIT ?
      )
      ORDER BY timestamp ASC, rid ASC
    `);

    const rows = stmt.all(sessionId, effectiveLimit) as Array<{
      role: string;
      content: string;
      tool_call_id: string | null;
      tool_calls: string | null;
      timestamp: number;
    }>;

    return rows.map((row) => ({
      role: row.role as Message['role'],
      content: row.content,
      toolCallId: row.tool_call_id ?? undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      timestamp: row.timestamp,
    }));
  }

  getMessageCount(sessionId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as { count: number };
    return row.count;
  }

  needsSummarization(sessionId: string): boolean {
    return this.getMessageCount(sessionId) > this.summarizeAfter;
  }

  clearMessages(sessionId: string): void {
    const stmt = this.db.prepare('DELETE FROM messages WHERE session_id = ?');
    stmt.run(sessionId);
  }

  getRecentContext(sessionId: string, count = 20): Message[] {
    const stmt = this.db.prepare(`
      SELECT role, content, tool_call_id, tool_calls, timestamp
      FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(sessionId, count) as Array<{
      role: string;
      content: string;
      tool_call_id: string | null;
      tool_calls: string | null;
      timestamp: number;
    }>;

    return rows.reverse().map((row) => ({
      role: row.role as Message['role'],
      content: row.content,
      toolCallId: row.tool_call_id ?? undefined,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      timestamp: row.timestamp,
    }));
  }
}
