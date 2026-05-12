/**
 * Cognitive Adapter — minimal book-route facade.
 *
 * Design decision (VERIFY-pass): Silly Johnson's full cognitive-adapter
 * eagerly instantiates EvidenceAggregator, RankingService, ContextBuilder,
 * ContradictionDetector, QueryIntentRouter, EntityIndexService,
 * FTSIndexService, VectorIndexService, RetrievalService, and LearningService.
 *
 * Lifting RankingService / ContextBuilder / ContradictionDetector wholesale
 * would require either:
 *   (a) replacing main's LearningService API with silly's
 *       (getBoostsForDocuments / getBoostsForEntities / BoostResult), OR
 *   (b) replacing main's EvidenceAggregator with silly's (different exported
 *       type surface — main exports only the class; silly exports
 *       EvidenceItem / EvidenceBundle / AggregatedEvidence / EvidenceMatchType).
 *
 * Either path destabilises R1–R12 retrieval and risks the working Memory
 * page (253 docs visible). The user's hard rules forbid both.
 *
 * Empirical finding: silly's book route handlers ONLY ever touch `svc.db`.
 * They never call ranking, detector, contextBuilder, aggregator, router,
 * or learning. So this adapter exposes just `{db}` — the same SQLite
 * handle that memory-db.ts already resolves to cognitive_memory.db.
 *
 * Result: Cognitive Books backend works against your existing 253-document
 * dataset (including the 2 books on disk) without lifting any retrieval
 * services. Future restoration of the heavier services can be a separate
 * batch when R1–R12 has a migration path that doesn't break main.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger, resolveDataDir } from '@agentx/core';

const log = createLogger('web:cognitive-adapter');

interface DbStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): { changes?: number; lastInsertRowid?: number | bigint };
}
export interface CognitiveDb {
  prepare(sql: string): DbStatement;
  exec(sql: string): void;
  close?(): void;
}

export interface CognitiveServices {
  db: CognitiveDb;
  dbPath: string;
}

interface BetterSqliteCtor {
  new (filename: string, options?: { readonly?: boolean; fileMustExist?: boolean }): CognitiveDb & {
    pragma(s: string): unknown;
  };
}

// Cached per-agent so parallel test workers don't share a handle from a
// previous agent. Same pattern as memory-db.ts.
const perAgentCache = new WeakMap<object, CognitiveServices>();
let lastResolved: CognitiveServices | null = null;
let resolutionLogged = false;

function hasDocumentsTable(db: CognitiveDb): boolean {
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
    log.warn({ err: (err as Error).message }, 'better-sqlite3 not loadable');
    return null;
  }
}

/**
 * Resolve the cognitive-services bundle for book routes. Returns null when
 * no SQLite handle can be opened.
 *
 * Resolution order:
 *   1. agent.getDatabase() if it has a `documents` table (test agents).
 *   2. ~/.agentx/cognitive_memory.db (silly underscore — production).
 *   3. ~/.agentx/cognitive-memory.db (hyphen variant).
 *   4. agent.getDatabase() fallback.
 */
export async function getCognitiveServices(agent: unknown): Promise<CognitiveServices | null> {
  // Per-agent cache hit
  if (agent && typeof agent === 'object') {
    const cached = perAgentCache.get(agent as object);
    if (cached) return cached;
  }

  // 1. Agent-supplied DB (test fakes wire a real schema)
  const agentDb = (agent as { getDatabase?: () => CognitiveDb }).getDatabase?.();
  if (agentDb && hasDocumentsTable(agentDb)) {
    const services: CognitiveServices = { db: agentDb, dbPath: '(agent.getDatabase)' };
    if (agent && typeof agent === 'object') perAgentCache.set(agent as object, services);
    lastResolved = services;
    if (!resolutionLogged) {
      log.info({}, 'Cognitive adapter bound to agent-supplied DB');
      resolutionLogged = true;
    }
    return services;
  }

  // 2 + 3. On-disk cognitive_memory.db candidates
  const Better = await loadBetterSqlite();
  if (Better) {
    const dataDir = resolveDataDir();
    const candidates = [
      path.join(dataDir, 'cognitive_memory.db'),
      path.join(dataDir, 'cognitive-memory.db'),
    ];
    for (const filePath of candidates) {
      if (!fs.existsSync(filePath)) continue;
      try {
        const handle = new Better(filePath, { fileMustExist: true });
        try { handle.pragma('busy_timeout = 5000'); } catch { /* */ }
        if (hasDocumentsTable(handle)) {
          const services: CognitiveServices = { db: handle, dbPath: filePath };
          if (agent && typeof agent === 'object') perAgentCache.set(agent as object, services);
          lastResolved = services;
          if (!resolutionLogged) {
            log.info({ filePath }, 'Cognitive adapter bound to on-disk DB');
            resolutionLogged = true;
          }
          return services;
        } else {
          try { handle.close?.(); } catch { /* */ }
        }
      } catch (err) {
        log.warn({ err: (err as Error).message, filePath }, 'Failed to open candidate cognitive DB');
      }
    }
  }

  // 4. Fallback — agent DB even without documents table. Route handlers
  // graceful-degrade to empty arrays when tables are missing.
  if (agentDb) {
    const services: CognitiveServices = { db: agentDb, dbPath: '(agent.getDatabase) — fallback' };
    if (agent && typeof agent === 'object') perAgentCache.set(agent as object, services);
    lastResolved = services;
    return services;
  }

  return null;
}

/** TEST ONLY — reset the cache so each test can re-bind cleanly. */
export function _resetCognitiveServicesForTests(): void {
  lastResolved = null;
  resolutionLogged = false;
  // WeakMap doesn't have a clear() — let GC handle it; new test agents
  // are new objects, so they bypass the cache anyway.
}

/** Diagnostics — returns dbPath of the most recently resolved handle. */
export function getCognitiveDiagnostics(): { dbPath: string | null } {
  return { dbPath: lastResolved?.dbPath ?? null };
}
