import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';

const log = createLogger('memory:fts-index');

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

      const results = stmt.all(query, limit) as Array<{ document_id: string; rank: number }>;
      return results;
    } catch (error) {
      log.error({ query, error }, 'Document FTS search failed');
      return [];
    }
  }

  searchChunks(query: string, limit: number = 10): Array<{ chunk_id: string; document_id: string; rank: number }> {
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

      const results = stmt.all(query, limit) as Array<{ chunk_id: string; document_id: string; rank: number }>;
      return results;
    } catch (error) {
      log.error({ query, error }, 'Chunk FTS search failed');
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
