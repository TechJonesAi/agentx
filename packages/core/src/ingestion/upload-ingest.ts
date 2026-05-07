/**
 * Upload ingestion — text extraction + DB writes for user-uploaded documents.
 *
 * Supports text/markdown out of the box (UTF-8 decode) and PDF via pdf-parse
 * (lazy-loaded so the dep isn't paid for unless a PDF is uploaded).
 *
 * DOCX, MSG, EML are deliberately NOT supported here yet — they need silly's
 * extraction subsystem (text-extractor.ts) which isn't lifted yet. They'll
 * land in a follow-up commit when extraction/ is properly merged.
 *
 * Behaviour:
 *  1. Identify the file type from filename + magic bytes.
 *  2. Extract plain text.
 *  3. Compute content_hash for dedupe.
 *  4. INSERT a document row (FTS is populated automatically via the
 *     documents_fts_insert trigger).
 *  5. Chunk the text and INSERT document_chunks (chunks_fts_insert trigger
 *     populates the chunk FTS).
 *  6. Return the new document_id and a summary so callers can wire entity
 *     indexing (R5/R5.5) on the agent side.
 */

import { createHash } from 'node:crypto';
import { createLogger } from '../logger.js';
import { extractTextFromBuffer, type BufferExtractionResult } from '../extraction/buffer-extractor.js';

const log = createLogger('ingestion:upload');

export type UploadKind = 'text' | 'markdown' | 'pdf' | 'unknown';

export interface ExtractResult {
  text: string;
  kind: UploadKind;
  fileType: string; // e.g. 'pdf', 'txt', 'md'
  mimeType: string; // e.g. 'application/pdf'
  contentType: string; // e.g. 'document'
  pageCount: number;
  warnings: string[];
}

export interface IngestArgs {
  buffer: Buffer;
  filename: string;
  /** Optional MIME from the upload's Content-Type — used as a hint, not authoritative. */
  mimeHint?: string;
  /** Optional title (defaults to filename without extension). */
  title?: string;
  /** Override origin_type. Defaults to 'upload'. */
  originType?: string;
}

export interface IngestResult {
  documentId: string;
  fileName: string;
  fileType: string;
  mimeType: string;
  contentType: string;
  originType: string;
  chunkCount: number;
  wordCount: number;
  duplicateOf?: string; // present when content_hash collides
  warnings: string[];
}

/**
 * Structural DB handle so this module doesn't have a hard better-sqlite3 dep
 * outside of core's own dependency tree. Compatible with Database.Database.
 */
interface SqlStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
}
export interface UploadIngestDb {
  prepare(sql: string): SqlStatement;
}

const TEXT_EXTENSIONS = new Set(['txt', 'log', 'csv', 'tsv', 'json', 'yaml', 'yml']);
const MD_EXTENSIONS = new Set(['md', 'markdown', 'mdx']);

function classifyByName(filename: string): UploadKind {
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return 'unknown';
  const ext = filename.slice(dot + 1).toLowerCase();
  if (ext === 'pdf') return 'pdf';
  if (MD_EXTENSIONS.has(ext)) return 'markdown';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  return 'unknown';
}

function classifyByMagicBytes(buf: Buffer): UploadKind | null {
  // %PDF-
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d) {
    return 'pdf';
  }
  return null;
}

/**
 * Extract plain text from an uploaded buffer. Delegates to the
 * `extraction/buffer-extractor.ts` module which supports PDF, DOCX, EML,
 * MSG, HTML, JSON, CSV, XML, TXT, MD. Returns the same ExtractResult
 * shape as before so existing call sites stay stable.
 *
 * For full extraction details (status, provenance, warnings, email
 * metadata) callers should import extractTextFromBuffer directly.
 */
export async function extractTextFromUpload(
  buffer: Buffer,
  filename: string,
): Promise<ExtractResult> {
  const r = await extractTextFromBuffer(buffer, filename);
  return adaptToLegacy(r);
}

/** Adapter that maps the rich BufferExtractionResult into the older ExtractResult shape. */
function adaptToLegacy(r: BufferExtractionResult): ExtractResult {
  // Map fileType to the legacy UploadKind
  let kind: UploadKind;
  if (r.fileType === 'pdf') kind = 'pdf';
  else if (r.fileType === 'md') kind = 'markdown';
  else if (r.fileType === 'txt' || r.fileType === 'html' || r.fileType === 'json'
        || r.fileType === 'csv' || r.fileType === 'xml' || r.fileType === 'log'
        || r.fileType === 'tsv' || r.fileType === 'eml' || r.fileType === 'msg'
        || r.fileType === 'docx') {
    // Anything textually-extracted gets bucketed as 'text' in the legacy enum
    kind = 'text';
  } else {
    kind = 'unknown';
  }
  return {
    text: r.text,
    kind,
    fileType: r.fileType,
    mimeType: r.mimeType,
    contentType: r.contentType,
    pageCount: r.pageCount,
    warnings: r.warnings,
  };
}

// (Legacy single-file extractor removed — extraction now lives in
// extraction/buffer-extractor.ts which supports PDF/DOCX/EML/MSG/HTML/JSON/
// CSV/XML/TXT/MD. This module's extractTextFromUpload thin-wraps it for
// backwards compatibility with the older ExtractResult shape.)

/**
 * Chunk text into ~1024-token segments with simple paragraph-aware splitting.
 * Approximates the behaviour of memory/chunker.ts but works on raw text
 * (chunker.ts requires DocumentPage rows, which we'd have to build first).
 */
function chunkText(text: string, targetSize = 1024): string[] {
  if (!text) return [];
  // Split into paragraphs first to keep semantically related chunks together.
  const paragraphs = text.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let buf = '';
  for (const p of paragraphs) {
    if (!buf) {
      buf = p;
    } else if ((buf + '\n\n' + p).length <= targetSize) {
      buf = buf + '\n\n' + p;
    } else {
      chunks.push(buf);
      buf = p;
    }
    // Hard cap — if a single paragraph is huge, split on sentences.
    while (buf.length > targetSize * 1.5) {
      const cut = buf.lastIndexOf('. ', targetSize) + 1;
      const split = cut > 0 ? cut : targetSize;
      chunks.push(buf.slice(0, split).trim());
      buf = buf.slice(split).trim();
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function makeDocumentId(): string {
  return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function makeChunkId(documentId: string, n: number): string {
  return `${documentId}-c${n.toString().padStart(4, '0')}`;
}

/**
 * Ingest an uploaded document end-to-end:
 *   buffer → extracted text → chunks → DB rows (FTS populated by triggers)
 *
 * Idempotent on content_hash: if the same bytes were uploaded before, the
 * existing document_id is returned and `duplicateOf` is set.
 */
export async function ingestUploadedDocument(
  db: UploadIngestDb,
  args: IngestArgs,
): Promise<IngestResult> {
  const { buffer, filename, title, originType, mimeHint } = args;
  // Use the rich extractor directly so we get status/warnings/email metadata.
  const rich = await extractTextFromBuffer(buffer, filename, mimeHint);
  const extracted = adaptToLegacy(rich);
  const text = rich.text.trim();
  const wordCount = rich.wordCount || (text ? text.split(/\s+/).length : 0);
  // EML/MSG uploads should land as origin_type='email' even if the caller
  // didn't tell us that — the extractor knows the truth via magic bytes.
  const finalOriginType = originType
    ?? (rich.contentType === 'email' ? 'email' : 'upload');

  // Content hash of the full file bytes — primary dedupe key
  const contentHash = createHash('sha256').update(buffer).digest('hex');

  // Idempotency check
  try {
    const existing = db
      .prepare(`SELECT document_id FROM documents WHERE content_hash = ?`)
      .get(contentHash) as { document_id?: string } | undefined;
    if (existing?.document_id) {
      log.info({ existingId: existing.document_id, filename }, 'Upload deduped on content_hash');
      return {
        documentId: existing.document_id,
        fileName: filename,
        fileType: extracted.fileType,
        mimeType: extracted.mimeType,
        contentType: extracted.contentType,
        originType: finalOriginType,
        chunkCount: 0,
        wordCount,
        duplicateOf: existing.document_id,
        warnings: rich.warnings,
      };
    }
  } catch {
    // documents table may not exist on a fresh DB without migrations — fall through
  }

  const documentId = makeDocumentId();
  const now = Date.now();
  // Email metadata (when present) populates richer columns
  const emailMd = rich.emailMetadata;
  const titleFinal = title
    ?? emailMd?.subject
    ?? filename.replace(/\.[^.]+$/, '');
  const documentDate = emailMd?.date?.getTime() ?? now;
  // Map extractor status → existing extraction_status text values
  const extractionStatus =
    rich.status === 'success' ? 'complete'
      : rich.status === 'partial' ? 'partial'
      : rich.status === 'unsupported' ? 'unsupported'
      : 'failed';

  db.prepare(
    `INSERT INTO documents (
      document_id, file_name, file_type, mime_type, content_type, origin_type,
      title, sender, sender_email, recipient, subject,
      document_date, page_count, chunk_count, ocr_required, ocr_completed,
      classification_confidence, extraction_status, indexing_status,
      content_hash, ingested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    documentId,
    filename,
    extracted.fileType,
    extracted.mimeType,
    extracted.contentType,
    finalOriginType,
    titleFinal,
    emailMd?.from ?? null,
    emailMd?.fromEmail ?? null,
    emailMd?.to ?? null,
    emailMd?.subject ?? null,
    documentDate,
    rich.pageCount,
    0, // chunk_count, updated below
    rich.provenance === 'ocr' ? 1 : 0, 0,
    0.0,
    extractionStatus,
    'pending',
    contentHash,
    now,
    now,
  );

  // Chunk and insert
  const chunks = text ? chunkText(text) : [];
  if (chunks.length > 0) {
    const insertChunk = db.prepare(
      `INSERT INTO document_chunks (chunk_id, document_id, chunk_number, content, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let i = 0; i < chunks.length; i++) {
      const c = chunks[i];
      // crude token approximation: 1 token ≈ 4 characters
      insertChunk.run(makeChunkId(documentId, i), documentId, i, c, Math.ceil(c.length / 4), now);
    }

    // Update chunk_count and indexing_status
    db.prepare(
      `UPDATE documents SET chunk_count = ?, indexing_status = ?, updated_at = ? WHERE document_id = ?`,
    ).run(chunks.length, 'complete', now, documentId);
  } else {
    db.prepare(
      `UPDATE documents SET indexing_status = ?, updated_at = ? WHERE document_id = ?`,
    ).run('skipped', now, documentId);
  }

  log.info(
    { documentId, filename, chunks: chunks.length, words: wordCount },
    'Upload ingested',
  );

  return {
    documentId,
    fileName: filename,
    fileType: extracted.fileType,
    mimeType: extracted.mimeType,
    contentType: extracted.contentType,
    originType: finalOriginType,
    chunkCount: chunks.length,
    wordCount,
    warnings: rich.warnings,
  };
}
