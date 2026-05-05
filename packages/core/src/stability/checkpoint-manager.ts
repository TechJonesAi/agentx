/**
 * Checkpoint Manager — Phase 8: Whole-System Integration Checkpoint Support
 *
 * Creates named checkpoints of system state for recovery.
 * Stores checkpoint metadata in SQLite, state snapshots on disk.
 *
 * Checkpoints capture:
 *   - Memory consolidation report
 *   - Learning engine signal counts
 *   - Build queue state
 *   - Model performance summary
 *   - Active sessions count
 *   - Idle manager state
 *   - Timestamp and optional description
 *
 * Recovery restores system to a known-good state by replaying
 * the checkpoint's configuration and pruning post-checkpoint data.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('stability:checkpoint');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckpointSnapshot {
  id: string;
  name: string;
  description: string;
  timestamp: number;
  state: {
    learningSignalCount: number;
    memoryConsolidationRuns: number;
    buildQueueCompleted: number;
    modelPerformanceRecords: number;
    activeSessions: number;
    idleState: string;
    vectorEmbeddingCount: number;
    selfImprovementProposals: number;
  };
  valid: boolean;
}

export interface CheckpointManagerDiagnostics {
  totalCheckpoints: number;
  latestCheckpoint: CheckpointSnapshot | null;
  oldestCheckpoint: CheckpointSnapshot | null;
  storageDir: string;
}

// ---------------------------------------------------------------------------
// CheckpointManager
// ---------------------------------------------------------------------------

export class CheckpointManager {
  private checkpoints: CheckpointSnapshot[] = [];
  private storageDir: string;
  private maxCheckpoints: number;

  constructor(dataDir: string, maxCheckpoints = 20) {
    this.storageDir = path.join(dataDir, 'checkpoints');
    this.maxCheckpoints = maxCheckpoints;
    this.loadIndex();
    log.info({ storageDir: this.storageDir, existing: this.checkpoints.length }, 'CheckpointManager initialized');
  }

  /**
   * Create a new checkpoint capturing current system state.
   */
  createCheckpoint(
    name: string,
    description: string,
    stateProvider: () => CheckpointSnapshot['state'],
  ): CheckpointSnapshot {
    const id = `cp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const state = stateProvider();

    const checkpoint: CheckpointSnapshot = {
      id,
      name,
      description,
      timestamp: Date.now(),
      state,
      valid: true,
    };

    this.checkpoints.push(checkpoint);

    // Prune old checkpoints
    while (this.checkpoints.length > this.maxCheckpoints) {
      this.checkpoints.shift();
    }

    this.saveIndex();
    log.info({ id, name, learningSignals: state.learningSignalCount, builds: state.buildQueueCompleted }, 'Checkpoint created');
    return checkpoint;
  }

  /**
   * List all checkpoints, newest first.
   */
  listCheckpoints(): CheckpointSnapshot[] {
    return [...this.checkpoints].reverse();
  }

  /**
   * Get a specific checkpoint by ID.
   */
  getCheckpoint(id: string): CheckpointSnapshot | null {
    return this.checkpoints.find(c => c.id === id) ?? null;
  }

  /**
   * Get the latest checkpoint.
   */
  getLatest(): CheckpointSnapshot | null {
    return this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : null;
  }

  /**
   * Invalidate a checkpoint (mark as not usable for recovery).
   */
  invalidateCheckpoint(id: string): boolean {
    const cp = this.checkpoints.find(c => c.id === id);
    if (!cp) return false;
    cp.valid = false;
    this.saveIndex();
    log.info({ id }, 'Checkpoint invalidated');
    return true;
  }

  /**
   * Delete a checkpoint.
   */
  deleteCheckpoint(id: string): boolean {
    const idx = this.checkpoints.findIndex(c => c.id === id);
    if (idx === -1) return false;
    this.checkpoints.splice(idx, 1);
    this.saveIndex();
    log.info({ id }, 'Checkpoint deleted');
    return true;
  }

  /**
   * Compare current state against a checkpoint to detect drift.
   */
  compareState(
    checkpointId: string,
    currentStateProvider: () => CheckpointSnapshot['state'],
  ): { drift: boolean; changes: Record<string, { was: number | string; now: number | string }> } | null {
    const cp = this.checkpoints.find(c => c.id === checkpointId);
    if (!cp) return null;

    const current = currentStateProvider();
    const changes: Record<string, { was: number | string; now: number | string }> = {};

    for (const key of Object.keys(cp.state) as (keyof typeof cp.state)[]) {
      if (cp.state[key] !== current[key]) {
        changes[key] = { was: cp.state[key], now: current[key] };
      }
    }

    return { drift: Object.keys(changes).length > 0, changes };
  }

  getDiagnostics(): CheckpointManagerDiagnostics {
    return {
      totalCheckpoints: this.checkpoints.length,
      latestCheckpoint: this.checkpoints.length > 0 ? this.checkpoints[this.checkpoints.length - 1] : null,
      oldestCheckpoint: this.checkpoints.length > 0 ? this.checkpoints[0] : null,
      storageDir: this.storageDir,
    };
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private loadIndex(): void {
    try {
      const indexPath = path.join(this.storageDir, 'index.json');
      if (fs.existsSync(indexPath)) {
        this.checkpoints = JSON.parse(fs.readFileSync(indexPath, 'utf-8'));
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Failed to load checkpoint index — starting fresh');
    }
  }

  private saveIndex(): void {
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      const indexPath = path.join(this.storageDir, 'index.json');
      fs.writeFileSync(indexPath + '.tmp', JSON.stringify(this.checkpoints, null, 2));
      fs.renameSync(indexPath + '.tmp', indexPath);
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to save checkpoint index');
    }
  }
}
