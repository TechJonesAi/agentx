/**
 * Knowledge Flow Engine — Cross-session learning integration
 *
 * Wires learning signals INTO memory ranking and importance:
 * - Successful signals reinforce linked memories
 * - Episode outcomes boost/decay linked memories
 * - High-usage memories get promoted
 * - Retrieval results re-ranked by importance scoring
 *
 * This is the glue between LearningEngine, EpisodeStore, ImportanceScorer,
 * and CategorizedMemoryStore.
 */

import { createLogger } from '../logger.js';
import type { SqliteMemoryDb } from '../db/sqlite-memory.js';
import type { LearningEngine } from '../learning/learning-engine.js';
import type { EpisodeStore } from './episodic-memory.js';
import type { ImportanceScorer, ImportanceScore } from './importance-scorer.js';

const log = createLogger('memory:knowledge-flow');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface KnowledgeFlowStats {
  signalsProcessed: number;
  reinforcements: number;
  penalties: number;
  promotions: number;
  rerankedQueries: number;
}

export interface RerankedResult {
  id: string;
  content: string;
  originalScore: number;
  importanceScore: number;
  finalScore: number;
}

// ---------------------------------------------------------------------------
// KnowledgeFlowEngine
// ---------------------------------------------------------------------------

export class KnowledgeFlowEngine {
  private db: SqliteMemoryDb;
  private learningEngine: LearningEngine | null;
  private episodeStore: EpisodeStore | null;
  private importanceScorer: ImportanceScorer | null;
  private stats: KnowledgeFlowStats = {
    signalsProcessed: 0,
    reinforcements: 0,
    penalties: 0,
    promotions: 0,
    rerankedQueries: 0,
  };

  constructor(
    db: SqliteMemoryDb,
    learningEngine?: LearningEngine,
    episodeStore?: EpisodeStore,
    importanceScorer?: ImportanceScorer,
  ) {
    this.db = db;
    this.learningEngine = learningEngine ?? null;
    this.episodeStore = episodeStore ?? null;
    this.importanceScorer = importanceScorer ?? null;
    log.info('Knowledge flow engine initialized');
  }

  /**
   * Process recent learning signals and apply to memory ranking.
   *
   * Success patterns (score > 0.5):
   *   → reinforce linked memories (strength boost)
   *   → recalculate importance scores
   *
   * Failure patterns (score ≤ 0.5 or success=false):
   *   → reduce linked memory strength (soft decay, never below 0.1)
   *   → recalculate importance scores (reliability dimension drops)
   */
  processSignals(limit = 100): number {
    if (!this.learningEngine) return 0;

    let processed = 0;
    const subsystems = this.learningEngine.getSubsystems();

    for (const sub of subsystems) {
      const signals = this.learningEngine.getSignals(sub, limit);

      for (const signal of signals) {
        const memoryIds = this.extractMemoryIds(signal.input, signal.output);

        if (signal.success && signal.score !== undefined && signal.score > 0.5) {
          // ── SUCCESS PATTERN: boost linked memories ──
          for (const memoryId of memoryIds) {
            this.reinforceMemory(memoryId, signal.score * 0.1);
            this.stats.reinforcements++;
          }
        } else if (!signal.success || (signal.score !== undefined && signal.score <= 0.3)) {
          // ── FAILURE PATTERN: soft-decay linked memories ──
          for (const memoryId of memoryIds) {
            this.penalizeMemory(memoryId, 0.05);
            this.stats.penalties++;
          }
        }

        // Recalculate importance for all referenced memories
        if (this.importanceScorer) {
          for (const memoryId of memoryIds) {
            this.recalculateImportance(memoryId);
          }
        }

        processed++;
      }
    }

    this.stats.signalsProcessed += processed;
    if (processed > 0) {
      log.info({ processed, reinforcements: this.stats.reinforcements, penalties: this.stats.penalties }, 'Learning signals processed');
    }
    return processed;
  }

  /**
   * When an episode closes, apply outcome to all linked memories.
   *
   * Successful episodes (outcomeScore > 0.5):
   *   → reinforce all linked memories proportionally
   *   → recalculate importance (impact dimension increases)
   *
   * Failed episodes (outcomeScore ≤ 0.5):
   *   → soft-decay linked memories proportionally
   *   → recalculate importance (impact dimension decreases)
   */
  reinforceFromEpisode(episodeId: string): number {
    if (!this.episodeStore) return 0;

    const episode = this.episodeStore.getEpisode(episodeId);
    if (!episode) return 0;
    if (episode.status !== 'closed') return 0;
    if (episode.outcomeScore === undefined) return 0;

    let affected = 0;
    const isSuccess = episode.outcomeScore > 0.5;

    for (const memoryId of episode.linkedMemoryIds) {
      if (isSuccess) {
        // Boost proportional to outcome score
        const boost = episode.outcomeScore * 0.15;
        this.reinforceMemory(memoryId, boost);
        this.stats.reinforcements++;
      } else {
        // Penalize proportional to failure severity
        const penalty = (1 - episode.outcomeScore) * 0.08;
        this.penalizeMemory(memoryId, penalty);
        this.stats.penalties++;
      }
      affected++;
    }

    // Recalculate importance for all linked memories
    if (this.importanceScorer) {
      for (const memoryId of episode.linkedMemoryIds) {
        this.recalculateImportance(memoryId);
      }
    }

    log.info({ episodeId, affected, isSuccess, outcomeScore: episode.outcomeScore }, 'Episode outcome applied to memories');
    return affected;
  }

  /**
   * Promote high-usage memories from 'experience' to 'project' category.
   */
  promoteByUsage(threshold = 5): number {
    const rows = this.db.prepare<unknown[], Record<string, unknown>>(
      `SELECT id FROM categorized_memory
       WHERE category = 'experience' AND state = 'active' AND access_count >= ?`
    ).all(threshold) as Record<string, unknown>[];

    let promoted = 0;
    for (const row of rows) {
      this.db.prepare<unknown[]>(
        `UPDATE categorized_memory SET category = 'project', updated_at = ? WHERE id = ?`
      ).run(Date.now(), String(row.id));
      promoted++;
    }

    this.stats.promotions += promoted;
    if (promoted > 0) {
      log.info({ promoted, threshold }, 'Memories promoted from experience to project');
    }
    return promoted;
  }

  /**
   * Re-rank search results using importance scoring.
   * Called by CategorizedMemoryStore.search() when knowledge flow is wired.
   */
  influenceRetrieval(results: Array<{ id: string; content: string; score: number; strength: number; accessCount: number; source: string }>): RerankedResult[] {
    if (!this.importanceScorer) {
      return results.map(r => ({
        id: r.id, content: r.content,
        originalScore: r.score, importanceScore: r.strength, finalScore: r.score,
      }));
    }

    this.stats.rerankedQueries++;

    const reranked = results.map(r => {
      const importance = this.importanceScorer!.computeImportance({
        id: r.id, strength: r.strength,
        accessCount: r.accessCount, source: r.source,
      });

      // Blend: 60% original relevance + 40% importance
      const finalScore = r.score * 0.6 + importance.overall * 0.4;

      return {
        id: r.id, content: r.content,
        originalScore: r.score,
        importanceScore: importance.overall,
        finalScore,
      };
    });

    return reranked.sort((a, b) => b.finalScore - a.finalScore);
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      ...this.stats,
      hasLearningEngine: this.learningEngine !== null,
      hasEpisodeStore: this.episodeStore !== null,
      hasImportanceScorer: this.importanceScorer !== null,
    };
  }

  // ── Private helpers ──────────────────────────────────────────────────

  private reinforceMemory(memoryId: string, boost: number): void {
    try {
      // Apply reinforcement: strength += boost * (1 - strength) to approach 1.0
      // Core memories are already at 1.0 so this is a no-op for them
      this.db.prepare<unknown[]>(
        `UPDATE categorized_memory
         SET strength = MIN(1.0, strength + ? * (1.0 - strength)),
             access_count = access_count + 1,
             accessed_at = ?,
             updated_at = ?
         WHERE id = ?`
      ).run(boost, Date.now(), Date.now(), memoryId);
    } catch {
      // Memory may not exist in categorized_memory
    }
  }

  /**
   * Soft-decay a memory's strength after failure.
   * Never drops below 0.1, never touches core memories.
   */
  private penalizeMemory(memoryId: string, penalty: number): void {
    try {
      this.db.prepare<unknown[]>(
        `UPDATE categorized_memory
         SET strength = MAX(0.1, strength - ?),
             updated_at = ?
         WHERE id = ? AND (core IS NULL OR core = 0)`
      ).run(penalty, Date.now(), memoryId);
    } catch {
      // Memory may not exist
    }
  }

  /**
   * Recalculate importance for a memory using ImportanceScorer.
   */
  private recalculateImportance(memoryId: string): void {
    if (!this.importanceScorer) return;
    try {
      const row = this.db.prepare<unknown[], Record<string, unknown>>(
        `SELECT id, strength, access_count, source FROM categorized_memory WHERE id = ?`
      ).get(memoryId) as Record<string, unknown> | undefined;

      if (row) {
        this.importanceScorer.computeImportance({
          id: String(row.id),
          strength: Number(row.strength ?? 0),
          access_count: Number(row.access_count ?? 0),
          source: row.source ? String(row.source) : undefined,
        });
      }
    } catch {
      // Table or row may not exist
    }
  }

  private extractMemoryIds(input: string, output: string): string[] {
    // Look for memory IDs in signal text (format: mem_xxx or cm_xxx)
    const combined = `${input} ${output}`;
    const matches = combined.match(/\b(mem_\w+|cm_\w+)\b/g);
    return matches ? [...new Set(matches)] : [];
  }
}
