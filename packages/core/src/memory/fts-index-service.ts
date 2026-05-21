import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';

const log = createLogger('memory:fts-index');

/**
 * Sanitize a natural-language query into a syntactically-valid FTS5 MATCH
 * expression. FTS5 treats `-`, `*`, `:`, `"`, `(`, `)`, `^`, `+`, and a
 * few keywords (NEAR, AND, OR, NOT) as operators — feeding a raw user
 * question containing any of these silently fails or returns zero results.
 *
 * This function:
 *  - lowercases
 *  - strips diacritics
 *  - drops every non-alphanumeric/space character (so `it's` → `it s`)
 *  - removes 1-character tokens that aren't digits
 *  - joins the surviving terms with implicit-AND spacing (FTS5 default)
 *  - if the original looked like a quoted phrase ("two words"), preserves
 *    that as a phrase token
 *  - returns null when nothing usable survives (caller MUST treat null as
 *    "do not run this match — return empty results")
 */
export function safeFtsQuery(input: string): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw) return null;

  // Preserve quoted phrases as FTS5 phrase tokens.
  const phrases: string[] = [];
  const phraseFree = raw.replace(/"([^"]+)"/g, (_, p: string) => {
    const cleaned = sanitizeToken(p);
    if (cleaned) phrases.push(`"${cleaned}"`);
    return ' ';
  });

  const terms = phraseFree
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .split(/[^a-z0-9]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 || /^[0-9]+$/.test(t))
    // FTS5 keywords that must not be left bare (would be interpreted as ops)
    .filter((t) => !['and', 'or', 'not', 'near'].includes(t));

  const tokens = [...phrases, ...terms];
  if (tokens.length === 0) return null;
  return tokens.join(' ');
}

function sanitizeToken(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export interface DocumentFtsContent {
  title?: string;
  sender?: string;
  recipient?: string;
  subject?: string;
  content: string;
  file_name?: string;
}

export class FtsIndexService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  upsertDocumentFts(documentId: string, content: DocumentFtsContent): void {
    try {
      // The auto-insert trigger on `documents` already created an FTS row at the
      // documents.rowid. We rebuild it here with full content. The post-007
      // FTS table is contentless, so DELETE+INSERT keyed on rowid is safe.
      const row = this.db.prepare('SELECT rowid FROM documents WHERE document_id = ?').get(documentId) as { rowid: number } | undefined;
      if (!row) {
        log.warn({ documentId }, 'upsertDocumentFts: document not found');
        return;
      }
      this.db.prepare(`INSERT INTO documents_fts(documents_fts, rowid) VALUES('delete', ?)`).run(row.rowid);
      this.db.prepare(`
        INSERT INTO documents_fts(rowid, document_id, title, sender, recipient, subject, content, file_name)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.rowid,
        documentId,
        content.title ?? '',
        content.sender ?? '',
        content.recipient ?? '',
        content.subject ?? '',
        content.content,
        content.file_name ?? '',
      );
      this.markDocumentSynced(documentId);
    } catch (error) {
      log.error({ documentId, error }, 'Failed to upsert document FTS');
      throw error;
    }
  }

  upsertChunkFts(chunkId: string, documentId: string, content: string): void {
    try {
      const row = this.db.prepare('SELECT rowid FROM document_chunks WHERE chunk_id = ?').get(chunkId) as { rowid: number } | undefined;
      if (!row) {
        log.warn({ chunkId }, 'upsertChunkFts: chunk not found');
        return;
      }
      this.db.prepare(`INSERT INTO chunks_fts(chunks_fts, rowid) VALUES('delete', ?)`).run(row.rowid);
      this.db.prepare(`
        INSERT INTO chunks_fts(rowid, chunk_id, document_id, content)
        VALUES (?, ?, ?, ?)
      `).run(row.rowid, chunkId, documentId, content);
      this.markChunkSynced(chunkId);
    } catch (error) {
      log.error({ chunkId, documentId, error }, 'Failed to upsert chunk FTS');
      throw error;
    }
  }

  searchDocuments(query: string, limit: number = 10): Array<{ document_id: string; rank: number }> {
    // Batch 4: sanitize natural-language queries so punctuation / hyphens /
    // FTS5 keywords don't silently zero-out the result set.
    const safe = safeFtsQuery(query);
    if (!safe) {
      log.debug({ query }, 'FTS document search skipped — query reduced to empty after sanitization');
      return [];
    }
    try {
      // Contentless FTS5 doesn't store column values; resolve document_id via
      // rowid join with the source documents table.
      const stmt = this.db.prepare(`
        SELECT d.document_id AS document_id, fts.rank AS rank
        FROM documents_fts fts
        JOIN documents d ON d.rowid = fts.rowid
        WHERE documents_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `);

      const results = stmt.all(safe, limit) as Array<{ document_id: string; rank: number }>;
      return results;
    } catch (error) {
      log.error({ query, safe, error }, 'Document FTS search failed');
      return [];
    }
  }

  searchChunks(query: string, limit: number = 10): Array<{ chunk_id: string; document_id: string; rank: number }> {
    const safe = safeFtsQuery(query);
    if (!safe) {
      log.debug({ query }, 'FTS chunk search skipped — query reduced to empty after sanitization');
      return [];
    }
    try {
      // Contentless FTS5 — resolve chunk_id and document_id via rowid join.
      const stmt = this.db.prepare(`
        SELECT c.chunk_id AS chunk_id, c.document_id AS document_id, fts.rank AS rank
        FROM chunks_fts fts
        JOIN document_chunks c ON c.rowid = fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY fts.rank
        LIMIT ?
      `);

      const results = stmt.all(safe, limit) as Array<{ chunk_id: string; document_id: string; rank: number }>;
      return results;
    } catch (error) {
      log.error({ query, safe, error }, 'Chunk FTS search failed');
      return [];
    }
  }

  phraseSearch(phrase: string, documentLimit: number = 10): Array<{ document_id: string; rank: number }> {
    const ftsQuery = `"${phrase.replace(/"/g, '""')}"`;
    return this.searchDocuments(ftsQuery, documentLimit);
  }

  deleteDocumentFts(documentId: string): void {
    try {
      const stmt = this.db.prepare('DELETE FROM documents_fts WHERE document_id = ?');
      stmt.run(documentId);

      const syncStmt = this.db.prepare('DELETE FROM documents_fts_sync WHERE document_id = ?');
      syncStmt.run(documentId);
    } catch (error) {
      log.error({ documentId, error }, 'Failed to delete document FTS');
      throw error;
    }
  }

  deleteChunkFts(chunkId: string): void {
    try {
      const stmt = this.db.prepare('DELETE FROM chunks_fts WHERE chunk_id = ?');
      stmt.run(chunkId);

      const syncStmt = this.db.prepare('DELETE FROM chunks_fts_sync WHERE chunk_id = ?');
      syncStmt.run(chunkId);
    } catch (error) {
      log.error({ chunkId, error }, 'Failed to delete chunk FTS');
      throw error;
    }
  }

  private markDocumentSynced(documentId: string): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO documents_fts_sync (document_id, last_synced)
        VALUES (?, ?)
        ON CONFLICT(document_id) DO UPDATE SET last_synced = excluded.last_synced
      `);
      stmt.run(documentId, Date.now());
    } catch (error) {
      log.error({ documentId, error }, 'Failed to mark document synced');
    }
  }

  private markChunkSynced(chunkId: string): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO chunks_fts_sync (chunk_id, last_synced)
        VALUES (?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET last_synced = excluded.last_synced
      `);
      stmt.run(chunkId, Date.now());
    } catch (error) {
      log.error({ chunkId, error }, 'Failed to mark chunk synced');
    }
  }
}
