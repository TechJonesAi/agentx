/**
 * Memory-db helper — locates the correct SQLite handle for document-bearing
 * Memory / Cognitive routes.
 *
 * Background: AgentX has accumulated three plausible DB files in the data dir
 * over its history:
 *
 *   - ~/.agentx/agentx.db          — legacy main DB. The current Agent class
 *                                    opens this via memory/database.ts. Has
 *                                    long_term_memory + episode tables but
 *                                    NO `documents` / `document_chunks` /
 *                                    `document_pages` tables.
 *   - ~/.agentx/cognitive-memory.db — would-be default of SqliteMemoryDb
 *                                    (db/sqlite-memory.ts). Not always
 *                                    created.
 *   - ~/.agentx/cognitive_memory.db — Silly Johnson's actual cognitive
 *                                    memory DB. Has the full
 *                                    documents/document_chunks/document_pages
 *                                    schema and all user uploads/emails.
 *
 * The Memory page handlers query documents/document_chunks/document_pages,
 * so they need whichever DB actually contains those tables and rows.
 *
 * This helper:
 *   1. Looks for the silly-johnson `cognitive_memory.db` (underscore) in the
 *      resolved dataDir. If present and it has a `documents` table → use it.
 *   2. Else looks for `cognitive-memory.db` (hyphen). If present and has
 *      `documents` → use it.
 *   3. Else falls back to `agent.getDatabase()` (legacy `agentx.db`).
 *
 * Read-write handle, but we do NOT destructively migrate or overwrite — we
 * just open the existing file in place. better-sqlite3 is already a dep.
 *
 * The handle is cached per-process so we don't re-open on every request.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, resolveDataDir } from '@agentx/core';
import type { DbHandle } from './memory-control-center.js';

const log = createLogger('web:memory-db');

interface BetterSqliteCtor {
  new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }): BetterSqliteHandle;
}
interface BetterSqliteHandle extends DbHandle {
  pragma(s: string): unknown;
  exec(s: string): void;
  close(): void;
}

// Cache resolved handle per-agent so multiple agents in the same process
// (e.g. parallel test workers) don't share a handle from a previous agent.
const perAgentCache = new WeakMap<object, { handle: DbHandle; path: string }>();
let cachedHandle: DbHandle | null = null; // last-resolved, for diagnostics
let cachedPath: string | null = null;
let resolutionLogged = false;

function hasDocumentsTable(db: DbHandle): boolean {
  try {
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='documents'`)
      .get();
    return row !== undefined && row !== null;
  } catch {
    return false;
  }
}

async function loadBetterSqlite(): Promise<BetterSqliteCtor | null> {
  try {
    const mod = (await import('better-sqlite3' as string)) as { default: BetterSqliteCtor };
    return mod.default;
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'better-sqlite3 not loadable — falling back to agent.getDatabase()');
    return null;
  }
}

/**
 * Resolve the right DB handle for memory/document routes.
 *
 * `agent` is the live Agent — used as the fallback when no cognitive DB
 * file is found. Returns null only if every option fails (rare).
 */
export async function getMemoryDbHandle(agent: unknown): Promise<DbHandle | null> {
  // Per-agent cache hit
  if (agent && typeof agent === 'object') {
    const cached = perAgentCache.get(agent as object);
    if (cached) {
      cachedHandle = cached.handle;
      cachedPath = cached.path;
      return cached.handle;
    }
  }

  // Preferred order:
  //   1. If `agent.getDatabase()` has a `documents` table, use it. This
  //      preserves test-injected fake agents that wire an in-memory DB —
  //      they're the source of truth in unit/integration tests and we must
  //      not silently bypass them by opening the user's real data dir.
  //   2. Else if `cognitive_memory.db` (silly underscore) exists in dataDir
  //      and has `documents`, open and return it.
  //   3. Else if `cognitive-memory.db` (hyphen variant) exists and has
  //      `documents`, open and return it.
  //   4. Fall back to `agent.getDatabase()` anyway — route handlers will
  //      degrade to "no items" when tables are missing.
  const agentDb = (agent as { getDatabase?: () => DbHandle }).getDatabase?.();
  if (agentDb && hasDocumentsTable(agentDb)) {
    cachedHandle = agentDb;
    cachedPath = '(agent.getDatabase) — has documents table';
    if (agent && typeof agent === 'object') {
      perAgentCache.set(agent as object, { handle: agentDb, path: cachedPath });
    }
    if (!resolutionLogged) {
      log.info({}, 'Memory routes bound to agent-supplied DB');
      resolutionLogged = true;
    }
    return agentDb;
  }

  const dataDir = resolveDataDir();
  const candidates = [
    path.join(dataDir, 'cognitive_memory.db'),
    path.join(dataDir, 'cognitive-memory.db'),
  ];

  const Better = await loadBetterSqlite();
  if (Better) {
    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) continue;
      try {
        const handle = new Better(filePath, { fileMustExist: true });
        // Light pragma — non-destructive.
        try { handle.pragma('busy_timeout = 5000'); } catch { /* */ }
        if (hasDocumentsTable(handle)) {
          cachedHandle = handle;
          cachedPath = filePath;
          if (agent && typeof agent === 'object') {
            perAgentCache.set(agent as object, { handle, path: filePath });
          }
          if (!resolutionLogged) {
            log.info({ filePath }, 'Memory routes bound to cognitive memory DB');
            resolutionLogged = true;
          }
          return handle;
        } else {
          try { handle.close(); } catch { /* */ }
        }
      } catch (err) {
        log.warn({ err: (err as Error).message, filePath }, 'Failed to open candidate DB');
      }
    }
  }

  // Fallback: agent's primary DB (typically agentx.db). It probably lacks
  // the documents table, so the route handlers will gracefully return
  // "no items" rather than crashing.
  const fallback = agentDb ?? (agent as { getDatabase?: () => DbHandle }).getDatabase?.();
  if (fallback) {
    cachedHandle = fallback;
    cachedPath = '(agent.getDatabase) — legacy primary DB';
    if (agent && typeof agent === 'object') {
      perAgentCache.set(agent as object, { handle: fallback, path: cachedPath });
    }
    if (!resolutionLogged) {
      log.warn(
        { dataDir, candidates },
        'No cognitive memory DB found in dataDir; memory routes will use the legacy primary DB (likely lacks documents table)',
      );
      resolutionLogged = true;
    }
    return fallback;
  }

  if (!resolutionLogged) {
    log.error({ dataDir }, 'No usable DB handle for memory routes');
    resolutionLogged = true;
  }
  return null;
}

/** Diagnostics — exposed for the /api/memory/diagnostics route + tests. */
export function getMemoryDbDiagnostics(): { path: string | null; bound: boolean } {
  return { path: cachedPath, bound: cachedHandle !== null };
}

/** TEST ONLY — reset the cached handle so each test can start clean. */
export function _resetMemoryDbForTests(): void {
  if (cachedHandle && 'close' in (cachedHandle as object)) {
    try { (cachedHandle as BetterSqliteHandle).close(); } catch { /* */ }
  }
  cachedHandle = null;
  cachedPath = null;
  resolutionLogged = false;
}
