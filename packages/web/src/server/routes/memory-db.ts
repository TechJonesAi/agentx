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
  //   1. agent.getDatabase() if it has a `documents` table AND rows.
  //      TEST path (in-process Database with seeded data) and
  //      PRODUCTION path (when the agent's DB is actually populated).
  //   2. agent.getDatabase() if it has the table but is empty AND no
  //      better on-disk source — fall through to file search.
  //   3. On-disk cognitive_memory.db (silly underscore) with rows.
  //      PRODUCTION fallback when agent DB has the table but 0 docs
  //      (e.g. AGENT_RETRIEVAL_ENABLED=true triggered the cognitive
  //      migration on agentx.db, creating empty tables).
  //   4. On-disk cognitive-memory.db (hyphen variant).
  //   5. agent.getDatabase() fallback — routes degrade to "no items".

  const agentDb = (agent as { getDatabase?: () => DbHandle }).getDatabase?.();
  const agentHasDocs = agentDb && hasDocumentsTable(agentDb);
  // Step 1: agent DB has the `documents` table → use it. Test agents AND
  // populated production agents both hit this. We deliberately do NOT
  // gate on row-count here because tests upload-then-query in a single
  // suite (table starts empty, populated mid-test). The on-disk
  // cognitive_memory.db fallback only applies when the agent DB doesn't
  // even have the table — meaning the agent never ran cognitive
  // migrations on its primary DB. NOTE: in production, if you've ever
  // set AGENT_RETRIEVAL_ENABLED=true, agentx.db will gain the table
  // (empty) and shadow the on-disk cognitive_memory.db. To recover,
  // either:
  //   (a) drop the empty `documents` table from agentx.db, OR
  //   (b) the user-data sync path that bridges the two DBs (follow-up).
  // The /api/retrieval/diagnostics route surfaces this exact gap.
  if (agentHasDocs) {
    cachedHandle = agentDb!;
    cachedPath = '(agent.getDatabase) — has documents table';
    if (agent && typeof agent === 'object') {
      perAgentCache.set(agent as object, { handle: agentDb!, path: cachedPath });
    }
    if (!resolutionLogged) {
      log.info({}, 'Memory routes bound to agent-supplied DB');
      resolutionLogged = true;
    }
    return agentDb!;
  }

  // Step 2 + 3: agent DB is empty (or absent) — look at on-disk candidates
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
        try { handle.pragma('busy_timeout = 5000'); } catch { /* */ }
        if (hasDocumentsTable(handle)) {
          cachedHandle = handle;
          cachedPath = filePath;
          if (agent && typeof agent === 'object') {
            perAgentCache.set(agent as object, { handle, path: filePath });
          }
          if (!resolutionLogged) {
            log.info({ filePath }, 'Memory routes bound to on-disk cognitive memory DB');
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

  // Step 4 + 5: agent-supplied DB as last resort (empty table or no agent
  // DB at all). Routes degrade to "no items" when tables are missing.
  if (agentDb && agentHasDocs) {
    cachedHandle = agentDb;
    cachedPath = '(agent.getDatabase) — empty documents table';
    if (agent && typeof agent === 'object') {
      perAgentCache.set(agent as object, { handle: agentDb, path: cachedPath });
    }
    if (!resolutionLogged) {
      log.info({}, 'Memory routes bound to agent-supplied DB (empty)');
      resolutionLogged = true;
    }
    return agentDb;
  }
  if (agentDb) {
    cachedHandle = agentDb;
    cachedPath = '(agent.getDatabase) — legacy primary DB';
    if (agent && typeof agent === 'object') {
      perAgentCache.set(agent as object, { handle: agentDb, path: cachedPath });
    }
    if (!resolutionLogged) {
      log.warn(
        { dataDir, candidates },
        'No cognitive memory DB found; falling back to agent DB',
      );
      resolutionLogged = true;
    }
    return agentDb;
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
