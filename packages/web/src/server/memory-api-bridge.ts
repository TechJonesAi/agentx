/**
 * Memory-API bridge — makes the rebuilt Python reasoning engine (:8100)
 * actually serve chat.
 *
 * Two halves:
 *   1. syncCorpusToMemoryApi(): one-way push of the agent's document corpus
 *      (documents + document_chunks in agentx.db) into the memory API's
 *      ingestion pipeline. Deterministic IDs + checksum dedup on the far
 *      side make re-runs cheap no-ops. Runs in the background at boot and
 *      every 6h; tracks the last-synced content hash set size.
 *   2. queryMemoryApi(): retrieval for document-grounded questions. Returns
 *      the evidence-ranked, token-budgeted context pack (with heading paths
 *      and citation markers) or null on ANY failure — callers fall back to
 *      the built-in retrieval, so this is a quality upgrade, never a new
 *      point of failure.
 */

import { createLogger } from '@agentx/core';

const log = createLogger('web:memory-bridge');

const BASE = `http://127.0.0.1:${process.env['AGENTX_MEMORY_API_PORT'] ?? 8100}`;

interface DbLike {
  prepare(sql: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown };
}

async function apiUp(): Promise<boolean> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1500);
    const r = await fetch(`${BASE}/health`, { signal: ctl.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}

let syncInFlight = false;
let lastSyncedCount = -1;

export async function syncCorpusToMemoryApi(db: DbLike): Promise<{ pushed: number; skipped: number } | null> {
  if (syncInFlight) return null;
  if (!(await apiUp())) return null;
  syncInFlight = true;
  try {
    const docs = db.prepare(
      `SELECT document_id, coalesce(title, file_name, document_id) AS title
       FROM documents WHERE indexing_status = 'success' OR indexing_status IS NOT NULL`,
    ).all() as Array<{ document_id: string; title: string }>;

    if (docs.length === lastSyncedCount) return { pushed: 0, skipped: docs.length };

    let pushed = 0, skipped = 0;
    for (const d of docs) {
      const chunks = db.prepare(
        'SELECT content FROM document_chunks WHERE document_id = ? ORDER BY chunk_number',
      ).all(d.document_id) as Array<{ content: string }>;
      const text = chunks.map((c) => c.content).join('\n\n');
      if (!text.trim()) { skipped++; continue; }
      try {
        const r = await fetch(`${BASE}/ingest`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            text: text.slice(0, 400_000),
            source_path: `agentx://${d.document_id}`,
            source_type: 'text',
            title: d.title,
          }),
          signal: AbortSignal.timeout(60_000),
        });
        if (r.ok) {
          const res = await r.json() as { status?: string };
          if (res.status === 'completed') pushed++;
          else skipped++; // duplicate — already synced
        } else skipped++;
      } catch { skipped++; }
    }
    lastSyncedCount = docs.length;
    log.info({ pushed, skipped, total: docs.length }, 'Corpus sync to memory-api complete');
    return { pushed, skipped };
  } finally {
    syncInFlight = false;
  }
}

export interface MemoryApiEvidence {
  contextText: string;
  evidenceCount: number;
  queryType: string;
}

export async function queryMemoryApi(query: string): Promise<MemoryApiEvidence | null> {
  if (!(await apiUp())) return null;
  try {
    const r = await fetch(`${BASE}/query`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, limit: 10 }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const data = await r.json() as {
      context_text?: string; evidence?: unknown[]; query_type?: string;
    };
    if (!data.context_text || !data.evidence?.length) return null;
    return {
      contextText: data.context_text,
      evidenceCount: data.evidence.length,
      queryType: data.query_type ?? 'general',
    };
  } catch { return null; }
}

/** Boot-time wiring: first sync 90s after start (post-warm-up calm), then
 *  every 6h. Returns a stop function. */
export function startCorpusSync(getDb: () => DbLike | null): () => void {
  if ((process.env['AGENTX_MEMORY_BRIDGE'] ?? 'true').toLowerCase() === 'false') {
    log.info('Memory-API bridge disabled by env');
    return () => undefined;
  }
  const run = () => {
    const db = getDb();
    if (!db) return;
    void syncCorpusToMemoryApi(db).catch((e) =>
      log.warn({ err: e instanceof Error ? e.message : String(e) }, 'Corpus sync failed'));
  };
  const first = setTimeout(run, 90_000);
  const interval = setInterval(run, 6 * 60 * 60 * 1000);
  first.unref?.(); interval.unref?.();
  return () => { clearTimeout(first); clearInterval(interval); };
}
