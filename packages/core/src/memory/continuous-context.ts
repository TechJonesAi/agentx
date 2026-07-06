// ---------------------------------------------------------------------------
// P12-2 — Continuous Context: "never lose the thread".
//
// Three durability guarantees this module adds on top of the existing
// conversation stack:
//
//   1. CONVERSATION ARCHIVE — when the ContextManager summarises older
//      turns out of the LLM window, those turns (and the summary that
//      replaced them) are persisted here and indexed in FTS5. Anything
//      compacted out of the window remains RETRIEVABLE: "what did we
//      decide about X last week?" finds the original turn, not a lossy
//      summary. Before P12-2, summaries lived in an in-memory Map (lost
//      on restart) and summarised-out turns were unreachable.
//
//   2. SESSION BRIDGING — when a fresh session starts and an earlier
//      session left an archive, a compact recap (last summary + recent
//      decisions) is available for injection so a new session never
//      boots as a blank slate.
//
//   3. DECISION JOURNAL — structured, queryable record of the moments
//      that matter: compactions, session bridges, safe-failures, model
//      escalations, user corrections. Powers both the recap and
//      "why did you do X?" introspection.
//
// Storage: the agent's own SQLite db (same handle as sessions/telemetry).
// Pure-local. All writes are best-effort — a failure here must never
// break a chat turn.
// ---------------------------------------------------------------------------

import type BetterSqlite3 from 'better-sqlite3';
import { createLogger } from '../logger.js';
import type { Message } from '../types.js';

const log = createLogger('memory:continuous-context');

export interface ArchivedTurn {
  id: number;
  session_id: string;
  role: string;
  content: string;
  turn_timestamp: number;
  batch_id: string;
  kind: 'turn' | 'summary';
  created_at: string;
}

export interface DecisionJournalEntry {
  id: number;
  session_id: string | null;
  kind: string;
  title: string;
  detail_json: string | null;
  created_at: string;
}

export interface BridgeContext {
  /** The most recent archived summary for any earlier session. */
  lastSummary: string | null;
  /** Session the summary came from. */
  lastSessionId: string | null;
  /** Recent journal entries (most recent first, capped). */
  recentDecisions: Array<{ kind: string; title: string; created_at: string }>;
}

export class ContinuousContextStore {
  constructor(private db: BetterSqlite3.Database) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_archive (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        turn_timestamp INTEGER NOT NULL,
        batch_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'turn',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_conv_archive_session ON conversation_archive(session_id);
      CREATE INDEX IF NOT EXISTS idx_conv_archive_batch ON conversation_archive(batch_id);
      CREATE INDEX IF NOT EXISTS idx_conv_archive_kind ON conversation_archive(kind);

      CREATE TABLE IF NOT EXISTS decision_journal (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        detail_json TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_decision_journal_kind ON decision_journal(kind);
      CREATE INDEX IF NOT EXISTS idx_decision_journal_session ON decision_journal(session_id);
    `);
    // FTS is best-effort — SQLite builds without FTS5 degrade to LIKE.
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS conversation_archive_fts USING fts5(
          archive_id UNINDEXED,
          session_id UNINDEXED,
          content,
          tokenize = 'porter unicode61'
        );
      `);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'conversation_archive_fts unavailable — search degrades to LIKE',
      );
    }
  }

  /* ── 1. Conversation archive ─────────────────────────────────────── */

  /**
   * Persist a batch of summarised-out turns plus the summary that
   * replaced them. Called by the ContextManager's archive sink each
   * time compaction fires. Idempotency: batch_id dedupes — re-archiving
   * the same batch is a no-op.
   */
  archiveCompactedTurns(
    sessionId: string,
    olderMessages: ReadonlyArray<Message>,
    summary: string | null,
    batchId: string,
  ): { archived: number } {
    try {
      const exists = this.db
        .prepare('SELECT 1 FROM conversation_archive WHERE batch_id = ? LIMIT 1')
        .get(batchId);
      if (exists) return { archived: 0 };

      const insert = this.db.prepare(`
        INSERT INTO conversation_archive (session_id, role, content, turn_timestamp, batch_id, kind)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      let ftsInsert: BetterSqlite3.Statement | null = null;
      try {
        ftsInsert = this.db.prepare(`
          INSERT INTO conversation_archive_fts (archive_id, session_id, content)
          VALUES (?, ?, ?)
        `);
      } catch { /* FTS unavailable */ }

      let archived = 0;
      const tx = this.db.transaction(() => {
        for (const m of olderMessages) {
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          if (!content || content.trim().length === 0) continue;
          const info = insert.run(sessionId, m.role, content, m.timestamp ?? Date.now(), batchId, 'turn');
          if (ftsInsert) {
            try { ftsInsert.run(info.lastInsertRowid, sessionId, content); } catch { /* */ }
          }
          archived += 1;
        }
        if (summary && summary.trim().length > 0) {
          const info = insert.run(sessionId, 'system', summary, Date.now(), batchId, 'summary');
          if (ftsInsert) {
            try { ftsInsert.run(info.lastInsertRowid, sessionId, summary); } catch { /* */ }
          }
          archived += 1;
        }
      });
      tx();
      log.info({ sessionId, batchId, archived }, 'P12-2: compacted turns archived (retrievable)');
      return { archived };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), sessionId },
        'archiveCompactedTurns failed — chat continues without archive',
      );
      return { archived: 0 };
    }
  }

  /**
   * Search archived conversation turns. FTS5 when available, LIKE
   * fallback otherwise. Returns most-relevant first, capped.
   */
  searchArchive(query: string, limit = 5): ArchivedTurn[] {
    const q = (query ?? '').trim();
    if (q.length < 3) return [];
    // FTS path
    try {
      const tokens = q
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .split(/\s+/)
        .filter((t) => t.length >= 3)
        .slice(0, 8);
      if (tokens.length > 0) {
        const rows = this.db
          .prepare(`
            SELECT ca.* FROM conversation_archive_fts fts
            JOIN conversation_archive ca ON ca.id = fts.archive_id
            WHERE conversation_archive_fts MATCH ?
            ORDER BY bm25(conversation_archive_fts) ASC
            LIMIT ?
          `)
          .all(tokens.join(' OR '), limit) as ArchivedTurn[];
        if (rows.length > 0) return rows;
      }
    } catch { /* fall through to LIKE */ }
    try {
      const like = `%${q.toLowerCase()}%`;
      return this.db
        .prepare(`
          SELECT * FROM conversation_archive
          WHERE lower(content) LIKE ?
          ORDER BY id DESC LIMIT ?
        `)
        .all(like, limit) as ArchivedTurn[];
    } catch {
      return [];
    }
  }

  /* ── 2. Session bridging ─────────────────────────────────────────── */

  /**
   * Build the recap for a brand-new session: the most recent archived
   * summary from ANY earlier session plus recent journal entries.
   * Returns null when there is nothing to bridge (first ever session).
   */
  getBridgeContext(excludeSessionId?: string): BridgeContext | null {
    try {
      const summaryRow = this.db
        .prepare(`
          SELECT session_id, content FROM conversation_archive
          WHERE kind = 'summary' ${excludeSessionId ? 'AND session_id != ?' : ''}
          ORDER BY id DESC LIMIT 1
        `)
        .get(...(excludeSessionId ? [excludeSessionId] : [])) as
        | { session_id: string; content: string }
        | undefined;

      const decisions = this.db
        .prepare(`
          SELECT kind, title, created_at FROM decision_journal
          ORDER BY id DESC LIMIT 5
        `)
        .all() as Array<{ kind: string; title: string; created_at: string }>;

      if (!summaryRow && decisions.length === 0) return null;
      return {
        lastSummary: summaryRow?.content ?? null,
        lastSessionId: summaryRow?.session_id ?? null,
        recentDecisions: decisions,
      };
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'getBridgeContext failed',
      );
      return null;
    }
  }

  /**
   * Render the bridge as a compact system-context block. Hard cap keeps
   * prompt overhead small (~1200 chars max).
   */
  renderBridgeBlock(bridge: BridgeContext): string {
    const lines: string[] = ['[Previous session recap]'];
    if (bridge.lastSummary) {
      lines.push(bridge.lastSummary.slice(0, 900));
    }
    if (bridge.recentDecisions.length > 0) {
      lines.push('Recent notable events:');
      for (const d of bridge.recentDecisions.slice(0, 4)) {
        lines.push(`- [${d.kind}] ${d.title.slice(0, 100)}`);
      }
    }
    return lines.join('\n').slice(0, 1200);
  }

  /* ── 3. Decision journal ─────────────────────────────────────────── */

  /**
   * Record a structured decision event. Never throws.
   * Kinds in use: 'compaction', 'session_bridge', 'safe_failure',
   * 'model_escalation', 'user_correction', 'error'. Free-form kinds
   * are allowed so future phases can add their own without migration.
   */
  recordDecision(
    kind: string,
    title: string,
    detail?: Record<string, unknown>,
    sessionId?: string | null,
  ): void {
    try {
      this.db
        .prepare(`
          INSERT INTO decision_journal (session_id, kind, title, detail_json)
          VALUES (?, ?, ?, ?)
        `)
        .run(sessionId ?? null, kind, title.slice(0, 300), detail ? JSON.stringify(detail).slice(0, 4000) : null);
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err), kind },
        'recordDecision failed',
      );
    }
  }

  /** Query the journal (most recent first). Optional kind filter. */
  listDecisions(opts: { kind?: string; limit?: number } = {}): DecisionJournalEntry[] {
    try {
      const limit = Math.min(Math.max(opts.limit ?? 20, 1), 200);
      if (opts.kind) {
        return this.db
          .prepare('SELECT * FROM decision_journal WHERE kind = ? ORDER BY id DESC LIMIT ?')
          .all(opts.kind, limit) as DecisionJournalEntry[];
      }
      return this.db
        .prepare('SELECT * FROM decision_journal ORDER BY id DESC LIMIT ?')
        .all(limit) as DecisionJournalEntry[];
    } catch {
      return [];
    }
  }

  /** Diagnostics for the dashboard. */
  getStats(): { archivedTurns: number; summaries: number; journalEntries: number } {
    try {
      const t = this.db.prepare("SELECT COUNT(*) AS n FROM conversation_archive WHERE kind='turn'").get() as { n: number };
      const s = this.db.prepare("SELECT COUNT(*) AS n FROM conversation_archive WHERE kind='summary'").get() as { n: number };
      const j = this.db.prepare('SELECT COUNT(*) AS n FROM decision_journal').get() as { n: number };
      return { archivedTurns: t.n, summaries: s.n, journalEntries: j.n };
    } catch {
      return { archivedTurns: 0, summaries: 0, journalEntries: 0 };
    }
  }
}
