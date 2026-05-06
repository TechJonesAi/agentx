/**
 * Categorized Memory Store — Lifelong Memory Core
 *
 * Production-grade categorized, ranked, project-isolated memory system.
 * SQLite is the durable authority. EventBus provides audit visibility.
 * Backward compatible with LongTermMemoryStore (legacy preserved).
 */

import type Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';
import {
  type MemoryPolicy,
  DEFAULT_MEMORY_POLICY,
  computeRelevanceScore,
  computeRecencyScore,
  computeFrequencyScore,
  computeDecayFactor,
  computeFinalScore,
  effectiveStrength,
  computeReinforcementBump,
  contentHash,
} from './memory-policies.js';

const log = createLogger('memory:categorized');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemoryCategory =
  | 'user_teaching'
  | 'project'
  | 'experience'
  | 'executive'
  | 'research';

export type MemoryState = 'active' | 'archived' | 'consolidated';

export interface CategorizedMemory {
  id: string;
  content: string;
  category: MemoryCategory;
  projectId?: string;
  source: string;
  state: MemoryState;
  strength: number;
  accessCount: number;
  tags: string[];
  embedding?: number[];
  createdAt: number;
  accessedAt: number;
  updatedAt: number;
  archivedAt?: number;
  consolidatedInto?: string;
}

export interface MemorySearchResult {
  memory: CategorizedMemory;
  relevance: number;
  strengthContribution: number;
  recencyContribution: number;
  frequencyContribution: number;
  finalScore: number;
  matchedTerms?: string[];
  /** Unified trace — only populated when explain=true */
  trace?: ResultTrace;
}

/** Per-result unified trace combining base + importance + episodic into one object. */
export interface ResultTrace {
  id: string;
  finalScore: number;
  breakdown: { baseScore: number; importance: number; episodic: number };
  weightedContributions: { base: number; importance: number; episodic: number };
  blendWeights: { baseWeight: number; importanceWeight: number; episodicWeight: number };
  rankingReason: string;
  sourceSignals: {
    relevance: number; strength: number; recency: number; frequency: number;
    importanceDimensions?: { base: number; impact: number; reliability: number; utility: number; userConfirmed: number; learningBoost: number; overall: number } | null;
    episodicContext?: { totalEpisodes: number; successfulEpisodes: number; ratio: number } | null;
  };
}

/** Query-level trace returned alongside search results. */
export interface QueryTrace {
  query: string;
  totalCandidates: number;
  totalResults: number;
  topK: number;
  blendWeights: { baseWeight: number; importanceWeight: number; episodicWeight: number };
  enhancementsActive: { importance: boolean; episodic: boolean };
  decisionSummary: string;
  zeroResultReason?: string;
}

/** Extended search return with query-level trace. */
export interface ExplainedSearchResult {
  results: MemorySearchResult[];
  queryTrace: QueryTrace;
}

/** Minimal EventBus interface so we don't couple to the agent-loop EventBus class */
export interface MemoryEventBus {
  emit(eventType: string, payload: unknown): void;
}

// ---------------------------------------------------------------------------
// Row type for SQLite queries
// ---------------------------------------------------------------------------

interface CategorizedMemoryRow {
  id: string;
  content: string;
  category: string;
  project_id: string | null;
  source: string;
  state: string;
  strength: number;
  access_count: number;
  tags: string;
  embedding: Buffer | null;
  consolidated_into: string | null;
  created_at: number;
  accessed_at: number;
  updated_at: number;
  archived_at: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowToMemory(row: CategorizedMemoryRow): CategorizedMemory {
  return {
    id: row.id,
    content: row.content,
    category: row.category as MemoryCategory,
    projectId: row.project_id ?? undefined,
    source: row.source,
    state: row.state as MemoryState,
    strength: row.strength,
    accessCount: row.access_count,
    tags: JSON.parse(row.tags),
    embedding: row.embedding
      ? Array.from(new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8))
      : undefined,
    createdAt: row.created_at,
    accessedAt: row.accessed_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined,
    consolidatedInto: row.consolidated_into ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// CategorizedMemoryStore
// ---------------------------------------------------------------------------

export class CategorizedMemoryStore {
  private db: Database.Database;
  private eventBus?: MemoryEventBus;
  private policy: MemoryPolicy;
  private importanceScorer: { computeImportance(memory: { id: string; strength: number; accessCount?: number; source?: string }): { base: number; impact: number; reliability: number; utility: number; userConfirmed: number; learningBoost: number; overall: number } } | null = null;
  private episodeStore: { getEpisodesForMemory(memoryId: string): Array<{ outcomeScore?: number }> } | null = null;

  constructor(
    db: Database.Database,
    deps?: { eventBus?: MemoryEventBus; policy?: MemoryPolicy },
  ) {
    this.db = db;
    this.eventBus = deps?.eventBus;
    this.policy = deps?.policy ?? DEFAULT_MEMORY_POLICY;

    // Ensure content_hash column for persistent deduplication
    try { this.db.exec('ALTER TABLE categorized_memory ADD COLUMN content_hash TEXT'); } catch { /* exists */ }
    try { this.db.exec('CREATE INDEX IF NOT EXISTS idx_cm_content_hash ON categorized_memory(content_hash)'); } catch { /* exists */ }

    // Backfill content_hash for any existing rows missing it
    this.backfillContentHashes();

    log.info('CategorizedMemoryStore initialized');
  }

  /** Wire importance scoring into retrieval ranking. */
  setImportanceScorer(scorer: { computeImportance(memory: { id: string; strength: number; accessCount?: number; source?: string }): { base: number; impact: number; reliability: number; utility: number; userConfirmed: number; learningBoost: number; overall: number } }): void {
    this.importanceScorer = scorer;
  }

  /** Wire episodic context into retrieval ranking. */
  setEpisodeStore(store: { getEpisodesForMemory(memoryId: string): Array<{ outcomeScore?: number }> }): void {
    this.episodeStore = store;
  }

  // -----------------------------------------------------------------------
  // Ingestion
  // -----------------------------------------------------------------------

  store(
    content: string,
    category: MemoryCategory,
    opts?: {
      projectId?: string;
      source?: string;
      tags?: string[];
      embedding?: number[];
    },
  ): string {
    const now = Date.now();
    const source = opts?.source ?? 'chat';
    const tags = opts?.tags ?? [];

    // ── Persistent deduplication ──────────────────────────────────
    const hash = this.computeContentHash(content);

    try {
      const existing = this.db.prepare(
        `SELECT id FROM categorized_memory WHERE content_hash = ? AND state = 'active' LIMIT 1`
      ).get(hash) as { id: string } | undefined;

      if (existing) {
        // Duplicate content — reinforce existing instead of creating new
        this.db.prepare(
          `UPDATE categorized_memory SET access_count = access_count + 1, accessed_at = ?, updated_at = ? WHERE id = ?`
        ).run(now, now, existing.id);
        log.debug({ existingId: existing.id, hash }, 'Duplicate memory detected — reinforced existing');
        return existing.id;
      }
    } catch {
      // content_hash column may not exist in test DBs — proceed with insert
    }

    const id = uuid();

    const stmt = this.db.prepare(`
      INSERT INTO categorized_memory
        (id, content, category, project_id, source, state, strength, access_count,
         tags, embedding, content_hash, created_at, accessed_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', 1.0, 0, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      content,
      category,
      opts?.projectId ?? null,
      source,
      JSON.stringify(tags),
      opts?.embedding ? Buffer.from(new Float64Array(opts.embedding).buffer) : null,
      hash,
      now,
      now,
      now,
    );

    this.emit('memory.ingested', {
      memoryId: id,
      category,
      projectId: opts?.projectId,
      source,
      timestamp: now,
    });

    log.debug({ id, category, source }, 'Stored categorized memory');
    return id;
  }

  /**
   * Backfill content_hash for rows that were inserted before the column existed.
   * Safe to run repeatedly — only touches NULL hashes.
   */
  private backfillContentHashes(): void {
    try {
      const rows = this.db.prepare(
        `SELECT id, content FROM categorized_memory WHERE content_hash IS NULL`
      ).all() as Array<{ id: string; content: string }>;

      if (rows.length === 0) return;

      const update = this.db.prepare(
        `UPDATE categorized_memory SET content_hash = ? WHERE id = ?`
      );

      for (const row of rows) {
        const hash = this.computeContentHash(row.content);
        update.run(hash, row.id);
      }

      log.info({ backfilled: rows.length }, 'Backfilled content hashes for deduplication');
    } catch {
      // Table may not exist yet
    }
  }

  /**
   * Compute a normalized content hash for deduplication.
   * Lowercase, strip punctuation, collapse whitespace → SHA-256.
   */
  private computeContentHash(content: string): string {
    const normalized = content.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
    return crypto.createHash('sha256').update(normalized).digest('hex').slice(0, 32);
  }

  /**
   * Get all existing content hashes for external dedup seeding.
   */
  getExistingContentHashes(): string[] {
    try {
      const rows = this.db.prepare(
        `SELECT content_hash FROM categorized_memory WHERE content_hash IS NOT NULL AND state = 'active'`
      ).all() as Array<{ content_hash: string }>;
      return rows.map(r => r.content_hash);
    } catch {
      return [];
    }
  }

  teach(
    content: string,
    tags?: string[],
    opts?: { projectId?: string; source?: string },
  ): string {
    return this.store(content, 'user_teaching', {
      projectId: opts?.projectId,
      source: opts?.source ?? 'user',
      tags,
    });
  }

  // -----------------------------------------------------------------------
  // Retrieval — Ranked Search
  // -----------------------------------------------------------------------

  search(
    query: string,
    opts?: {
      category?: MemoryCategory;
      projectId?: string;
      includeGlobal?: boolean;
      limit?: number;
      minStrength?: number;
      includeArchived?: boolean;
    },
  ): MemorySearchResult[] {
    const limit = opts?.limit ?? 20;
    const minStrength = opts?.minStrength ?? 0;
    const includeArchived = opts?.includeArchived ?? false;
    const includeGlobal = opts?.includeGlobal ?? false;

    // Build WHERE clauses
    const conditions: string[] = [];
    const params: unknown[] = [];

    // State filter
    if (includeArchived) {
      conditions.push("state != 'consolidated'");
    } else {
      conditions.push("state = 'active'");
    }

    // Strength filter
    if (minStrength > 0) {
      conditions.push('strength >= ?');
      params.push(minStrength);
    }

    // Category filter
    if (opts?.category) {
      conditions.push('category = ?');
      params.push(opts.category);
    }

    // Project isolation — STRICT
    if (opts?.projectId) {
      if (includeGlobal) {
        conditions.push('(project_id = ? OR project_id IS NULL)');
        params.push(opts.projectId);
      } else {
        conditions.push('project_id = ?');
        params.push(opts.projectId);
      }
    }

    // Content match — fetch candidates (over-fetch for ranking)
    const fetchLimit = Math.max(limit * 5, 100);
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      ${whereClause}
      ORDER BY accessed_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(...params, fetchLimit) as CategorizedMemoryRow[];

    // Score and rank
    const now = Date.now();
    const weights = this.policy.rankingWeights;
    const halfLife = this.policy.decay.halfLifeDays;

    const results: MemorySearchResult[] = [];

    for (const row of rows) {
      const memory = rowToMemory(row);
      const { score: relevance, matchedTerms } = computeRelevanceScore(query, memory.content);

      // Skip irrelevant memories
      if (relevance <= 0) continue;

      const strengthVal = effectiveStrength(
        memory.strength,
        memory.accessedAt,
        memory.createdAt,
        halfLife,
        now,
      );
      const recency = computeRecencyScore(memory.accessedAt, memory.createdAt, now);
      const frequency = computeFrequencyScore(memory.accessCount);

      const strengthContribution = strengthVal * weights.strength;
      const recencyContribution = recency * weights.recency;
      const frequencyContribution = frequency * weights.frequency;
      const relevanceContribution = relevance * weights.relevance;

      let baseScore = computeFinalScore(relevance, strengthVal, recency, frequency, weights);

      // ── Importance scoring integration ──────────────────────────────
      // When ImportanceScorer is wired, blend multi-factor importance
      // into the ranking. This makes learning signals, episode outcomes,
      // and user confirmations influence retrieval.
      //
      // Formula: finalScore = baseScore * 0.65 + importanceScore * 0.25 + episodicBoost * 0.10
      let importanceContribution = 0;
      let episodicContribution = 0;

      if (this.importanceScorer) {
        try {
          const importance = this.importanceScorer.computeImportance({
            id: memory.id,
            strength: memory.strength,
            accessCount: memory.accessCount,
            source: memory.source,
          });
          importanceContribution = importance.overall;
        } catch {
          // ImportanceScorer may fail if tables aren't ready
        }
      }

      // ── Episodic context integration ────────────────────────────────
      // Memories that appeared in successful past episodes get boosted.
      if (this.episodeStore) {
        try {
          const episodes = this.episodeStore.getEpisodesForMemory(memory.id);
          if (episodes.length > 0) {
            const successfulEps = episodes.filter(e => e.outcomeScore !== undefined && e.outcomeScore > 0.5);
            episodicContribution = successfulEps.length > 0
              ? Math.min(1, successfulEps.length / Math.max(1, episodes.length))
              : 0.1; // Appeared in episodes but none successful
          }
        } catch {
          // EpisodeStore may fail if tables aren't ready
        }
      }

      // ── Category + conciseness boost ──────────────────────────────
      // user_teaching memories contain explicit user facts and preferences
      // and should rank above incidental matches in experience/research.
      // Concise memories (< 200 chars) are boosted as they are more likely
      // to be factual statements. Very long entries (> 500 chars) that
      // happen to match common terms are penalised as they are likely
      // prompt/context blobs rather than user facts.
      let categoryBoost = 0;
      if (memory.category === 'user_teaching') {
        if (memory.content.length < 200) {
          categoryBoost = 0.35;
        } else if (memory.content.length < 500) {
          categoryBoost = 0.15;
        } else {
          // Long prompt-like content — penalise to prevent noise domination
          categoryBoost = -0.15;
        }
      }

      // ── Final blended score (policy-driven, not hardcoded) ──────────
      const hasEnhancements = this.importanceScorer || this.episodeStore;
      const blend = this.policy.retrievalBlend;
      const finalScore = (hasEnhancements
        ? baseScore * blend.baseWeight + importanceContribution * blend.importanceWeight + episodicContribution * blend.episodicWeight
        : baseScore) + categoryBoost;

      results.push({
        memory,
        relevance: relevanceContribution,
        strengthContribution,
        recencyContribution,
        frequencyContribution,
        finalScore,
        matchedTerms,
      });
    }

    // Sort by finalScore descending, then by createdAt descending for ties
    results.sort((a, b) => {
      const diff = b.finalScore - a.finalScore;
      if (Math.abs(diff) > 0.0001) return diff;
      return b.memory.createdAt - a.memory.createdAt;
    });

    return results.slice(0, limit);
  }

  /**
   * Search with full unified trace — combines base + importance + episodic
   * into one coherent explanation per result, plus query-level diagnostics.
   * Uses the same scoring as search() — NO duplicate logic.
   */
  explainedSearch(
    query: string,
    opts?: {
      category?: MemoryCategory;
      projectId?: string;
      includeGlobal?: boolean;
      limit?: number;
      minStrength?: number;
      includeArchived?: boolean;
    },
  ): ExplainedSearchResult {
    const limit = opts?.limit ?? 20;
    const minStrength = opts?.minStrength ?? 0;
    const includeArchived = opts?.includeArchived ?? false;
    const includeGlobal = opts?.includeGlobal ?? false;

    // Build WHERE clauses (identical to search())
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (includeArchived) {
      conditions.push("state != 'consolidated'");
    } else {
      conditions.push("state = 'active'");
    }
    if (minStrength > 0) { conditions.push('strength >= ?'); params.push(minStrength); }
    if (opts?.category) { conditions.push('category = ?'); params.push(opts.category); }
    if (opts?.projectId) {
      if (includeGlobal) {
        conditions.push('(project_id = ? OR project_id IS NULL)');
        params.push(opts.projectId);
      } else {
        conditions.push('project_id = ?');
        params.push(opts.projectId);
      }
    }

    const fetchLimit = Math.max(limit * 5, 100);
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      ${whereClause}
      ORDER BY accessed_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(...params, fetchLimit) as CategorizedMemoryRow[];
    const totalCandidates = rows.length;

    const now = Date.now();
    const weights = this.policy.rankingWeights;
    const halfLife = this.policy.decay.halfLifeDays;
    const blend = this.policy.retrievalBlend;
    const hasEnhancements = !!(this.importanceScorer || this.episodeStore);

    const results: MemorySearchResult[] = [];

    for (const row of rows) {
      const memory = rowToMemory(row);
      const { score: relevance, matchedTerms } = computeRelevanceScore(query, memory.content);
      if (relevance <= 0) continue;

      const strengthVal = effectiveStrength(memory.strength, memory.accessedAt, memory.createdAt, halfLife, now);
      const recency = computeRecencyScore(memory.accessedAt, memory.createdAt, now);
      const frequency = computeFrequencyScore(memory.accessCount);

      const strengthContribution = strengthVal * weights.strength;
      const recencyContribution = recency * weights.recency;
      const frequencyContribution = frequency * weights.frequency;
      const relevanceContribution = relevance * weights.relevance;

      const baseScore = computeFinalScore(relevance, strengthVal, recency, frequency, weights);

      // Importance
      let importanceContribution = 0;
      let importanceDimensions: ResultTrace['sourceSignals']['importanceDimensions'] = null;
      if (this.importanceScorer) {
        try {
          const imp = this.importanceScorer.computeImportance({
            id: memory.id, strength: memory.strength,
            accessCount: memory.accessCount, source: memory.source,
          });
          importanceContribution = imp.overall;
          importanceDimensions = imp;
        } catch { /* scorer not ready */ }
      }

      // Episodic
      let episodicContribution = 0;
      let episodicContext: ResultTrace['sourceSignals']['episodicContext'] = null;
      if (this.episodeStore) {
        try {
          const episodes = this.episodeStore.getEpisodesForMemory(memory.id);
          if (episodes.length > 0) {
            const successfulEps = episodes.filter(e => e.outcomeScore !== undefined && e.outcomeScore > 0.5);
            episodicContribution = successfulEps.length > 0
              ? Math.min(1, successfulEps.length / Math.max(1, episodes.length))
              : 0.1;
            episodicContext = { totalEpisodes: episodes.length, successfulEpisodes: successfulEps.length, ratio: episodicContribution };
          }
        } catch { /* store not ready */ }
      }

      // ── Category + conciseness boost (same as search()) ───────────
      let categoryBoost = 0;
      if (memory.category === 'user_teaching') {
        if (memory.content.length < 200) {
          categoryBoost = 0.35;
        } else if (memory.content.length < 500) {
          categoryBoost = 0.15;
        } else {
          categoryBoost = -0.15;
        }
      }

      const finalScore = (hasEnhancements
        ? baseScore * blend.baseWeight + importanceContribution * blend.importanceWeight + episodicContribution * blend.episodicWeight
        : baseScore) + categoryBoost;

      // Build ranking reason
      const reasons: string[] = [];
      if (relevance > 0.8) reasons.push('strong keyword match');
      else if (relevance > 0.3) reasons.push('partial keyword match');
      if (memory.source === 'user_teaching') reasons.push('user-taught');
      if (categoryBoost > 0) reasons.push('concise user fact');
      if (importanceDimensions && importanceDimensions.overall > 0.7) reasons.push('high importance');
      if (episodicContext && episodicContext.successfulEpisodes > 0) reasons.push(`used in ${episodicContext.successfulEpisodes} successful episode(s)`);
      if (strengthVal > 0.8) reasons.push('high strength');

      const trace: ResultTrace = {
        id: memory.id,
        finalScore,
        breakdown: { baseScore, importance: importanceContribution, episodic: episodicContribution },
        weightedContributions: {
          base: baseScore * blend.baseWeight,
          importance: importanceContribution * blend.importanceWeight,
          episodic: episodicContribution * blend.episodicWeight,
        },
        blendWeights: { ...blend },
        rankingReason: reasons.length > 0 ? reasons.join('; ') : 'relevance match only',
        sourceSignals: {
          relevance, strength: strengthVal, recency, frequency,
          importanceDimensions, episodicContext,
        },
      };

      results.push({
        memory, relevance: relevanceContribution, strengthContribution,
        recencyContribution, frequencyContribution, finalScore, matchedTerms, trace,
      });
    }

    results.sort((a, b) => {
      const diff = b.finalScore - a.finalScore;
      if (Math.abs(diff) > 0.0001) return diff;
      return b.memory.createdAt - a.memory.createdAt;
    });

    const topResults = results.slice(0, limit);

    // Build query-level trace
    let zeroResultReason: string | undefined;
    if (topResults.length === 0) {
      if (rows.length === 0) {
        zeroResultReason = 'No memories in store match filters (category/project/state). Check ingestion.';
      } else {
        zeroResultReason = `${totalCandidates} memories examined but none matched query keywords. The query terms "${query}" did not appear in any stored memory content.`;
      }
    }

    const decisionParts: string[] = [];
    decisionParts.push(`Examined ${totalCandidates} candidate memories`);
    decisionParts.push(`${results.length} matched keywords`);
    if (hasEnhancements) {
      decisionParts.push(`Blend: base×${blend.baseWeight} + importance×${blend.importanceWeight} + episodic×${blend.episodicWeight}`);
    } else {
      decisionParts.push('Pure base scoring (no importance/episodic wired)');
    }
    decisionParts.push(`Returning top ${topResults.length}`);

    const queryTrace: QueryTrace = {
      query,
      totalCandidates,
      totalResults: results.length,
      topK: limit,
      blendWeights: { ...blend },
      enhancementsActive: { importance: !!this.importanceScorer, episodic: !!this.episodeStore },
      decisionSummary: decisionParts.join(' → '),
      zeroResultReason,
    };

    return { results: topResults, queryTrace };
  }

  searchByTags(
    tags: string[],
    opts?: {
      category?: MemoryCategory;
      projectId?: string;
      includeGlobal?: boolean;
      limit?: number;
      includeArchived?: boolean;
    },
  ): MemorySearchResult[] {
    const limit = opts?.limit ?? 20;
    const includeArchived = opts?.includeArchived ?? false;
    const includeGlobal = opts?.includeGlobal ?? false;

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (includeArchived) {
      conditions.push("state != 'consolidated'");
    } else {
      conditions.push("state = 'active'");
    }

    if (opts?.category) {
      conditions.push('category = ?');
      params.push(opts.category);
    }

    if (opts?.projectId) {
      if (includeGlobal) {
        conditions.push('(project_id = ? OR project_id IS NULL)');
        params.push(opts.projectId);
      } else {
        conditions.push('project_id = ?');
        params.push(opts.projectId);
      }
    }

    const fetchLimit = Math.max(limit * 5, 100);
    const whereClause = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      ${whereClause}
      ORDER BY accessed_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(...params, fetchLimit) as CategorizedMemoryRow[];
    const now = Date.now();
    const weights = this.policy.rankingWeights;
    const halfLife = this.policy.decay.halfLifeDays;
    const results: MemorySearchResult[] = [];

    for (const row of rows) {
      const memory = rowToMemory(row);
      const memoryTags = memory.tags;
      const matched = tags.filter(t => memoryTags.includes(t));
      if (matched.length === 0) continue;

      const tagRelevance = matched.length / tags.length;
      const strengthVal = effectiveStrength(
        memory.strength, memory.accessedAt, memory.createdAt, halfLife, now,
      );
      const recency = computeRecencyScore(memory.accessedAt, memory.createdAt, now);
      const frequency = computeFrequencyScore(memory.accessCount);
      const finalScore = computeFinalScore(tagRelevance, strengthVal, recency, frequency, weights);

      results.push({
        memory,
        relevance: tagRelevance * weights.relevance,
        strengthContribution: strengthVal * weights.strength,
        recencyContribution: recency * weights.recency,
        frequencyContribution: frequency * weights.frequency,
        finalScore,
        matchedTerms: matched,
      });
    }

    results.sort((a, b) => b.finalScore - a.finalScore);
    return results.slice(0, limit);
  }

  getByProject(projectId: string, limit = 50): CategorizedMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      WHERE project_id = ? AND state = 'active'
      ORDER BY accessed_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(projectId, limit) as CategorizedMemoryRow[];
    return rows.map(rowToMemory);
  }

  getUserTeachings(limit = 50): CategorizedMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      WHERE category = 'user_teaching' AND state = 'active'
      ORDER BY accessed_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as CategorizedMemoryRow[];
    return rows.map(rowToMemory);
  }

  getById(id: string): CategorizedMemory | undefined {
    const stmt = this.db.prepare('SELECT * FROM categorized_memory WHERE id = ?');
    const row = stmt.get(id) as CategorizedMemoryRow | undefined;
    return row ? rowToMemory(row) : undefined;
  }

  /** Get all active memories (for consolidation scanning) */
  getAllActive(limit = 1000): CategorizedMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      WHERE state = 'active'
      ORDER BY created_at DESC
      LIMIT ?
    `);
    const rows = stmt.all(limit) as CategorizedMemoryRow[];
    return rows.map(rowToMemory);
  }

  // -----------------------------------------------------------------------
  // Lifecycle
  // -----------------------------------------------------------------------

  reinforce(id: string): void {
    const memory = this.getById(id);
    if (!memory) {
      log.warn({ id }, 'Cannot reinforce: memory not found');
      return;
    }

    const now = Date.now();
    const newStrength = computeReinforcementBump(memory.strength);

    this.db.prepare(`
      UPDATE categorized_memory
      SET strength = ?, access_count = access_count + 1,
          accessed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(newStrength, now, now, id);

    this.emit('memory.reinforced', {
      memoryId: id,
      category: memory.category,
      projectId: memory.projectId,
      priorStrength: memory.strength,
      newStrength,
      accessCount: memory.accessCount + 1,
      timestamp: now,
    });

    log.debug({ id, priorStrength: memory.strength, newStrength }, 'Memory reinforced');
  }

  decay(maxAgeDays?: number): number {
    const halfLife = this.policy.decay.halfLifeDays;
    const archiveThreshold = this.policy.decay.minStrengthBeforeArchive;
    const now = Date.now();
    const maxAge = maxAgeDays ?? 365;
    const cutoff = now - maxAge * 24 * 60 * 60 * 1000;

    // Get active memories that haven't been accessed since cutoff
    // Skip core memories — they never decay
    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      WHERE state = 'active' AND accessed_at < ?
        AND (core IS NULL OR core = 0)
      ORDER BY accessed_at ASC
    `);
    const rows = stmt.all(cutoff) as CategorizedMemoryRow[];

    let decayedCount = 0;
    const updateStmt = this.db.prepare(`
      UPDATE categorized_memory
      SET strength = ?, updated_at = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      const factor = computeDecayFactor(row.accessed_at, row.created_at, halfLife, now);
      const newStrength = row.strength * factor;

      if (newStrength < archiveThreshold) {
        // Auto-archive
        this.archive(row.id);
      } else if (Math.abs(newStrength - row.strength) > 0.001) {
        updateStmt.run(newStrength, now, row.id);
        decayedCount++;

        this.emit('memory.decayed', {
          memoryId: row.id,
          category: row.category,
          projectId: row.project_id,
          priorStrength: row.strength,
          newStrength,
          timestamp: now,
        });
      }
    }

    log.info({ decayedCount, maxAgeDays: maxAge }, 'Decay pass completed');
    return decayedCount;
  }

  promote(id: string, newCategory: MemoryCategory): void {
    const memory = this.getById(id);
    if (!memory) {
      log.warn({ id }, 'Cannot promote: memory not found');
      return;
    }

    const now = Date.now();
    const priorCategory = memory.category;

    this.db.prepare(`
      UPDATE categorized_memory
      SET category = ?, updated_at = ?
      WHERE id = ?
    `).run(newCategory, now, id);

    this.emit('memory.promoted', {
      memoryId: id,
      priorCategory,
      newCategory,
      timestamp: now,
    });

    log.info({ id, priorCategory, newCategory }, 'Memory promoted');
  }

  consolidate(ids: string[], mergedContent: string): string {
    if (ids.length < 2) {
      throw new Error('Consolidation requires at least 2 memory IDs');
    }

    // Get the first memory to inherit category/project
    const first = this.getById(ids[0]);
    if (!first) {
      throw new Error(`Memory not found: ${ids[0]}`);
    }

    // Create merged memory
    const mergedId = this.store(mergedContent, first.category, {
      projectId: first.projectId,
      source: 'consolidation',
      tags: [...new Set(ids.flatMap(id => this.getById(id)?.tags ?? []))],
    });

    const now = Date.now();

    // Mark originals as consolidated
    const updateStmt = this.db.prepare(`
      UPDATE categorized_memory
      SET state = 'consolidated', consolidated_into = ?, updated_at = ?
      WHERE id = ?
    `);

    for (const id of ids) {
      updateStmt.run(mergedId, now, id);
    }

    this.emit('memory.consolidated', {
      mergedMemoryId: mergedId,
      originalMemoryIds: ids,
      category: first.category,
      projectId: first.projectId,
      timestamp: now,
    });

    log.info({ mergedId, originalCount: ids.length }, 'Memories consolidated');
    return mergedId;
  }

  archive(id: string): void {
    const memory = this.getById(id);
    if (!memory) {
      log.warn({ id }, 'Cannot archive: memory not found');
      return;
    }

    const now = Date.now();
    const priorState = memory.state;

    this.db.prepare(`
      UPDATE categorized_memory
      SET state = 'archived', archived_at = ?, updated_at = ?
      WHERE id = ?
    `).run(now, now, id);

    this.emit('memory.archived', {
      memoryId: id,
      category: memory.category,
      projectId: memory.projectId,
      priorState,
      newState: 'archived',
      timestamp: now,
    });

    log.debug({ id }, 'Memory archived');
  }

  // -----------------------------------------------------------------------
  // Core Memories
  // -----------------------------------------------------------------------

  /** List all core memories (never decay, always top importance). */
  getCore(limit = 50): CategorizedMemory[] {
    try {
      const rows = this.db.prepare(`
        SELECT * FROM categorized_memory WHERE core = 1 LIMIT ?
      `).all(limit) as CategorizedMemoryRow[];
      return rows.map(rowToMemory);
    } catch {
      return []; // core column may not exist yet
    }
  }

  // -----------------------------------------------------------------------
  // Audit / Inspection
  // -----------------------------------------------------------------------

  getStats(): {
    total: number;
    byCategory: Record<MemoryCategory, number>;
    byState: Record<MemoryState, number>;
    avgStrength: number;
  } {
    const categories: MemoryCategory[] = ['user_teaching', 'project', 'experience', 'executive', 'research'];
    const states: MemoryState[] = ['active', 'archived', 'consolidated'];

    const totalRow = this.db.prepare('SELECT COUNT(*) as count FROM categorized_memory').get() as { count: number };
    const avgRow = this.db.prepare(
      "SELECT AVG(strength) as avg FROM categorized_memory WHERE state = 'active'",
    ).get() as { avg: number | null };

    const byCategory = {} as Record<MemoryCategory, number>;
    for (const cat of categories) {
      const row = this.db.prepare(
        'SELECT COUNT(*) as count FROM categorized_memory WHERE category = ?',
      ).get(cat) as { count: number };
      byCategory[cat] = row.count;
    }

    const byState = {} as Record<MemoryState, number>;
    for (const st of states) {
      const row = this.db.prepare(
        'SELECT COUNT(*) as count FROM categorized_memory WHERE state = ?',
      ).get(st) as { count: number };
      byState[st] = row.count;
    }

    return {
      total: totalRow.count,
      byCategory,
      byState,
      avgStrength: Math.round((avgRow.avg ?? 0) * 1000) / 1000,
    };
  }

  getWeakMemories(threshold = 0.3, limit = 20): CategorizedMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      WHERE state = 'active' AND strength < ?
      ORDER BY strength ASC
      LIMIT ?
    `);
    const rows = stmt.all(threshold, limit) as CategorizedMemoryRow[];
    return rows.map(rowToMemory);
  }

  getStaleMemories(olderThanDays: number, limit = 20): CategorizedMemory[] {
    const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;
    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      WHERE state = 'active' AND accessed_at < ?
      ORDER BY accessed_at ASC
      LIMIT ?
    `);
    const rows = stmt.all(cutoff, limit) as CategorizedMemoryRow[];
    return rows.map(rowToMemory);
  }

  getDiagnostics(): Record<string, unknown> {
    const stats = this.getStats();
    const weakCount = this.db.prepare(
      "SELECT COUNT(*) as count FROM categorized_memory WHERE state = 'active' AND strength < 0.3",
    ).get() as { count: number };
    const staleCount = this.db.prepare(
      "SELECT COUNT(*) as count FROM categorized_memory WHERE state = 'active' AND accessed_at < ?",
    ).get(Date.now() - 30 * 24 * 60 * 60 * 1000) as { count: number };

    return {
      ...stats,
      weakMemories: weakCount.count,
      staleMemories: staleCount.count,
      policyDecayEnabled: this.policy.decay.enabled,
      policyHalfLifeDays: this.policy.decay.halfLifeDays,
      retrievalBlend: { ...this.policy.retrievalBlend },
      hasImportanceScorer: !!this.importanceScorer,
      hasEpisodeStore: !!this.episodeStore,
      hasEventBus: !!this.eventBus,
    };
  }

  // -----------------------------------------------------------------------
  // Migration helper — report legacy vs categorized counts
  // -----------------------------------------------------------------------

  getLegacyMigrationInfo(): { legacyCount: number; categorizedCount: number } {
    let legacyCount = 0;
    try {
      const row = this.db.prepare('SELECT COUNT(*) as count FROM long_term_memory').get() as { count: number };
      legacyCount = row.count;
    } catch {
      // long_term_memory table may not exist in test DBs
    }
    const catRow = this.db.prepare('SELECT COUNT(*) as count FROM categorized_memory').get() as { count: number };
    return { legacyCount, categorizedCount: catRow.count };
  }

  // -----------------------------------------------------------------------
  // Duplicate detection helper (used by ingestion engine)
  // -----------------------------------------------------------------------

  findByContentHash(hash: string): CategorizedMemory | undefined {
    // We compute hash on the fly since we don't store it in DB
    // (to avoid schema change for now — content hash is deterministic)
    const stmt = this.db.prepare(`
      SELECT * FROM categorized_memory
      WHERE state = 'active'
      ORDER BY created_at DESC
      LIMIT 500
    `);
    const rows = stmt.all() as CategorizedMemoryRow[];
    for (const row of rows) {
      if (contentHash(row.content) === hash) {
        return rowToMemory(row);
      }
    }
    return undefined;
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private emit(eventType: string, payload: unknown): void {
    if (this.eventBus) {
      try {
        this.eventBus.emit(eventType, payload);
      } catch (e) {
        log.warn({ eventType, error: e }, 'Failed to emit memory event');
      }
    }
  }
}
