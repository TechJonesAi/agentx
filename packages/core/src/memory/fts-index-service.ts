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
      const stmt = this.db.prepare(`
        INSERT INTO documents_fts (document_id, title, sender, recipient, subject, content, file_name)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id) DO UPDATE SET
          title = excluded.title,
          sender = excluded.sender,
          recipient = excluded.recipient,
          subject = excluded.subject,
          content = excluded.content,
          file_name = excluded.file_name
      `);

      stmt.run(
        documentId,
        content.title ?? null,
        content.sender ?? null,
        content.recipient ?? null,
        content.subject ?? null,
        content.content,
        content.file_name ?? null,
      );

      this.markDocumentSynced(documentId);
    } catch (error) {
      log.error({ documentId, error }, 'Failed to upsert document FTS');
      throw error;
    }
  }

  upsertChunkFts(chunkId: string, documentId: string, content: string): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO chunks_fts (chunk_id, document_id, content)
        VALUES (?, ?, ?)
        ON CONFLICT(chunk_id) DO UPDATE SET content = excluded.content
      `);

      stmt.run(chunkId, documentId, content);
      this.markChunkSynced(chunkId);
    } catch (error) {
      log.error({ chunkId, documentId, error }, 'Failed to upsert chunk FTS');
      throw error;
    }
  }

  searchDocuments(query: string, limit: number = 10): Array<{ document_id: string; rank: number }> {
    try {
      const stmt = this.db.prepare(`
        SELECT document_id, rank FROM documents_fts
        WHERE documents_fts MATCH ?
        ORDER BY rank
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
      const stmt = this.db.prepare(`
        SELECT chunk_id, document_id, rank FROM chunks_fts
        WHERE chunks_fts MATCH ?
        ORDER BY rank
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
