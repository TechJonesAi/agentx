/**
 * Retrieval provenance enrichment — adds page-level metadata to retrieval
 * results without touching `retrieval/*` internals.
 *
 * Why a separate adapter?
 *   The current retrieval pipeline returns a flat metadata shape:
 *     { retrievalDocuments: [{ document_id, file_name, title, file_type,
 *       sender, snippet, matchedPhrase? }] }
 *   — it includes no chunk_id and no page_id. Editing the retrieval layer
 *   to thread these through would touch ranking + scoring code that is
 *   explicitly out of scope for this batch. Instead we post-process the
 *   metadata in the web SSE layer: for each result with a snippet, look
 *   up the chunk in agentx.db whose `content` contains the snippet text
 *   and whose document_id matches, then JOIN to document_pages to get
 *   the page number.
 *
 * Behaviour:
 *   - When a page is found → adds `pageNumber`, `pageId`, `pageConfidence`,
 *     `provenanceLabel: "p. N"` to the result.
 *   - When no page is found (no chunk match, NULL page_id, or page lookup
 *     fails) → returns the result unchanged. NEVER fakes a page number.
 *   - When the DB handle is missing, the table doesn't exist, or anything
 *     else throws → returns the metadata unchanged. Enrichment is best-
 *     effort and must never break the chat stream.
 */

export interface ProvenanceDocLike {
  document_id: string;
  file_name: string;
  title?: string;
  file_type?: string;
  sender?: string;
  snippet?: string;
  matchedPhrase?: string;
  pageNumber?: number;
  pageId?: string;
  pageConfidence?: number | null;
  provenanceLabel?: string;
}

export interface ProvenanceMetadataLike {
  retrievalIntent: string;
  retrievalSource: string;
  retrievalMatchCount: number;
  retrievalDocuments: ProvenanceDocLike[];
  retrievalCount?: number;
}

export interface EnrichResult {
  metadata: ProvenanceMetadataLike;
  enrichedCount: number;
  missingPageCount: number;
}

interface DbLike {
  prepare(sql: string): {
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
}

/**
 * Sliced anchor for the snippet → chunk LIKE match.
 * We take a stable middle slice rather than the start to avoid prefix
 * truncation artifacts (the snippet may begin mid-sentence). 60 chars
 * is long enough to be near-unique and short enough that `<mark>` /
 * ellipsis artifacts at edges don't sabotage the LIKE.
 */
function snippetAnchor(snippet: string): string | null {
  const stripped = snippet.replace(/<\/?[a-z][^>]*>/gi, '').trim();
  if (stripped.length < 12) return null;
  const start = Math.min(8, Math.floor(stripped.length / 4));
  const slice = stripped.slice(start, start + 60).trim();
  return slice.length >= 12 ? slice : stripped.slice(0, Math.min(60, stripped.length));
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function hasTable(db: DbLike, name: string): boolean {
  try {
    const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
    return row !== undefined && row !== null;
  } catch {
    return false;
  }
}

/**
 * Enrich retrieval metadata in-place-shape (returns new object). Pure,
 * synchronous — safe to call from an SSE callback.
 */
export function enrichRetrievalMetadata(
  db: DbLike | null | undefined,
  metadata: ProvenanceMetadataLike | null | undefined,
): EnrichResult {
  if (!metadata) {
    return {
      metadata: { retrievalIntent: '', retrievalSource: '', retrievalMatchCount: 0, retrievalDocuments: [] },
      enrichedCount: 0,
      missingPageCount: 0,
    };
  }
  const docs = Array.isArray(metadata.retrievalDocuments) ? metadata.retrievalDocuments : [];
  if (docs.length === 0 || !db) {
    return { metadata, enrichedCount: 0, missingPageCount: docs.length };
  }
  // Guard: tables must exist (production agentx.db post-sync; test
  // fixtures sometimes set up only `documents`).
  if (!hasTable(db, 'document_chunks') || !hasTable(db, 'document_pages')) {
    return { metadata, enrichedCount: 0, missingPageCount: docs.length };
  }

  let stmt;
  try {
    stmt = db.prepare(
      `SELECT p.page_number AS page_number, p.page_id AS page_id, p.ocr_confidence AS ocr_confidence
         FROM document_chunks c
         JOIN document_pages p ON c.page_id = p.page_id
        WHERE c.document_id = ?
          AND c.content LIKE ? ESCAPE '\\'
        LIMIT 1`,
    );
  } catch {
    return { metadata, enrichedCount: 0, missingPageCount: docs.length };
  }

  let enriched = 0;
  let missing = 0;
  const out: ProvenanceDocLike[] = docs.map((d) => {
    if (!d || !d.document_id || !d.snippet) {
      missing += 1;
      return d;
    }
    const anchor = snippetAnchor(String(d.snippet));
    if (!anchor) {
      missing += 1;
      return d;
    }
    try {
      const row = stmt.get(d.document_id, `%${escapeLike(anchor)}%`) as
        | { page_number?: number; page_id?: string; ocr_confidence?: number | null }
        | undefined;
      if (row && typeof row.page_number === 'number' && row.page_id) {
        enriched += 1;
        return {
          ...d,
          pageNumber: row.page_number,
          pageId: row.page_id,
          pageConfidence: row.ocr_confidence ?? null,
          provenanceLabel: `p. ${row.page_number}`,
        };
      }
    } catch {
      // fall through to missing
    }
    missing += 1;
    return d;
  });

  return {
    metadata: { ...metadata, retrievalDocuments: out },
    enrichedCount: enriched,
    missingPageCount: missing,
  };
}

/* ── Diagnostics counters (process-global, reset on restart) ──────────── */

let lastEnrichedCount = 0;
let lastMissingPageCount = 0;
let totalEnrichedCount = 0;
let totalMissingPageCount = 0;

export function recordEnrichmentStats(r: EnrichResult): void {
  lastEnrichedCount = r.enrichedCount;
  lastMissingPageCount = r.missingPageCount;
  totalEnrichedCount += r.enrichedCount;
  totalMissingPageCount += r.missingPageCount;
}

export function getEnrichmentStats(): {
  lastEnrichedCount: number;
  lastMissingPageCount: number;
  totalEnrichedCount: number;
  totalMissingPageCount: number;
} {
  return { lastEnrichedCount, lastMissingPageCount, totalEnrichedCount, totalMissingPageCount };
}

/** TEST ONLY */
export function _resetEnrichmentStatsForTests(): void {
  lastEnrichedCount = 0;
  lastMissingPageCount = 0;
  totalEnrichedCount = 0;
  totalMissingPageCount = 0;
}
