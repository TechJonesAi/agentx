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
 * Extract plain text from an uploaded buffer. Returns kind=unknown when the
 * type isn't recognised; the route handler should reject in that case.
 */
export async function extractTextFromUpload(
  buffer: Buffer,
  filename: string,
): Promise<ExtractResult> {
  const warnings: string[] = [];
  const magic = classifyByMagicBytes(buffer);
  const named = classifyByName(filename);
  // Magic bytes win when present.
  const kind: UploadKind = magic ?? named;

  if (kind === 'pdf') {
    try {
      // Lazy import — pdf-parse is a heavy dep
      const mod = (await import('pdf-parse')) as unknown as { default?: (b: Buffer) => Promise<{ text: string; numpages: number }> } & { (b: Buffer): Promise<{ text: string; numpages: number }> };
      const fn = mod.default ?? (mod as unknown as (b: Buffer) => Promise<{ text: string; numpages: number }>);
      const parsed = await fn(buffer);
      return {
        text: parsed.text ?? '',
        kind: 'pdf',
        fileType: 'pdf',
        mimeType: 'application/pdf',
        contentType: 'document',
        pageCount: parsed.numpages ?? 1,
        warnings,
      };
    } catch (err) {
      warnings.push(`pdf-parse failed: ${err instanceof Error ? err.message : String(err)}`);
      return {
        text: '',
        kind: 'pdf',
        fileType: 'pdf',
        mimeType: 'application/pdf',
        contentType: 'document',
        pageCount: 0,
        warnings,
      };
    }
  }

  if (kind === 'markdown') {
    return {
      text: buffer.toString('utf8'),
      kind: 'markdown',
      fileType: 'md',
      mimeType: 'text/markdown',
      contentType: 'document',
      pageCount: 1,
      warnings,
    };
  }

  if (kind === 'text') {
    const dot = filename.lastIndexOf('.');
    const ext = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : 'txt';
    return {
      text: buffer.toString('utf8'),
      kind: 'text',
      fileType: ext,
      mimeType: 'text/plain',
      contentType: 'document',
      pageCount: 1,
      warnings,
    };
  }

  // Unknown — try UTF-8 anyway as a last resort and warn loudly.
  let asText = '';
  try {
    asText = buffer.toString('utf8');
    if (/[\x00-\x08\x0e-\x1f]/.test(asText.slice(0, 4096))) {
      // Has control bytes — treat as binary garbage
      asText = '';
    }
  } catch { /* ignore */ }

  return {
    text: asText,
    kind: 'unknown',
    fileType: 'bin',
    mimeType: 'application/octet-stream',
    contentType: 'document',
    pageCount: asText ? 1 : 0,
    warnings: [`unsupported file kind for ${filename}; treated as ${asText ? 'best-effort utf-8' : 'unreadable'}`],
  };
}

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
  const { buffer, filename, title, originType } = args;
  const extracted = await extractTextFromUpload(buffer, filename);
  const text = extracted.text.trim();
  const wordCount = text ? text.split(/\s+/).length : 0;

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
        originType: originType ?? 'upload',
        chunkCount: 0,
        wordCount,
        duplicateOf: existing.document_id,
        warnings: extracted.warnings,
      };
    }
  } catch {
    // documents table may not exist on a fresh DB without migrations — fall through
  }

  const documentId = makeDocumentId();
  const now = Date.now();
  const titleFinal = title ?? filename.replace(/\.[^.]+$/, '');

  db.prepare(
    `INSERT INTO documents (
      document_id, file_name, file_type, mime_type, content_type, origin_type,
      title, document_date, page_count, chunk_count, ocr_required, ocr_completed,
      classification_confidence, extraction_status, indexing_status,
      content_hash, ingested_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    documentId,
    filename,
    extracted.fileType,
    extracted.mimeType,
    extracted.contentType,
    originType ?? 'upload',
    titleFinal,
    now,
    extracted.pageCount,
    0, // chunk_count, updated below
    0, 0,
    0.0,
    text ? 'complete' : 'failed',
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
    originType: originType ?? 'upload',
    chunkCount: chunks.length,
    wordCount,
    warnings: extracted.warnings,
  };
}
