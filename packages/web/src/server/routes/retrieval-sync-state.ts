/**
 * Retrieval sync state tracker.
 *
 * In-process module-level state for /api/retrieval/diagnostics so users
 * can see the most recent automatic sync result without hammering the
 * source DB. Not persisted across restarts — that's fine because the
 * sync is idempotent and a no-op on subsequent boot if there's nothing
 * new to write.
 *
 * Also exposes a debounce wrapper so upload bursts don't trigger N
 * separate sync calls; instead the most-recent set of pending document
 * IDs is drained once after a short idle window.
 */

import { createLogger } from '@agentx/core';
import { syncCognitiveToRetrieval, resolveDataDir, type SyncResult } from '@agentx/core';
import * as path from 'node:path';

const log = createLogger('web:retrieval-sync-state');

interface SyncStateSnapshot {
  lastSyncAt: number | null;
  lastSyncResult: Partial<SyncResult> | null;
  lastSyncError: string | null;
  pendingDocumentIds: string[];
  /** cognitive-source document count at the last completed sync. */
  lastCogCount: number | null;
}

const state: SyncStateSnapshot = {
  lastSyncAt: null,
  lastSyncResult: null,
  lastSyncError: null,
  pendingDocumentIds: [],
  lastCogCount: null,
};

interface DbLike {
  prepare(sql: string): {
    get(...p: unknown[]): unknown;
    run(...p: unknown[]): unknown;
  };
  exec(s: string): void;
}

/** Snapshot for the diagnostics endpoint. */
export function getRetrievalSyncState(): {
  lastSyncAt: number | null;
  lastSyncResult: Partial<SyncResult> | null;
  lastSyncError: string | null;
  pendingDocumentCount: number;
} {
  return {
    lastSyncAt: state.lastSyncAt,
    lastSyncResult: state.lastSyncResult,
    lastSyncError: state.lastSyncError,
    pendingDocumentCount: state.pendingDocumentIds.length,
  };
}

/** TEST ONLY — reset state. */
export function _resetSyncStateForTests(): void {
  state.lastSyncAt = null;
  state.lastSyncResult = null;
  state.lastSyncError = null;
  state.pendingDocumentIds = [];
  if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
  inFlight = false;
}

/**
 * Start a periodic auto-sync that bridges new email-ingested documents
 * (and anything else that lands in cognitive_memory.db) into the
 * retrieval DB. Idempotent + cheap: skips when source count == target
 * count. Skips when retrieval flag is off.
 *
 * Default 60 s interval; tune via AGENTX_RETRIEVAL_AUTOSYNC_MS env var.
 * Disable entirely with AGENTX_RETRIEVAL_AUTOSYNC=false.
 */
export function startAutoSync(agent: unknown): void {
  if (autoSyncTimer) return; // already running
  const off = process.env['AGENTX_RETRIEVAL_AUTOSYNC'];
  if (off && /^(false|0|no|off)$/i.test(off.trim())) {
    log.info({}, 'Auto-sync disabled by AGENTX_RETRIEVAL_AUTOSYNC env var');
    return;
  }
  const ms = Number(process.env['AGENTX_RETRIEVAL_AUTOSYNC_MS'] ?? AUTOSYNC_DEFAULT_MS);
  const interval = Number.isFinite(ms) && ms >= 5_000 ? ms : AUTOSYNC_DEFAULT_MS;
  log.info({ intervalMs: interval }, 'Retrieval auto-sync poller started');
  autoSyncTimer = setInterval(() => {
    void maybeAutoSync(agent);
  }, interval);
  // Don't keep the event loop alive for the timer alone.
  if (typeof autoSyncTimer.unref === 'function') autoSyncTimer.unref();
}

export function stopAutoSync(): void {
  if (autoSyncTimer) { clearInterval(autoSyncTimer); autoSyncTimer = null; }
}

async function maybeAutoSync(agent: unknown): Promise<void> {
  if (inFlight) return;
  try {
    const agentDb = (agent as { getDatabase?: () => DbLike }).getDatabase?.();
    if (!agentDb) return;
    // Cheap skip: only run when retrieval flag is on
    const envRaw = process.env['AGENT_RETRIEVAL_ENABLED'];
    if (!envRaw || !/^(true|1|yes|on)$/i.test(envRaw.trim())) {
      // Check config as a fallback
      const cfg = (agent as { getConfig?: () => { agent?: { retrieval?: { enabled?: boolean } } } }).getConfig?.();
      if (!cfg?.agent?.retrieval?.enabled) return;
    }
    // Fast count comparison: open source read-only briefly
    const sourcePath = path.join(resolveDataDir(), 'cognitive_memory.db');
    // Use the existing sync; it's already idempotent and ~1s for full corpus.
    // But to avoid running for 0-delta cases, do a cheap count first.
    let cogCount = 0;
    try {
      const fs = await import('node:fs');
      if (!fs.existsSync(sourcePath)) return;
      const mod = (await import('better-sqlite3' as string)) as { default: new (filename: string, options?: { readonly?: boolean }) => DbLike & { close(): void } };
      const src = new mod.default(sourcePath, { readonly: true });
      try {
        const r = src.prepare('SELECT COUNT(*) AS n FROM documents').get() as { n?: number };
        cogCount = Number(r?.n ?? 0);
      } finally { try { src.close(); } catch { /* */ } }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'auto-sync count probe failed');
      return;
    }
    // Sync only when the SOURCE changed since the last completed sync.
    // Comparing cognitive vs agent counts looped forever: the agent DB
    // legitimately holds extra documents (direct ingests), so the counts
    // can never converge and a full sync fired every minute, endlessly.
    if (state.lastCogCount !== null && cogCount === state.lastCogCount) return;
    log.info({ cogCount, lastCogCount: state.lastCogCount }, 'Auto-sync detected new documents — running full sync');
    inFlight = true;
    try {
      const result = await syncCognitiveToRetrieval({
        sourcePath,
        targetDb: agentDb as never,
      });
      state.lastSyncAt = Date.now();
      state.lastSyncResult = result;
      state.lastSyncError = null;
      state.lastCogCount = cogCount;
      log.info({
        cog: result.cognitiveDocumentCount,
        wrote: result.documentsWritten,
        chunks: result.chunksWritten,
        durationMs: result.durationMs,
      }, 'Auto-sync complete');
    } catch (err) {
      state.lastSyncError = err instanceof Error ? err.message : String(err);
      state.lastSyncAt = Date.now();
      log.warn({ err: state.lastSyncError }, 'Auto-sync failed');
    } finally {
      inFlight = false;
    }
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'maybeAutoSync top-level error');
  }
}

let debounceTimer: NodeJS.Timeout | null = null;
let inFlight = false;
let autoSyncTimer: NodeJS.Timeout | null = null;
const DEBOUNCE_MS = 1500;
const AUTOSYNC_DEFAULT_MS = 60_000;

/**
 * Queue document IDs for the next debounced sync. Safe to call from
 * upload + email ingestion paths; failures are swallowed and logged
 * (the original ingestion must not fail because retrieval sync failed).
 */
export function queueRetrievalSync(
  agent: unknown,
  documentIds: string[],
  opts: { sourcePath?: string; immediate?: boolean } = {},
): void {
  if (documentIds.length === 0) return;
  for (const id of documentIds) {
    if (!state.pendingDocumentIds.includes(id)) state.pendingDocumentIds.push(id);
  }
  if (opts.immediate) {
    void drain(agent, opts.sourcePath);
    return;
  }
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => { void drain(agent, opts.sourcePath); }, DEBOUNCE_MS);
}

async function drain(agent: unknown, sourcePath?: string): Promise<void> {
  if (inFlight) return; // another drain already running; pending IDs survive
  if (state.pendingDocumentIds.length === 0) return;
  inFlight = true;
  const idsToSync = [...state.pendingDocumentIds];
  state.pendingDocumentIds = [];
  try {
    const agentDb = (agent as { getDatabase?: () => DbLike }).getDatabase?.();
    if (!agentDb) {
      log.warn({}, 'No agent DB — sync deferred');
      state.pendingDocumentIds = [...idsToSync, ...state.pendingDocumentIds];
      return;
    }
    const finalSourcePath = sourcePath ?? path.join(resolveDataDir(), 'cognitive_memory.db');
    const result = await syncCognitiveToRetrieval({
      sourcePath: finalSourcePath,
      targetDb: agentDb as never,
      documentIds: idsToSync,
    });
    state.lastSyncAt = Date.now();
    state.lastSyncResult = {
      cognitiveDocumentCount: result.cognitiveDocumentCount,
      documentsWritten: result.documentsWritten,
      chunksWritten: result.chunksWritten,
      documentsSkipped: result.documentsSkipped,
      chunksSkipped: result.chunksSkipped,
      targetDocumentCount: result.targetDocumentCount,
      targetChunkCount: result.targetChunkCount,
      durationMs: result.durationMs,
      sourcePath: result.sourcePath,
    };
    state.lastSyncError = null;
    log.info({
      requested: idsToSync.length,
      written: result.documentsWritten,
      chunks: result.chunksWritten,
      durationMs: result.durationMs,
    }, 'Retrieval sync drained');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    state.lastSyncError = msg;
    state.lastSyncAt = Date.now();
    log.warn({ err: msg, idsToSync: idsToSync.length }, 'Retrieval sync failed (upload still succeeded)');
    // Don't re-queue automatically — user can run POST /api/retrieval/sync
    // to retry. Avoids tight retry loop on persistent failure.
  } finally {
    inFlight = false;
  }
}
