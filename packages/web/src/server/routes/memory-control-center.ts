/**
 * Memory Control Center — real DB-backed handlers for the SPA Memory page.
 *
 * These read from the actual cognitive-memory tables (documents,
 * document_pages, document_chunks) and the long-term-memory table
 * (long_term_memory). Emails surface here as documents with origin_type='email'
 * (the EmailIngestionService writes them that way). Notes/teachings surface
 * as long_term_memory rows.
 *
 * The Memory page's UI contract:
 *   GET    /api/memory/control-center?q&type&sender&dateFrom&dateTo&page&pageSize
 *           → { items: MemoryItem[], totalCount: number }
 *   GET    /api/memory/control-center/:id   → MemoryDetail
 *   DELETE /api/memory/control-center/:id   → { ok: true }
 *   POST   /api/memory/control-center/bulk-delete   → { ok, deleted: number }
 *
 * MemoryItem shape (verbatim from packages/web/src/client/pages/Memory.tsx):
 *   {
 *     id: string;
 *     title: string;
 *     type: 'email' | 'document' | 'attachment' | 'note' | 'audio' | 'image' | 'other';
 *     sender?: string;
 *     date: string;
 *     preview: string;
 *     source: string;
 *     attachmentCount: number;
 *     wordCount: number;
 *   }
 *
 * No 501 shims — every handler reads (or writes to) real tables. If a table
 * is missing on a fresh DB, we degrade to "no items" rather than 501.
 */

/**
 * Structural DB handle — avoids a hard better-sqlite3 dep on @agentx/web.
 * Compatible with both better-sqlite3's Database and tests using fakes.
 */
interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes?: number };
}
export interface DbHandle {
  prepare(sql: string): SqlStatement;
}

export interface MemoryItem {
  id: string;
  title: string;
  type: 'email' | 'document' | 'attachment' | 'note' | 'audio' | 'image' | 'other';
  sender?: string;
  date: string;
  preview: string;
  source: string;
  attachmentCount: number;
  wordCount: number;
}

export interface MemoryListQuery {
  q?: string;
  type?: string;
  sender?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  pageSize?: number;
}

export interface MemoryListResult {
  items: MemoryItem[];
  totalCount: number;
}

export interface MemoryDetail {
  id: string;
  title: string;
  type: string;
  sender?: string;
  date: string;
  body: string;
  source: string;
  wordCount: number;
  attachments: { filename: string; path: string; size?: number }[];
  metadata: Record<string, unknown>;
}

interface DocumentRow {
  document_id: string;
  file_name: string;
  file_type: string | null;
  mime_type: string | null;
  origin_type: string | null;
  title: string | null;
  sender: string | null;
  subject: string | null;
  document_date: number | null;
  ingested_at: number;
  chunk_count: number | null;
}

interface LongTermRow {
  id: string;
  content: string;
  tags: string;
  created_at: number;
}

function tableExists(db: DbHandle, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
    .get(name) as { name?: string } | undefined;
  return !!row?.name;
}

function classifyType(d: DocumentRow): MemoryItem['type'] {
  if (d.origin_type === 'email') return 'email';
  if (d.origin_type === 'attachment') return 'attachment';
  const mime = (d.mime_type ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  const ft = (d.file_type ?? '').toLowerCase();
  if (
    ft === 'pdf' ||
    ft === 'doc' ||
    ft === 'docx' ||
    ft === 'msg' ||
    ft === 'eml' ||
    ft === 'txt' ||
    ft === 'md'
  ) {
    return 'document';
  }
  return 'other';
}

function formatDate(epochMs: number | null): string {
  if (!epochMs) return '';
  try {
    return new Date(epochMs).toISOString();
  } catch {
    return '';
  }
}

function previewFor(db: DbHandle, documentId: string): { preview: string; words: number } {
  if (!tableExists(db, 'document_chunks')) return { preview: '', words: 0 };
  try {
    const row = db
      .prepare(
        `SELECT content FROM document_chunks WHERE document_id = ? ORDER BY chunk_number ASC LIMIT 1`,
      )
      .get(documentId) as { content?: string } | undefined;
    const text = String(row?.content ?? '');
    const words = text.trim() ? text.trim().split(/\s+/).length : 0;
    const preview = text.length > 240 ? text.slice(0, 237) + '…' : text;
    return { preview, words };
  } catch {
    return { preview: '', words: 0 };
  }
}

function totalWordCountFor(db: DbHandle, documentId: string): number {
  if (!tableExists(db, 'document_chunks')) return 0;
  try {
    const rows = db
      .prepare(`SELECT content FROM document_chunks WHERE document_id = ?`)
      .all(documentId) as { content?: string }[];
    return rows.reduce((acc, r) => {
      const text = String(r.content ?? '').trim();
      return acc + (text ? text.split(/\s+/).length : 0);
    }, 0);
  } catch {
    return 0;
  }
}

function noteToItem(row: LongTermRow): MemoryItem {
  let tags: string[] = [];
  try {
    tags = JSON.parse(row.tags) as string[];
  } catch {
    tags = [];
  }
  const text = row.content;
  const preview = text.length > 240 ? text.slice(0, 237) + '…' : text;
  // First line as title; fall back to first 60 chars
  const firstLine = text.split('\n')[0].trim();
  const title = firstLine.length > 0 && firstLine.length <= 80 ? firstLine : text.slice(0, 60);
  return {
    id: `note:${row.id}`,
    title: title || 'Note',
    type: 'note',
    date: formatDate(row.created_at),
    preview,
    source: tags.length ? `note (${tags.join(', ')})` : 'note',
    attachmentCount: 0,
    wordCount: text.trim() ? text.trim().split(/\s+/).length : 0,
  };
}

function docToItem(db: DbHandle, d: DocumentRow): MemoryItem {
  const { preview, words } = previewFor(db, d.document_id);
  // Prefer chunk total over single-chunk preview wordcount when available
  const fullWords = totalWordCountFor(db, d.document_id) || words;
  const type = classifyType(d);
  const title = d.title || d.subject || d.file_name;
  // Email-style document — count related attachment-origin docs?
  // For now just report 0 (we'd need a join via subject/thread to be exact).
  return {
    id: `doc:${d.document_id}`,
    title: String(title ?? 'Untitled'),
    type,
    sender: d.sender ?? undefined,
    date: formatDate(d.document_date ?? d.ingested_at),
    preview,
    source: type === 'email' ? 'email' : (d.origin_type ?? d.file_type ?? 'document'),
    attachmentCount: 0,
    wordCount: fullWords,
  };
}

/**
 * List memory items with filters. Combines documents (incl. emails) and
 * long-term-memory notes into a single result set, sorted by date desc.
 */
export function listMemoryItems(
  db: DbHandle,
  query: MemoryListQuery = {},
): MemoryListResult {
  const items: MemoryItem[] = [];
  const wantsType = (t: MemoryItem['type']) => !query.type || query.type === t;

  // Documents (covers email/document/attachment/image/audio)
  if (tableExists(db, 'documents')) {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.q) {
      // Match against file metadata OR any chunk content. The chunk-content
      // join is via a sub-EXISTS so we don't have to JOIN+DISTINCT.
      conditions.push(
        `(LOWER(file_name) LIKE ? OR LOWER(COALESCE(title,'')) LIKE ? OR LOWER(COALESCE(subject,'')) LIKE ? OR LOWER(COALESCE(sender,'')) LIKE ? OR EXISTS (SELECT 1 FROM document_chunks c WHERE c.document_id = documents.document_id AND LOWER(c.content) LIKE ?))`,
      );
      const needle = `%${query.q.toLowerCase()}%`;
      params.push(needle, needle, needle, needle, needle);
    }
    if (query.sender) {
      conditions.push(`LOWER(COALESCE(sender,'')) LIKE ?`);
      params.push(`%${query.sender.toLowerCase()}%`);
    }
    if (query.dateFrom) {
      const from = Date.parse(query.dateFrom);
      if (!isNaN(from)) {
        conditions.push(`COALESCE(document_date, ingested_at) >= ?`);
        params.push(from);
      }
    }
    if (query.dateTo) {
      const to = Date.parse(query.dateTo);
      if (!isNaN(to)) {
        conditions.push(`COALESCE(document_date, ingested_at) <= ?`);
        params.push(to);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    try {
      const sql = `SELECT document_id, file_name, file_type, mime_type, origin_type, title, sender, subject, document_date, ingested_at, chunk_count FROM documents ${where} ORDER BY COALESCE(document_date, ingested_at) DESC LIMIT 1000`;
      const rows = db.prepare(sql).all(...params) as DocumentRow[];
      for (const d of rows) {
        const item = docToItem(db, d);
        if (wantsType(item.type)) items.push(item);
      }
    } catch {
      // table absent or schema mismatch — fall through
    }
  }

  // Long-term-memory notes — skip when caller is filtering by a doc-only
  // attribute (sender), since notes have no sender.
  if (tableExists(db, 'long_term_memory') && !query.sender && !(query.type && query.type !== 'note')) {
    const conditions: string[] = [];
    const params: unknown[] = [];
    if (query.q) {
      conditions.push(`LOWER(content) LIKE ?`);
      params.push(`%${query.q.toLowerCase()}%`);
    }
    if (query.dateFrom) {
      const from = Date.parse(query.dateFrom);
      if (!isNaN(from)) {
        conditions.push(`created_at >= ?`);
        params.push(from);
      }
    }
    if (query.dateTo) {
      const to = Date.parse(query.dateTo);
      if (!isNaN(to)) {
        conditions.push(`created_at <= ?`);
        params.push(to);
      }
    }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    try {
      const sql = `SELECT id, content, tags, created_at FROM long_term_memory ${where} ORDER BY created_at DESC LIMIT 1000`;
      const rows = db.prepare(sql).all(...params) as LongTermRow[];
      for (const r of rows) {
        const item = noteToItem(r);
        if (wantsType(item.type)) items.push(item);
      }
    } catch {
      /* ignore */
    }
  }

  // Date-sorted merge
  items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));

  const page = Math.max(1, Number(query.page ?? 1) | 0);
  const pageSize = Math.min(500, Math.max(1, Number(query.pageSize ?? 50) | 0));
  const totalCount = items.length;
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), totalCount };
}

/**
 * Fetch the full body for a single memory item by id.
 * Item ids are namespaced: `doc:<document_id>` or `note:<longterm_id>`.
 */
export function getMemoryDetail(db: DbHandle, id: string): MemoryDetail | null {
  if (id.startsWith('note:')) {
    const noteId = id.slice('note:'.length);
    if (!tableExists(db, 'long_term_memory')) return null;
    try {
      const r = db
        .prepare(`SELECT id, content, tags, created_at FROM long_term_memory WHERE id = ?`)
        .get(noteId) as LongTermRow | undefined;
      if (!r) return null;
      let tags: string[] = [];
      try { tags = JSON.parse(r.tags) as string[]; } catch { /* ignore */ }
      const firstLine = r.content.split('\n')[0].trim();
      const title = firstLine && firstLine.length <= 80 ? firstLine : r.content.slice(0, 60);
      return {
        id,
        title: title || 'Note',
        type: 'note',
        date: formatDate(r.created_at),
        body: r.content,
        source: tags.length ? `note (${tags.join(', ')})` : 'note',
        wordCount: r.content.trim() ? r.content.trim().split(/\s+/).length : 0,
        attachments: [],
        metadata: { tags },
      };
    } catch {
      return null;
    }
  }

  if (id.startsWith('doc:')) {
    const docId = id.slice('doc:'.length);
    if (!tableExists(db, 'documents')) return null;
    try {
      const d = db
        .prepare(
          `SELECT document_id, file_name, file_type, mime_type, origin_type, title, sender, subject, document_date, ingested_at, chunk_count FROM documents WHERE document_id = ?`,
        )
        .get(docId) as DocumentRow | undefined;
      if (!d) return null;
      // Body = concatenated chunks
      let body = '';
      let words = 0;
      if (tableExists(db, 'document_chunks')) {
        try {
          const rows = db
            .prepare(
              `SELECT content FROM document_chunks WHERE document_id = ? ORDER BY chunk_number ASC`,
            )
            .all(docId) as { content?: string }[];
          body = rows.map((r) => r.content ?? '').join('\n\n');
          words = body.trim() ? body.trim().split(/\s+/).length : 0;
        } catch {
          /* ignore */
        }
      }
      const type = classifyType(d);
      const title = d.title || d.subject || d.file_name;
      return {
        id,
        title: String(title ?? 'Untitled'),
        type,
        sender: d.sender ?? undefined,
        date: formatDate(d.document_date ?? d.ingested_at),
        body,
        source: type === 'email' ? 'email' : (d.origin_type ?? d.file_type ?? 'document'),
        wordCount: words,
        attachments: [],
        metadata: {
          file_name: d.file_name,
          file_type: d.file_type,
          mime_type: d.mime_type,
          origin_type: d.origin_type,
          subject: d.subject,
          chunk_count: d.chunk_count,
          ingested_at: d.ingested_at,
        },
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Delete one memory item. Cascades for documents (FK ON DELETE CASCADE
 * removes chunks/pages). Returns true on successful delete.
 */
export function deleteMemoryItem(db: DbHandle, id: string): boolean {
  if (id.startsWith('note:')) {
    const noteId = id.slice('note:'.length);
    if (!tableExists(db, 'long_term_memory')) return false;
    const r = db.prepare(`DELETE FROM long_term_memory WHERE id = ?`).run(noteId);
    return (r.changes ?? 0) > 0;
  }
  if (id.startsWith('doc:')) {
    const docId = id.slice('doc:'.length);
    if (!tableExists(db, 'documents')) return false;
    const r = db.prepare(`DELETE FROM documents WHERE document_id = ?`).run(docId);
    return (r.changes ?? 0) > 0;
  }
  return false;
}

/**
 * Bulk delete. Returns the count of items actually removed.
 */
export function bulkDeleteMemoryItems(db: DbHandle, ids: string[]): number {
  let deleted = 0;
  for (const id of ids) {
    if (deleteMemoryItem(db, id)) deleted++;
  }
  return deleted;
}
