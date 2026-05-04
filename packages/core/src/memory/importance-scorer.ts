/**
 * Multi-Factor Importance Scorer — Replaces simple strength with explainable scoring
 *
 * Dimensions:
 *   base           — maps from existing strength (backward compat)
 *   impact         — how often this memory appeared in successful episodes
 *   reliability    — 1.0 minus contradiction/negative feedback ratio
 *   utility        — normalized access count
 *   userConfirmed  — 1.0 if user-taught, else 0.5
 *   learningBoost  — accumulated learning signal boosts
 *
 * Core memories: never decay, base=1.0, protected from archival.
 */

import { createLogger } from '../logger.js';
import type { SqliteMemoryDb } from '../db/sqlite-memory.js';
import type { EpisodeStore } from './episodic-memory.js';

const log = createLogger('memory:importance');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ImportanceScore {
  base: number;
  impact: number;
  reliability: number;
  utility: number;
  userConfirmed: number;
  learningBoost: number;
  overall: number;
}

export interface ImportanceWeights {
  base: number;
  impact: number;
  reliability: number;
  utility: number;
  userConfirmed: number;
  learningBoost: number;
}

const DEFAULT_WEIGHTS: ImportanceWeights = {
  base: 0.15,
  impact: 0.25,
  reliability: 0.15,
  utility: 0.20,
  userConfirmed: 0.10,
  learningBoost: 0.15,
};

// ---------------------------------------------------------------------------
// ImportanceScorer
// ---------------------------------------------------------------------------

export class ImportanceScorer {
  private db: SqliteMemoryDb;
  private episodeStore: EpisodeStore | null;
  private weights: ImportanceWeights;

  constructor(db: SqliteMemoryDb, episodeStore?: EpisodeStore, weights?: Partial<ImportanceWeights>) {
    this.db = db;
    this.episodeStore = episodeStore ?? null;
    this.weights = { ...DEFAULT_WEIGHTS, ...weights };
    this.ensureColumns();
  }

  /** Maximum number of core memories allowed. Prevents uncontrolled growth. */
  private static CORE_CAP = 100;

  private ensureColumns(): void {
    // Ensure core and importance_json columns exist
    try { this.db.exec('ALTER TABLE categorized_memory ADD COLUMN core INTEGER DEFAULT 0'); } catch { /* exists */ }
    try { this.db.exec('ALTER TABLE categorized_memory ADD COLUMN importance_json TEXT'); } catch { /* exists */ }
    // Core governance metadata columns
    try { this.db.exec('ALTER TABLE categorized_memory ADD COLUMN core_reason TEXT'); } catch { /* exists */ }
    try { this.db.exec('ALTER TABLE categorized_memory ADD COLUMN core_assigned_at INTEGER'); } catch { /* exists */ }
    try { this.db.exec('ALTER TABLE categorized_memory ADD COLUMN core_assigned_by TEXT'); } catch { /* exists */ }
    try { this.db.exec('ALTER TABLE categorized_memory ADD COLUMN core_review_status TEXT DEFAULT \'active\''); } catch { /* exists */ }
  }

  /**
   * Compute multi-factor importance for a memory.
   * Accepts a memory row from categorized_memory.
   */
  computeImportance(memory: {
    id: string;
    strength: number;
    access_count?: number;
    accessCount?: number;
    source?: string;
  }): ImportanceScore {
    const base = Math.max(0, Math.min(1, memory.strength));
    const impact = this.computeImpact(memory.id);
    const reliability = this.computeReliability(memory.id);
    const accessCount = memory.access_count ?? memory.accessCount ?? 0;
    const utility = this.computeUtility(accessCount);
    const userConfirmed = (memory.source === 'user_teaching' || memory.source === 'teach') ? 1.0 : 0.5;
    const learningBoost = this.computeLearningBoost(memory.id);

    const w = this.weights;
    const overall = Math.min(1,
      base * w.base +
      impact * w.impact +
      reliability * w.reliability +
      utility * w.utility +
      userConfirmed * w.userConfirmed +
      learningBoost * w.learningBoost
    );

    const score: ImportanceScore = { base, impact, reliability, utility, userConfirmed, learningBoost, overall };

    // Persist to importance_json
    try {
      this.db.prepare<unknown[]>(
        `UPDATE categorized_memory SET importance_json = ? WHERE id = ?`
      ).run(JSON.stringify(score), memory.id);
    } catch {
      // Column may not exist yet
    }

    return score;
  }

  /**
   * Mark a memory as core — it never decays, base importance = 1.0.
   * Requires reason and assignedBy for governance auditability.
   * Enforces a cap on total core memories to prevent uncontrolled growth.
   */
  markAsCore(memoryId: string, reason?: string, assignedBy?: string): void {
    const coreReason = reason ?? 'unspecified';
    const coreAssignedBy = assignedBy ?? 'system';

    // Enforce core cap
    const countRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM categorized_memory WHERE core = 1`
    ).get() as Record<string, unknown> | undefined;
    const currentCoreCount = Number(countRow?.cnt ?? 0);

    // Check if already core (re-marking is allowed)
    const existing = this.db.prepare(
      `SELECT core FROM categorized_memory WHERE id = ?`
    ).get(memoryId) as Record<string, unknown> | undefined;
    const alreadyCore = Boolean(existing?.core);

    if (!alreadyCore && currentCoreCount >= ImportanceScorer.CORE_CAP) {
      throw new Error(`Core memory cap reached (${ImportanceScorer.CORE_CAP}). Unmark existing core memories first.`);
    }

    this.db.prepare<unknown[]>(
      `UPDATE categorized_memory SET core = 1, strength = 1.0, core_reason = ?, core_assigned_at = ?, core_assigned_by = ?, core_review_status = 'active' WHERE id = ?`
    ).run(coreReason, Date.now(), coreAssignedBy, memoryId);

    log.info({ memoryId, reason: coreReason, assignedBy: coreAssignedBy }, 'Memory marked as CORE — will never decay');
  }

  /**
   * Unmark a core memory — returns it to normal lifecycle.
   * Strength is preserved but decay and penalties can now apply.
   */
  unmarkCore(memoryId: string): void {
    this.db.prepare<unknown[]>(
      `UPDATE categorized_memory SET core = 0, core_reason = NULL, core_assigned_at = NULL, core_assigned_by = NULL, core_review_status = NULL WHERE id = ?`
    ).run(memoryId);

    log.info({ memoryId }, 'Memory unmarked from CORE — normal lifecycle resumed');
  }

  /**
   * Flag stale core memories for review.
   * Core memories not accessed for more than staleDays are flagged.
   */
  flagStaleCoreMemories(staleDays = 30): number {
    const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;

    const result = this.db.prepare<unknown[]>(
      `UPDATE categorized_memory SET core_review_status = 'review_required' WHERE core = 1 AND accessed_at < ? AND core_review_status = 'active'`
    ).run(cutoff);

    const flagged = (result as { changes: number }).changes;
    if (flagged > 0) {
      log.info({ flagged, staleDays }, 'Stale core memories flagged for review');
    }
    return flagged;
  }

  /**
   * Check if a memory is marked as core.
   */
  isCore(memoryId: string): boolean {
    const row = this.db.prepare(
      `SELECT core FROM categorized_memory WHERE id = ?`
    ).get(memoryId) as Record<string, unknown> | undefined;

    return Boolean(row?.core);
  }

  /**
   * List all core memories with full governance metadata.
   */
  listCore(limit = 50): Array<{
    id: string; content: string; category: string; strength: number;
    coreReason: string | null; coreAssignedBy: string | null; coreAssignedAt: number | null;
    coreReviewStatus: string | null; accessedAt: number; projectId: string | null;
  }> {
    const rows = this.db.prepare(
      `SELECT id, content, category, strength, core_reason, core_assigned_by, core_assigned_at, core_review_status, accessed_at, project_id FROM categorized_memory WHERE core = 1 ORDER BY core_assigned_at DESC LIMIT ?`
    ).all(limit) as Record<string, unknown>[];

    return rows.map(r => ({
      id: String(r.id),
      content: String(r.content),
      category: String(r.category),
      strength: Number(r.strength ?? 0),
      coreReason: r.core_reason ? String(r.core_reason) : null,
      coreAssignedBy: r.core_assigned_by ? String(r.core_assigned_by) : null,
      coreAssignedAt: r.core_assigned_at ? Number(r.core_assigned_at) : null,
      coreReviewStatus: r.core_review_status ? String(r.core_review_status) : null,
      accessedAt: Number(r.accessed_at ?? 0),
      projectId: r.project_id ? String(r.project_id) : null,
    }));
  }

  /**
   * Get core memories requiring review.
   */
  listCoreForReview(): Array<{ id: string; content: string; coreReason: string | null; accessedAt: number }> {
    const rows = this.db.prepare(
      `SELECT id, content, core_reason, accessed_at FROM categorized_memory WHERE core = 1 AND core_review_status = 'review_required' ORDER BY accessed_at ASC`
    ).all() as Record<string, unknown>[];

    return rows.map(r => ({
      id: String(r.id),
      content: String(r.content),
      coreReason: r.core_reason ? String(r.core_reason) : null,
      accessedAt: Number(r.accessed_at ?? 0),
    }));
  }

  /**
   * Human-readable explanation of importance scoring.
   */
  explainScore(memoryId: string): string {
    const row = this.db.prepare(
      `SELECT id, content, strength, access_count, source, core, importance_json FROM categorized_memory WHERE id = ?`
    ).get(memoryId) as Record<string, unknown> | undefined;

    if (!row) return `Memory '${memoryId}' not found.`;

    const score = this.computeImportance({
      id: String(row.id),
      strength: Number(row.strength ?? 0),
      access_count: Number(row.access_count ?? 0),
      source: row.source ? String(row.source) : undefined,
    });

    const isCore = Boolean(row.core);
    const w = this.weights;

    return [
      `Memory: ${memoryId}`,
      `Core: ${isCore ? 'YES (never decays)' : 'no'}`,
      `Overall importance: ${score.overall.toFixed(3)}`,
      '',
      `Dimensions:`,
      `  base:          ${score.base.toFixed(3)} (weight: ${w.base})`,
      `  impact:        ${score.impact.toFixed(3)} (weight: ${w.impact})`,
      `  reliability:   ${score.reliability.toFixed(3)} (weight: ${w.reliability})`,
      `  utility:       ${score.utility.toFixed(3)} (weight: ${w.utility})`,
      `  userConfirmed: ${score.userConfirmed.toFixed(3)} (weight: ${w.userConfirmed})`,
      `  learningBoost: ${score.learningBoost.toFixed(3)} (weight: ${w.learningBoost})`,
    ].join('\n');
  }

  getDiagnostics(): Record<string, unknown> {
    const totalRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM categorized_memory`
    ).get() as Record<string, unknown> | undefined;

    const coreRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM categorized_memory WHERE core = 1`
    ).get() as Record<string, unknown> | undefined;

    const scoredRow = this.db.prepare(
      `SELECT COUNT(*) as cnt FROM categorized_memory WHERE importance_json IS NOT NULL`
    ).get() as Record<string, unknown> | undefined;

    let reviewRequired = 0;
    try {
      const reviewRow = this.db.prepare(
        `SELECT COUNT(*) as cnt FROM categorized_memory WHERE core = 1 AND core_review_status = 'review_required'`
      ).get() as Record<string, unknown> | undefined;
      reviewRequired = Number(reviewRow?.cnt ?? 0);
    } catch { /* column may not exist */ }

    const coreMemories = this.listCore();

    return {
      totalMemories: Number(totalRow?.cnt ?? 0),
      coreMemories: Number(coreRow?.cnt ?? 0),
      coreCap: ImportanceScorer.CORE_CAP,
      coreReviewRequired: reviewRequired,
      coreMemoryList: coreMemories.map(c => ({
        id: c.id,
        category: c.category,
        strength: c.strength,
        reason: c.coreReason,
        assignedBy: c.coreAssignedBy,
        reviewStatus: c.coreReviewStatus,
        lastAccessed: c.accessedAt ? new Date(c.accessedAt).toISOString() : null,
      })),
      scoredMemories: Number(scoredRow?.cnt ?? 0),
      weights: this.weights,
    };
  }

  // ── Private dimension computations ────────────────────────────────────

  private computeImpact(memoryId: string): number {
    if (!this.episodeStore) return 0.5; // Neutral if no episode store

    try {
      const episodes = this.episodeStore.getEpisodesForMemory(memoryId);
      if (episodes.length === 0) return 0.3;

      const successfulEpisodes = episodes.filter(e => e.outcomeScore !== undefined && e.outcomeScore > 0.5);
      return Math.min(1, successfulEpisodes.length / Math.max(1, episodes.length));
    } catch {
      return 0.5;
    }
  }

  private computeReliability(memoryId: string): number {
    try {
      const row = this.db.prepare(
        `SELECT
          COUNT(*) as total,
          SUM(CASE WHEN signal_type = 'negative_feedback' THEN 1 ELSE 0 END) as negatives
        FROM learning_signals WHERE document_id = ? OR entity_id = ?`
      ).get(memoryId, memoryId) as Record<string, unknown> | undefined;

      const total = Number(row?.total ?? 0);
      const negatives = Number(row?.negatives ?? 0);

      if (total === 0) return 0.8; // No feedback → assume reliable
      return Math.max(0.1, 1.0 - (negatives / total));
    } catch {
      return 0.8; // learning_signals table may not exist
    }
  }

  private computeUtility(accessCount: number): number {
    // Logarithmic scaling: 0 → 0.1, 1 → 0.3, 5 → 0.6, 20 → 0.8, 100 → 1.0
    if (accessCount <= 0) return 0.1;
    return Math.min(1, 0.1 + Math.log10(accessCount + 1) * 0.45);
  }

  private computeLearningBoost(memoryId: string): number {
    try {
      const row = this.db.prepare(
        `SELECT SUM(boost_score) as total_boost FROM learned_boosts WHERE document_id = ?`
      ).get(memoryId) as Record<string, unknown> | undefined;

      const boost = Number(row?.total_boost ?? 0);
      // Normalize: 0-5 → 0-1
      return Math.min(1, boost / 5);
    } catch {
      return 0; // learned_boosts table may not exist
    }
  }
}
