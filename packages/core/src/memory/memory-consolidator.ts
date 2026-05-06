/**
 * Memory Consolidator — Lifelong Memory Core
 *
 * Background job that:
 * 1. Finds near-duplicate memories (exact hash + trigram Jaccard)
 * 2. Merges duplicates into a single consolidated memory
 * 3. Runs strength decay on stale memories
 * 4. Auto-archives memories below archive threshold
 *
 * All actions are non-destructive and auditable via EventBus.
 */

import { createLogger } from '../logger.js';
import type {
  CategorizedMemoryStore,
  MemoryEventBus,
} from './categorized-memory.js';
import {
  type MemoryPolicy,
  DEFAULT_MEMORY_POLICY,
  contentHash,
  jaccardTrigramSimilarity,
} from './memory-policies.js';

const log = createLogger('memory:consolidator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConsolidationReport {
  duplicatesFound: number;
  memoriesMerged: number;
  memoriesDecayed: number;
  memoriesArchived: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// MemoryConsolidator
// ---------------------------------------------------------------------------

export class MemoryConsolidator {
  private store: CategorizedMemoryStore;
  private eventBus?: MemoryEventBus;
  private policy: MemoryPolicy;
  private lastRunReport?: ConsolidationReport;
  private totalRunCount = 0;
  private knowledgeFlow: { processSignals: (limit?: number) => number; promoteByUsage: (threshold?: number) => number } | null = null;

  constructor(
    store: CategorizedMemoryStore,
    deps?: { eventBus?: MemoryEventBus; policy?: MemoryPolicy },
  ) {
    this.store = store;
    this.eventBus = deps?.eventBus;
    this.policy = deps?.policy ?? DEFAULT_MEMORY_POLICY;
    log.info('MemoryConsolidator initialized');
  }

  setKnowledgeFlow(flow: { processSignals: (limit?: number) => number; promoteByUsage: (threshold?: number) => number }): void {
    this.knowledgeFlow = flow;
  }

  // -----------------------------------------------------------------------
  // Full consolidation pass
  // -----------------------------------------------------------------------

  run(): ConsolidationReport {
    const startTime = Date.now();
    log.info('Starting consolidation pass');

    // 1. Find and merge duplicates
    const duplicateGroups = this.findDuplicates();
    let memoriesMerged = 0;

    for (const group of duplicateGroups) {
      const merged = this.merge(group.ids);
      if (merged) memoriesMerged++;
    }

    // 2. Knowledge flow: process learning signals + promote by usage
    if (this.knowledgeFlow) {
      try {
        this.knowledgeFlow.processSignals(50);
        this.knowledgeFlow.promoteByUsage();
      } catch (e) {
        log.warn({ error: e }, 'Knowledge flow processing failed');
      }
    }

    // 3. Run decay
    const memoriesDecayed = this.runDecay();

    // 3. Count auto-archived (decay handles this internally)
    const stats = this.store.getStats();

    const report: ConsolidationReport = {
      duplicatesFound: duplicateGroups.length,
      memoriesMerged,
      memoriesDecayed,
      memoriesArchived: stats.byState.archived,
      durationMs: Date.now() - startTime,
    };

    this.lastRunReport = report;
    this.totalRunCount++;

    log.info(report, 'Consolidation pass completed');
    return report;
  }

  // -----------------------------------------------------------------------
  // Duplicate detection
  // -----------------------------------------------------------------------

  findDuplicates(threshold?: number): Array<{ ids: string[]; similarity: number }> {
    const similarityThreshold = threshold ?? 0.7;
    const memories = this.store.getAllActive(500);

    if (memories.length < 2) return [];

    // Group by content hash first (exact duplicates)
    const hashGroups = new Map<string, string[]>();
    for (const mem of memories) {
      const hash = contentHash(mem.content);
      const group = hashGroups.get(hash) ?? [];
      group.push(mem.id);
      hashGroups.set(hash, group);
    }

    const duplicateGroups: Array<{ ids: string[]; similarity: number }> = [];

    // Exact duplicates
    for (const [, ids] of hashGroups) {
      if (ids.length > 1) {
        duplicateGroups.push({ ids, similarity: 1.0 });
      }
    }

    // Near-duplicates by trigram Jaccard (only between different hash groups)
    const uniqueMemories = memories.filter((mem, idx) => {
      const hash = contentHash(mem.content);
      const group = hashGroups.get(hash)!;
      return group[0] === mem.id; // Keep only first of each hash group
    });

    const alreadyMerged = new Set<string>();

    for (let i = 0; i < uniqueMemories.length; i++) {
      if (alreadyMerged.has(uniqueMemories[i].id)) continue;

      const nearGroup: string[] = [uniqueMemories[i].id];

      for (let j = i + 1; j < uniqueMemories.length; j++) {
        if (alreadyMerged.has(uniqueMemories[j].id)) continue;

        const similarity = jaccardTrigramSimilarity(
          uniqueMemories[i].content,
          uniqueMemories[j].content,
        );

        if (similarity >= similarityThreshold) {
          nearGroup.push(uniqueMemories[j].id);
          alreadyMerged.add(uniqueMemories[j].id);
        }
      }

      if (nearGroup.length > 1) {
        const avgSim = jaccardTrigramSimilarity(
          uniqueMemories[i].content,
          this.store.getById(nearGroup[1])?.content ?? '',
        );
        duplicateGroups.push({
          ids: nearGroup,
          similarity: avgSim,
        });
        alreadyMerged.add(uniqueMemories[i].id);
      }
    }

    log.info({ duplicateGroups: duplicateGroups.length }, 'Duplicate detection completed');
    return duplicateGroups;
  }

  // -----------------------------------------------------------------------
  // Merge
  // -----------------------------------------------------------------------

  merge(ids: string[]): string | null {
    if (ids.length < 2) return null;

    try {
      // Get all memories
      const memories = ids
        .map(id => this.store.getById(id))
        .filter((m): m is NonNullable<typeof m> => m != null);

      if (memories.length < 2) return null;

      // Build merged content — use the longest content as the base
      const sorted = [...memories].sort((a, b) => b.content.length - a.content.length);
      const mergedContent = sorted[0].content;

      // Consolidate
      const mergedId = this.store.consolidate(ids, mergedContent);

      log.info({ mergedId, originalCount: ids.length }, 'Memories merged');
      return mergedId;
    } catch (error) {
      log.warn({ ids, error }, 'Failed to merge memories');
      return null;
    }
  }

  // -----------------------------------------------------------------------
  // Decay
  // -----------------------------------------------------------------------

  runDecay(maxAgeDays?: number): number {
    if (!this.policy.decay.enabled) {
      log.debug('Decay disabled by policy');
      return 0;
    }

    return this.store.decay(maxAgeDays);
  }

  // -----------------------------------------------------------------------
  // Diagnostics
  // -----------------------------------------------------------------------

  getDiagnostics(): Record<string, unknown> {
    return {
      totalRuns: this.totalRunCount,
      lastRunReport: this.lastRunReport ?? null,
      decayEnabled: this.policy.decay.enabled,
      decayHalfLifeDays: this.policy.decay.halfLifeDays,
      archiveThreshold: this.policy.decay.minStrengthBeforeArchive,
      hasEventBus: !!this.eventBus,
    };
  }
}
