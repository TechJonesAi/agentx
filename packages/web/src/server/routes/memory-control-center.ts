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
  document_date: number | string | null;
  ingested_at: number | string | null;
  chunk_count: number | null;
  /** Silly cognitive_memory.db columns — present when reading that DB. */
  metadata_json?: string | null;
  classification_label?: string | null;
  created_at?: number | string | null;
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

/**
 * Introspect the `documents` table once and report which optional columns
 * exist. Silly Johnson's `cognitive_memory.db` doesn't have `title`,
 * `subject`, `file_type`, `ingested_at`, or `chunk_count`; main's legacy
 * `documents` table did. The list-query SQL below adapts to whichever set
 * is present so the same handler works against either DB layout.
 */
interface DocSchema {
  hasTitle: boolean;
  hasSubject: boolean;
  hasFileType: boolean;
  hasIngestedAt: boolean;
  hasChunkCount: boolean;
  hasMetadataJson: boolean;
  hasClassification: boolean;
  hasCreatedAt: boolean;
}
const _docSchemaCache = new WeakMap<DbHandle, DocSchema>();
function getDocSchema(db: DbHandle): DocSchema {
  const cached = _docSchemaCache.get(db);
  if (cached) return cached;
  let cols = new Set<string>();
  try {
    const rows = db.prepare(`PRAGMA table_info(documents)`).all() as Array<{ name?: string }>;
    cols = new Set(rows.map((r) => r.name ?? '').filter(Boolean));
  } catch { /* */ }
  const schema: DocSchema = {
    hasTitle: cols.has('title'),
    hasSubject: cols.has('subject'),
    hasFileType: cols.has('file_type'),
    hasIngestedAt: cols.has('ingested_at'),
    hasChunkCount: cols.has('chunk_count'),
    hasMetadataJson: cols.has('metadata_json'),
    hasClassification: cols.has('classification_label'),
    hasCreatedAt: cols.has('created_at'),
  };
  _docSchemaCache.set(db, schema);
  return schema;
}

function classifyType(d: DocumentRow): MemoryItem['type'] {
  if (d.origin_type === 'email') return 'email';
  if (d.origin_type === 'attachment') return 'attachment';
  const mime = (d.mime_type ?? '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  // Silly cognitive_memory.db uses `source_type` instead of `file_type`.
  // Treat both as the same hint when classifying.
  const ft = (d.file_type ?? (d as { source_type?: string }).source_type ?? '').toLowerCase();
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

function formatDate(value: number | string | null | undefined): string {
  if (!value) return '';
  try {
    // Numeric epoch (ms or seconds) or ISO/SQL date string both accepted.
    if (typeof value === 'number') {
      // Treat values < 1e12 as seconds, else ms.
      const ms = value < 1e12 ? value * 1000 : value;
      return new Date(ms).toISOString();
    }
    const s = String(value);
    // SQLite CURRENT_TIMESTAMP yields 'YYYY-MM-DD HH:MM:SS' — make it ISO-friendly.
    const iso = /\d{4}-\d{2}-\d{2}T/.test(s) ? s : s.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return s; // fall back to raw string
    return d.toISOString();
  } catch {
    return '';
  }
}

/**
 * Schema-tolerant chunk-text accessor. Main's `document_chunks` uses
 * (content, chunk_number); silly's uses (chunk_text, chunk_index). Probe
 * once and cache.
 */
interface ChunkSchema { textCol: string; orderCol: string }
const _chunkSchemaCache = new WeakMap<DbHandle, ChunkSchema>();
function getChunkSchema(db: DbHandle): ChunkSchema {
  const cached = _chunkSchemaCache.get(db);
  if (cached) return cached;
  let cols = new Set<string>();
  try {
    const rows = db.prepare(`PRAGMA table_info(document_chunks)`).all() as Array<{ name?: string }>;
    cols = new Set(rows.map((r) => r.name ?? '').filter(Boolean));
  } catch { /* */ }
  const schema: ChunkSchema = {
    textCol: cols.has('content') ? 'content' : cols.has('chunk_text') ? 'chunk_text' : 'content',
    orderCol: cols.has('chunk_number') ? 'chunk_number' : cols.has('chunk_index') ? 'chunk_index' : 'rowid',
  };
  _chunkSchemaCache.set(db, schema);
  return schema;
}

function previewFor(db: DbHandle, documentId: string): { preview: string; words: number } {
  if (!tableExists(db, 'document_chunks')) return { preview: '', words: 0 };
  try {
    const c = getChunkSchema(db);
    const row = db
      .prepare(
        `SELECT ${c.textCol} AS text FROM document_chunks WHERE document_id = ? ORDER BY ${c.orderCol} ASC LIMIT 1`,
      )
      .get(documentId) as { text?: string } | undefined;
    const text = String(row?.text ?? '');
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
    const c = getChunkSchema(db);
    const rows = db
      .prepare(`SELECT ${c.textCol} AS text FROM document_chunks WHERE document_id = ?`)
      .all(documentId) as { text?: string }[];
    return rows.reduce((acc, r) => {
      const text = String(r.text ?? '').trim();
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
  // Silly's `cognitive_memory.db` carries collection in metadata_json.
  let metadata: Record<string, unknown> | undefined;
  if (d.metadata_json) {
    try {
      const parsed = JSON.parse(d.metadata_json) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object') metadata = parsed;
    } catch { /* ignore bad JSON */ }
  }
  const collection = metadata && typeof metadata['collection'] === 'string'
    ? (metadata['collection'] as string)
    : undefined;
  const dateValue = d.document_date ?? d.ingested_at ?? d.created_at ?? null;
  return {
    id: `doc:${d.document_id}`,
    title: String(title ?? 'Untitled'),
    type,
    sender: d.sender ?? undefined,
    date: formatDate(dateValue),
    preview,
    source: type === 'email' ? 'email' : (collection ?? d.origin_type ?? d.file_type ?? 'document'),
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

  // Documents (covers email/document/attachment/image/audio).
  // Schema-tolerant — adapts to legacy main `documents` (title/subject/
  // file_type/ingested_at/chunk_count) or silly cognitive `documents`
  // (metadata_json/classification_label/created_at).
  if (tableExists(db, 'documents')) {
    const s = getDocSchema(db);

    // Build a SELECT that always returns the same column aliases so the
    // DocumentRow mapping stays uniform.
    const titleExpr     = s.hasTitle     ? 'title'                                  : 'NULL AS title';
    const subjectExpr   = s.hasSubject   ? 'subject'                                : 'NULL AS subject';
    const fileTypeExpr  = s.hasFileType  ? 'file_type'                              : 'NULL AS file_type';
    const ingestedExpr  = s.hasIngestedAt ? 'ingested_at'                           : 'NULL AS ingested_at';
    const chunkCntExpr  = s.hasChunkCount ? 'chunk_count'                           : 'NULL AS chunk_count';
    const metadataExpr  = s.hasMetadataJson ? 'metadata_json'                       : 'NULL AS metadata_json';
    // `created_at` exists in silly cognitive_memory.db but NOT in main's
    // legacy `documents` schema (which uses `ingested_at` instead).
    const createdAtExpr = s.hasCreatedAt ? 'created_at' : 'NULL AS created_at';
    const selectList = [
      'document_id', 'file_name', fileTypeExpr, 'mime_type', 'origin_type',
      titleExpr, 'sender', subjectExpr, 'document_date',
      ingestedExpr, chunkCntExpr, metadataExpr, createdAtExpr,
    ].join(', ');

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (query.q) {
      const chunkSchema = getChunkSchema(db);
      const titleC   = s.hasTitle   ? "LOWER(COALESCE(title,'')) LIKE ?"   : '0';
      const subjectC = s.hasSubject ? "LOWER(COALESCE(subject,'')) LIKE ?" : '0';
      const needle = `%${query.q.toLowerCase()}%`;
      conditions.push(
        `(LOWER(file_name) LIKE ? OR ${titleC} OR ${subjectC} OR LOWER(COALESCE(sender,'')) LIKE ? OR EXISTS (SELECT 1 FROM document_chunks c WHERE c.document_id = documents.document_id AND LOWER(c.${chunkSchema.textCol}) LIKE ?))`,
      );
      params.push(needle);                      // file_name
      if (s.hasTitle)   params.push(needle);
      if (s.hasSubject) params.push(needle);
      params.push(needle, needle);              // sender, chunk content
    }
    if (query.sender) {
      conditions.push(`LOWER(COALESCE(sender,'')) LIKE ?`);
      params.push(`%${query.sender.toLowerCase()}%`);
    }
    // Date filters operate on document_date with fallback to ingested_at
    // (legacy) or created_at (silly). Use COALESCE in SQLite where datetime
    // comparison handles both numeric epoch and ISO strings lexically.
    const dateOrderExpr = (
      s.hasIngestedAt && s.hasCreatedAt ? 'COALESCE(document_date, ingested_at, created_at)' :
      s.hasIngestedAt                   ? 'COALESCE(document_date, ingested_at)' :
      s.hasCreatedAt                    ? 'COALESCE(document_date, created_at)' :
                                          'document_date'
    );
    if (query.dateFrom) {
      const from = Date.parse(query.dateFrom);
      if (!isNaN(from)) {
        conditions.push(`${dateOrderExpr} >= ?`);
        params.push(from);
      }
    }
    if (query.dateTo) {
      const to = Date.parse(query.dateTo);
      if (!isNaN(to)) {
        conditions.push(`${dateOrderExpr} <= ?`);
        params.push(to);
      }
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    try {
      const sql = `SELECT ${selectList} FROM documents ${where} ORDER BY ${dateOrderExpr} DESC LIMIT 1000`;
      const rows = db.prepare(sql).all(...params) as DocumentRow[];
      for (const d of rows) {
        const item = docToItem(db, d);
        if (wantsType(item.type)) items.push(item);
      }
    } catch {
      // table absent or unexpected schema — fall through to long_term_memory
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
      const s = getDocSchema(db);
      const titleExpr     = s.hasTitle     ? 'title'         : 'NULL AS title';
      const subjectExpr   = s.hasSubject   ? 'subject'       : 'NULL AS subject';
      const fileTypeExpr  = s.hasFileType  ? 'file_type'     : 'NULL AS file_type';
      const ingestedExpr  = s.hasIngestedAt ? 'ingested_at'  : 'NULL AS ingested_at';
      const chunkCntExpr  = s.hasChunkCount ? 'chunk_count'  : 'NULL AS chunk_count';
      const metadataExpr  = s.hasMetadataJson ? 'metadata_json' : 'NULL AS metadata_json';
      const createdAtExpr = s.hasCreatedAt ? 'created_at' : 'NULL AS created_at';
      const selectList = [
        'document_id', 'file_name', fileTypeExpr, 'mime_type', 'origin_type',
        titleExpr, 'sender', subjectExpr, 'document_date',
        ingestedExpr, chunkCntExpr, metadataExpr, createdAtExpr,
      ].join(', ');
      const d = db
        .prepare(`SELECT ${selectList} FROM documents WHERE document_id = ?`)
        .get(docId) as DocumentRow | undefined;
      if (!d) return null;
      // Body = concatenated chunks
      let body = '';
      let words = 0;
      if (tableExists(db, 'document_chunks')) {
        try {
          const c = getChunkSchema(db);
          const rows = db
            .prepare(
              `SELECT ${c.textCol} AS text FROM document_chunks WHERE document_id = ? ORDER BY ${c.orderCol} ASC`,
            )
            .all(docId) as { text?: string }[];
          body = rows.map((r) => r.text ?? '').join('\n\n');
          words = body.trim() ? body.trim().split(/\s+/).length : 0;
        } catch {
          /* ignore */
        }
      }
      const type = classifyType(d);
      const title = d.title || d.subject || d.file_name;
      // Parse metadata_json so the UI's metadata panel surfaces collection,
      // book-type, OCR confidence, etc. from silly cognitive_memory.db.
      let extraMeta: Record<string, unknown> = {};
      if (d.metadata_json) {
        try {
          const parsed = JSON.parse(d.metadata_json);
          if (parsed && typeof parsed === 'object') extraMeta = parsed as Record<string, unknown>;
        } catch { /* */ }
      }
      const collection = typeof extraMeta['collection'] === 'string' ? extraMeta['collection'] as string : undefined;
      return {
        id,
        title: String(title ?? 'Untitled'),
        type,
        sender: d.sender ?? undefined,
        date: formatDate(d.document_date ?? d.ingested_at ?? d.created_at ?? null),
        body,
        source: type === 'email' ? 'email' : (collection ?? d.origin_type ?? d.file_type ?? 'document'),
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
          ...(collection ? { collection } : {}),
          ...extraMeta,
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
