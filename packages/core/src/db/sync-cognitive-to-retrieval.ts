/**
 * Cognitive → Retrieval sync.
 *
 * Bridges the user's restored cognitive_memory.db (read by Memory + Cognitive
 * Books routes via memory-db.ts) into the agentx.db tables that the live
 * R1–R12 retrieval pipeline reads. One-way, additive, idempotent.
 *
 * Why this exists: the audit at commit `5026f1a` proved retrieval fires
 * R7/R11 events correctly but always with `matchCount: 0` because the
 * RetrievalService is constructed against `agent.getDatabase()` =
 * agentx.db, while the user's 253 documents live in cognitive_memory.db.
 * Bridging the two via either an agent.ts change or a live mirror was
 * judged risky in the architectural audit; one-time sync is the
 * smallest safe approach.
 *
 * Read source: `cognitive_memory.db` (silly schema). Opened READ-ONLY
 * via better-sqlite3 — cannot corrupt the original 253 documents.
 *
 * Write target: `agentx.db` (main migration 001 schema). The cognitive
 * memory migrations must have already been run on the target — i.e.
 * `runCognitiveMemoryMigrations(targetDb)` must have created the
 * `documents` and `document_chunks` tables. The sync verifies this and
 * refuses to run if the schema is missing.
 *
 * Idempotency: every write uses `INSERT OR REPLACE` keyed on
 * `document_id` / `chunk_id`. Running the sync twice produces the same
 * end state; no duplicate rows.
 *
 * Rollback: drop the synced rows by document_id list returned in
 * `result.documentIds`, or destructively `DELETE FROM document_chunks`
 * and `DELETE FROM documents` on the target.
 */

import * as fs from 'node:fs';
import { createLogger } from '../logger.js';

const log = createLogger('db:sync-cognitive-to-retrieval');

interface DbHandle {
  prepare(sql: string): {
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
    run(...p: unknown[]): { changes?: number };
  };
  exec(sql: string): void;
  transaction?<T extends (...a: never[]) => unknown>(fn: T): T;
}

interface BetterSqliteCtor {
  new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }): DbHandle & {
    close(): void;
    pragma(s: string): unknown;
  };
}

async function loadBetterSqlite(): Promise<BetterSqliteCtor | null> {
  try {
    const mod = (await import('better-sqlite3' as string)) as { default: BetterSqliteCtor };
    return mod.default;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'better-sqlite3 not loadable');
    return null;
  }
}

export interface SyncResult {
  /** Total documents seen in cognitive_memory.db. */
  cognitiveDocumentCount: number;
  /** Documents successfully written (insert or replace) to agentx.db. */
  documentsWritten: number;
  /** Chunks successfully written. */
  chunksWritten: number;
  /** Pages successfully written (page-level provenance). */
  pagesWritten: number;
  /** Chunks that carry a valid page_id (a subset of chunksWritten). */
  chunksWithPageId: number;
  /** Documents skipped because of schema mismatch / missing fields. */
  documentsSkipped: number;
  /** Chunks skipped. */
  chunksSkipped: number;
  /** Pages skipped. */
  pagesSkipped: number;
  /** Final row count in target documents table after sync. */
  targetDocumentCount: number;
  /** Final row count in target document_chunks table after sync. */
  targetChunkCount: number;
  /** Final row count in target document_pages table after sync. */
  targetPageCount: number;
  /** Doc IDs that were touched (for rollback). */
  documentIds: string[];
  /** ms taken end-to-end. */
  durationMs: number;
  /** Source DB path. */
  sourcePath: string;
}

/** Derive `file_type` from `mime_type` — minimal mapping for the common types. */
function deriveFileType(mime: string | null | undefined, sourceType?: string | null): string {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('pdf')) return 'pdf';
  if (m.includes('msword') || m.includes('officedocument.wordprocessing') || m.includes('vnd.openxmlformats')) return 'docx';
  if (m.includes('image/')) return 'image';
  if (m.includes('audio/')) return 'audio';
  if (m.includes('video/')) return 'video';
  if (m.includes('json')) return 'json';
  if (m.includes('csv')) return 'csv';
  if (m.includes('xml')) return 'xml';
  if (m.includes('html')) return 'html';
  if (m.includes('markdown') || m.includes('md')) return 'md';
  if (m.includes('rfc822') || m.includes('eml')) return 'eml';
  if (m.includes('text/')) return 'txt';
  if (sourceType === 'book' || m.includes('book-collection')) return 'book';
  return 'other';
}

function deriveContentType(originType: string | null | undefined, fileType: string): string {
  if (originType === 'email') return 'email';
  if (fileType === 'image' || fileType === 'audio' || fileType === 'video') return fileType;
  return 'document';
}

function parseTextDate(value: string | number | null | undefined, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'number') return value < 1e12 ? value * 1000 : value;
  const s = String(value).trim();
  if (!s) return fallback;
  const parsed = Date.parse(s);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

/**
 * Run a one-way sync from a cognitive_memory.db file → an open agentx.db
 * handle. Returns counts + the set of document IDs touched.
 *
 * The target DB MUST already have main's migration-001 schema (i.e.
 * `runCognitiveMemoryMigrations(targetDb)` must have been called). The
 * sync verifies this and throws if `documents` table is absent.
 */
export async function syncCognitiveToRetrieval(opts: {
  sourcePath: string;
  targetDb: DbHandle;
  /** Hard cap on documents (mostly for tests). Default: no cap. */
  limit?: number;
  /** Restrict the sync to a specific set of document_ids. When supplied,
   *  only matching documents (and their chunks) are written. Use this for
   *  post-upload incremental sync. */
  documentIds?: string[];
}): Promise<SyncResult> {
  const startedAt = Date.now();
  const Better = await loadBetterSqlite();
  if (!Better) throw new Error('better-sqlite3 not available');
  if (!fs.existsSync(opts.sourcePath)) {
    throw new Error(`Source DB not found: ${opts.sourcePath}`);
  }

  // Verify target schema
  let targetHasDocs = false;
  let targetHasChunks = false;
  try {
    const r1 = opts.targetDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'").get();
    targetHasDocs = !!r1;
    const r2 = opts.targetDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks'").get();
    targetHasChunks = !!r2;
  } catch (err) {
    throw new Error(`Failed to inspect target schema: ${(err as Error).message}`);
  }
  if (!targetHasDocs || !targetHasChunks) {
    throw new Error('Target DB missing documents/document_chunks tables — run runCognitiveMemoryMigrations(targetDb) first');
  }

  const src = new Better(opts.sourcePath, { readonly: true, fileMustExist: true });
  try {
    try { src.pragma('busy_timeout = 5000'); } catch { /* */ }

    // Pull documents from cognitive_memory.db
    const limitClause = opts.limit && opts.limit > 0 ? ` LIMIT ${Math.floor(opts.limit)}` : '';
    type CognitiveDocRow = {
      document_id: string;
      file_name: string;
      mime_type: string | null;
      origin_type: string | null;
      sender: string | null;
      recipient: string | null;
      document_date: string | null;
      created_at: string | null;
      updated_at: string | null;
      word_count: number | null;
      classification_label: string | null;
      classification_confidence: number | null;
      metadata_json: string | null;
      source_type: string | null;
      content_hash: string | null;
    };
    const idFilter = opts.documentIds && opts.documentIds.length > 0;
    const whereClause = idFilter
      ? `WHERE document_id IN (${opts.documentIds!.map(() => '?').join(',')})`
      : '';
    const cogDocs = src
      .prepare(
        `SELECT document_id, file_name, mime_type, origin_type, sender, recipient,
                document_date, created_at, updated_at, word_count,
                classification_label, classification_confidence,
                metadata_json, source_type, content_hash
         FROM documents
         ${whereClause}
         ORDER BY created_at DESC${limitClause}`,
      )
      .all(...(idFilter ? opts.documentIds! : [])) as CognitiveDocRow[];

    const documentIds: string[] = [];
    let documentsWritten = 0;
    let documentsSkipped = 0;
    let chunksWritten = 0;
    let chunksSkipped = 0;

    // Pre-compile target statements
    // Use ON CONFLICT DO UPDATE (UPSERT) rather than INSERT OR REPLACE.
    // REPLACE deletes the existing row and re-inserts, which fires
    // DELETE triggers — including the FTS sync triggers that touch the
    // CONTENTLESS chunks_fts virtual table (migration 007). UPSERT
    // doesn't fire DELETE triggers, so re-running the sync against an
    // already-populated agentx.db works cleanly.
    const insertDoc = opts.targetDb.prepare(
      `INSERT INTO documents (
         document_id, file_name, file_type, mime_type, content_type,
         origin_type, title, sender, subject, document_date,
         page_count, chunk_count, classification_label,
         classification_confidence, extraction_status, indexing_status,
         content_hash, ingested_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(document_id) DO UPDATE SET
         file_name=excluded.file_name,
         file_type=excluded.file_type,
         mime_type=excluded.mime_type,
         content_type=excluded.content_type,
         origin_type=excluded.origin_type,
         title=excluded.title,
         sender=excluded.sender,
         subject=excluded.subject,
         document_date=excluded.document_date,
         page_count=excluded.page_count,
         chunk_count=excluded.chunk_count,
         classification_label=excluded.classification_label,
         classification_confidence=excluded.classification_confidence,
         extraction_status=excluded.extraction_status,
         indexing_status=excluded.indexing_status,
         content_hash=excluded.content_hash,
         updated_at=excluded.updated_at`,
    );
    const insertChunk = opts.targetDb.prepare(
      `INSERT INTO document_chunks (
         chunk_id, document_id, page_id, chunk_number, content,
         token_count, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chunk_id) DO UPDATE SET
         document_id=excluded.document_id,
         page_id=excluded.page_id,
         chunk_number=excluded.chunk_number,
         content=excluded.content,
         token_count=excluded.token_count`,
    );
    const insertPage = opts.targetDb.prepare(
      `INSERT INTO document_pages (
         page_id, document_id, page_number, content, raw_content,
         ocr_confidence, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(page_id) DO UPDATE SET
         document_id=excluded.document_id,
         page_number=excluded.page_number,
         content=excluded.content,
         raw_content=excluded.raw_content,
         ocr_confidence=excluded.ocr_confidence`,
    );

    type ChunkCountRow = { n?: number };
    type PageCountRow = { n?: number };
    const cogChunkCount = src.prepare('SELECT COUNT(*) AS n FROM document_chunks WHERE document_id = ?');
    const cogPageCount = src.prepare('SELECT COUNT(*) AS n FROM document_pages WHERE document_id = ?');

    for (const d of cogDocs) {
      try {
        const fileType = deriveFileType(d.mime_type, d.source_type);
        const contentType = deriveContentType(d.origin_type, fileType);

        // Try to parse subject from metadata_json
        let subject: string | null = null;
        if (d.metadata_json) {
          try {
            const meta = JSON.parse(d.metadata_json) as Record<string, unknown>;
            if (typeof meta['subject'] === 'string') subject = meta['subject'] as string;
          } catch { /* ignore */ }
        }

        // page_count / chunk_count from cognitive_memory.db
        const pc = (cogPageCount.get(d.document_id) as PageCountRow | undefined)?.n ?? 0;
        const cc = (cogChunkCount.get(d.document_id) as ChunkCountRow | undefined)?.n ?? 0;

        const nowMs = Date.now();
        const ingestedAt = parseTextDate(d.created_at, nowMs);
        const updatedAt = parseTextDate(d.updated_at, ingestedAt);
        const documentDate = parseTextDate(d.document_date, ingestedAt);

        insertDoc.run(
          d.document_id,
          d.file_name,
          fileType,
          d.mime_type ?? 'application/octet-stream',
          contentType,
          d.origin_type ?? 'file',
          null, // title (no source field; falls back to file_name in renderers)
          d.sender ?? null,
          subject,
          documentDate,
          pc,
          cc,
          d.classification_label ?? null,
          d.classification_confidence ?? 0,
          'success',
          'success',
          d.content_hash ?? null,
          ingestedAt,
          updatedAt,
        );
        documentsWritten++;
        documentIds.push(d.document_id);
      } catch (err) {
        documentsSkipped++;
        log.warn({ err: (err as Error).message, document_id: d.document_id }, 'Failed to write document');
      }
    }

    // ─── Pages sync — MUST run before chunks (chunks FK-reference pages) ───
    type CognitivePageRow = {
      page_id: string;
      document_id: string;
      page_number: number;
      page_text: string;
      extracted_text: string | null;
      ocr_confidence: number | null;
      created_at: string | null;
    };
    let cogPages: CognitivePageRow[] = [];
    if (documentIds.length > 0) {
      const placeholders = documentIds.map(() => '?').join(',');
      cogPages = src
        .prepare(
          `SELECT page_id, document_id, page_number, page_text, extracted_text,
                  ocr_confidence, created_at
           FROM document_pages
           WHERE document_id IN (${placeholders})
           ORDER BY document_id ASC, page_number ASC`,
        )
        .all(...documentIds) as CognitivePageRow[];
    }
    let pagesWritten = 0;
    let pagesSkipped = 0;
    /** Track which page_ids successfully landed in the target so we
     *  can safely emit them on chunks (FK guarantee). */
    const validPageIds = new Set<string>();
    for (const p of cogPages) {
      try {
        const createdAtMs = parseTextDate(p.created_at, Date.now());
        insertPage.run(
          p.page_id,
          p.document_id,
          p.page_number,
          p.page_text,
          p.extracted_text ?? null,
          typeof p.ocr_confidence === 'number' ? p.ocr_confidence : null,
          createdAtMs,
        );
        pagesWritten++;
        validPageIds.add(p.page_id);
      } catch (err) {
        pagesSkipped++;
        log.warn({ err: (err as Error).message, page_id: p.page_id }, 'Failed to write page');
      }
    }

    // ─── Chunks sync — page_id passthrough when target page exists ──────
    type CognitiveChunkRow = {
      chunk_id: string;
      document_id: string;
      page_id: string | null;
      chunk_index: number;
      chunk_text: string;
      token_count: number | null;
      created_at: string | null;
    };
    let cogChunks: CognitiveChunkRow[] = [];
    if (documentIds.length > 0) {
      const placeholders = documentIds.map(() => '?').join(',');
      cogChunks = src
        .prepare(
          `SELECT chunk_id, document_id, page_id, chunk_index, chunk_text, token_count, created_at
           FROM document_chunks
           WHERE document_id IN (${placeholders})
           ORDER BY document_id ASC, chunk_index ASC`,
        )
        .all(...documentIds) as CognitiveChunkRow[];
    }

    let chunksWithPageId = 0;
    for (const c of cogChunks) {
      try {
        const createdAtMs = parseTextDate(c.created_at, Date.now());
        // Preserve page_id when the page was successfully synced to
        // target; otherwise NULL to avoid FK violation. This means
        // chunks for newly-arrived pages will carry full provenance,
        // while orphan-referenced chunks still get written (just
        // without their page link).
        const pageId = c.page_id && validPageIds.has(c.page_id) ? c.page_id : null;
        insertChunk.run(
          c.chunk_id,
          c.document_id,
          pageId,
          c.chunk_index,
          c.chunk_text,
          c.token_count ?? 0,
          createdAtMs,
        );
        chunksWritten++;
        if (pageId) chunksWithPageId++;
      } catch (err) {
        chunksSkipped++;
        log.warn({ err: (err as Error).message, chunk_id: c.chunk_id }, 'Failed to write chunk');
      }
    }

    const targetDocumentCount = Number(
      (opts.targetDb.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n?: number } | undefined)?.n ?? 0,
    );
    const targetChunkCount = Number(
      (opts.targetDb.prepare('SELECT COUNT(*) AS n FROM document_chunks').get() as { n?: number } | undefined)?.n ?? 0,
    );
    const targetPageCount = Number(
      (opts.targetDb.prepare('SELECT COUNT(*) AS n FROM document_pages').get() as { n?: number } | undefined)?.n ?? 0,
    );

    log.info({
      cognitiveDocumentCount: cogDocs.length,
      documentsWritten,
      chunksWritten,
      pagesWritten,
      chunksWithPageId,
      documentsSkipped,
      chunksSkipped,
      pagesSkipped,
      targetDocumentCount,
      targetChunkCount,
      targetPageCount,
      durationMs: Date.now() - startedAt,
    }, 'Cognitive → retrieval sync complete');

    return {
      cognitiveDocumentCount: cogDocs.length,
      documentsWritten,
      chunksWritten,
      pagesWritten,
      chunksWithPageId,
      documentsSkipped,
      chunksSkipped,
      pagesSkipped,
      targetDocumentCount,
      targetChunkCount,
      targetPageCount,
      documentIds,
      durationMs: Date.now() - startedAt,
      sourcePath: opts.sourcePath,
    };
  } finally {
    try { src.close(); } catch { /* */ }
  }
}
