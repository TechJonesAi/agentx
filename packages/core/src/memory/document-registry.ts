import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import type { DocumentMetadata } from './types.js';
import { generateId } from './id-generator.js';

const log = createLogger('memory:document-registry');

export class DocumentRegistry {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(metadata: Omit<DocumentMetadata, 'document_id' | 'ingested_at' | 'updated_at'>): DocumentMetadata {
    const now = Date.now();
    const document_id = generateId('doc');

    const stmt = this.db.prepare(`
      INSERT INTO documents (
        document_id, file_name, file_type, mime_type, content_type, content_subtype,
        origin_type, title, sender, sender_email, recipient, recipient_email, subject,
        document_date, page_count, chunk_count, ocr_required, ocr_completed,
        classification_label, classification_confidence, classification_method,
        extraction_status, indexing_status, content_hash, ingested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      document_id,
      metadata.file_name,
      metadata.file_type,
      metadata.mime_type,
      metadata.content_type,
      metadata.content_subtype ?? null,
      metadata.origin_type,
      metadata.title ?? null,
      metadata.sender ?? null,
      metadata.sender_email ?? null,
      metadata.recipient ?? null,
      metadata.recipient_email ?? null,
      metadata.subject ?? null,
      metadata.document_date ?? null,
      metadata.page_count,
      metadata.chunk_count,
      metadata.ocr_required ? 1 : 0,
      metadata.ocr_completed ? 1 : 0,
      metadata.classification_label ?? null,
      metadata.classification_confidence,
      metadata.classification_method ?? null,
      metadata.extraction_status,
      metadata.indexing_status,
      metadata.content_hash,
      now,
      now,
    );

    return {
      ...metadata,
      document_id,
      ingested_at: now,
      updated_at: now,
    };
  }

  get(document_id: string): DocumentMetadata | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE document_id = ?');
    const row = stmt.get(document_id) as any;

    if (!row) return null;

    return this.rowToMetadata(row);
  }

  update(document_id: string, updates: Partial<Omit<DocumentMetadata, 'document_id' | 'ingested_at'>>): DocumentMetadata {
    const now = Date.now();
    const doc = this.get(document_id);

    if (!doc) {
      throw new Error(`Document not found: ${document_id}`);
    }

    const updateFields: string[] = [];
    const updateValues: unknown[] = [];

    for (const [key, value] of Object.entries(updates)) {
      if (key === 'document_id' || key === 'ingested_at') continue;
      updateFields.push(`${key} = ?`);
      updateValues.push(value);
    }

    updateValues.push(now);
    updateValues.push(document_id);

    const sql = `UPDATE documents SET ${updateFields.join(', ')}, updated_at = ? WHERE document_id = ?`;
    this.db.prepare(sql).run(...updateValues);

    return this.get(document_id)!;
  }

  find(filters: Partial<{
    file_type: string;
    origin_type: string;
    classification_label: string;
    sender: string;
    extraction_status: string;
    indexing_status: string;
  }>, limit: number = 100, offset: number = 0): DocumentMetadata[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    for (const [key, value] of Object.entries(filters)) {
      if (value !== undefined) {
        conditions.push(`${key} = ?`);
        params.push(value);
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT * FROM documents ${whereClause} ORDER BY ingested_at DESC LIMIT ? OFFSET ?`;

    params.push(limit, offset);
    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map(row => this.rowToMetadata(row));
  }

  count(filters?: Partial<{
    file_type: string;
    origin_type: string;
    classification_label: string;
    sender: string;
    extraction_status: string;
    indexing_status: string;
  }>): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (value !== undefined) {
          conditions.push(`${key} = ?`);
          params.push(value);
        }
      }
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const sql = `SELECT COUNT(*) as count FROM documents ${whereClause}`;

    const stmt = this.db.prepare(sql);
    const result = stmt.get(...params) as { count: number };

    return result.count;
  }

  getByHash(content_hash: string): DocumentMetadata | null {
    const stmt = this.db.prepare('SELECT * FROM documents WHERE content_hash = ?');
    const row = stmt.get(content_hash) as any;

    if (!row) return null;

    return this.rowToMetadata(row);
  }

  delete(document_id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM documents WHERE document_id = ?');
    const result = stmt.run(document_id);

    return result.changes > 0;
  }

  private rowToMetadata(row: any): DocumentMetadata {
    return {
      document_id: row.document_id,
      file_name: row.file_name,
      file_type: row.file_type,
      mime_type: row.mime_type,
      content_type: row.content_type,
      content_subtype: row.content_subtype,
      origin_type: row.origin_type,
      title: row.title,
      sender: row.sender,
      sender_email: row.sender_email,
      recipient: row.recipient,
      recipient_email: row.recipient_email,
      subject: row.subject,
      document_date: row.document_date,
      page_count: row.page_count,
      chunk_count: row.chunk_count,
      ocr_required: row.ocr_required === 1,
      ocr_completed: row.ocr_completed === 1,
      classification_label: row.classification_label,
      classification_confidence: row.classification_confidence,
      classification_method: row.classification_method,
      extraction_status: row.extraction_status,
      indexing_status: row.indexing_status,
      content_hash: row.content_hash,
      ingested_at: row.ingested_at,
      updated_at: row.updated_at,
    };
  }
}
