/**
 * Autonomy Gate — Phase 12.1: Autonomy Activation
 *
 * Controls the escalation from "suggest only" to "supervised auto-apply"
 * for the self-improvement system.
 *
 * Three autonomy levels:
 *   1. SUGGEST_ONLY  — default, proposals are generated but never applied
 *   2. SUPERVISED    — proposals may be applied if approved by gate conditions
 *   3. AUTONOMOUS    — proposals auto-apply (future, not enabled in this phase)
 *
 * Gate conditions for SUPERVISED:
 *   - System must have N+ successful builds (stability evidence)
 *   - Learning engine must have M+ signals (learning maturity)
 *   - No active drift detected (hardening pass)
 *   - Explicit user opt-in via config/API
 *
 * SAFETY: AUTONOMOUS mode is architecturally wired but never auto-enabled.
 * Only SUGGEST_ONLY → SUPERVISED transition is supported in Phase 12.1.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('validation:autonomy-gate');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AutonomyLevel = 'SUGGEST_ONLY' | 'SUPERVISED' | 'AUTONOMOUS';

export interface AutonomyGateConfig {
  /** Current autonomy level. */
  level: AutonomyLevel;
  /** Minimum successful builds before SUPERVISED mode is allowed. */
  minSuccessfulBuilds: number;
  /** Minimum learning signals before SUPERVISED mode is allowed. */
  minLearningSignals: number;
  /** Whether user has explicitly opted in to supervised mode. */
  userOptIn: boolean;
}

export const DEFAULT_AUTONOMY_CONFIG: AutonomyGateConfig = {
  level: 'SUGGEST_ONLY',
  minSuccessfulBuilds: 10,
  minLearningSignals: 50,
  userOptIn: false,
};

export interface AutonomyGateDiagnostics {
  currentLevel: AutonomyLevel;
  userOptIn: boolean;
  readyForSupervised: boolean;
  blockers: string[];
  config: AutonomyGateConfig;
}

// ---------------------------------------------------------------------------
// AutonomyGate
// ---------------------------------------------------------------------------

export class AutonomyGate {
  private config: AutonomyGateConfig;
  private dataDir: string;

  constructor(dataDir: string, config?: Partial<AutonomyGateConfig>) {
    this.dataDir = dataDir;
    this.config = { ...DEFAULT_AUTONOMY_CONFIG, ...config };
    this.loadState();
    log.info({ level: this.config.level, userOptIn: this.config.userOptIn }, 'Autonomy gate initialized');
  }

  /**
   * Get current autonomy level.
   */
  getLevel(): AutonomyLevel {
    return this.config.level;
  }

  /**
   * Check if the system meets conditions for SUPERVISED mode.
   */
  checkReadiness(context: {
    successfulBuilds: number;
    learningSignals: number;
    driftDetected: boolean;
  }): { ready: boolean; blockers: string[] } {
    const blockers: string[] = [];

    if (!this.config.userOptIn) {
      blockers.push('User has not opted in to supervised autonomy');
    }
    if (context.successfulBuilds < this.config.minSuccessfulBuilds) {
      blockers.push(`Need ${this.config.minSuccessfulBuilds} successful builds, have ${context.successfulBuilds}`);
    }
    if (context.learningSignals < this.config.minLearningSignals) {
      blockers.push(`Need ${this.config.minLearningSignals} learning signals, have ${context.learningSignals}`);
    }
    if (context.driftDetected) {
      blockers.push('Intelligence drift detected — cannot activate supervised mode');
    }

    return { ready: blockers.length === 0, blockers };
  }

  /**
   * Attempt to escalate to SUPERVISED mode.
   * Returns true if escalation succeeded, false if blocked.
   */
  escalateToSupervised(context: {
    successfulBuilds: number;
    learningSignals: number;
    driftDetected: boolean;
  }): { escalated: boolean; blockers: string[] } {
    const { ready, blockers } = this.checkReadiness(context);

    if (!ready) {
      log.info({ blockers }, 'Autonomy escalation blocked');
      return { escalated: false, blockers };
    }

    this.config.level = 'SUPERVISED';
    this.saveState();
    log.info('Autonomy escalated to SUPERVISED mode');
    return { escalated: true, blockers: [] };
  }

  /**
   * Set user opt-in for supervised mode.
   */
  setUserOptIn(optIn: boolean): void {
    this.config.userOptIn = optIn;
    this.saveState();
    log.info({ optIn }, 'User opt-in updated');
  }

  /**
   * Reset to SUGGEST_ONLY (safety fallback).
   */
  resetToSuggestOnly(): void {
    this.config.level = 'SUGGEST_ONLY';
    this.config.userOptIn = false;
    this.saveState();
    log.info('Autonomy reset to SUGGEST_ONLY');
  }

  /**
   * Check if a proposal should be auto-applied under current autonomy level.
   */
  shouldAutoApply(proposalConfidence: number): boolean {
    if (this.config.level === 'SUGGEST_ONLY') return false;
    if (this.config.level === 'SUPERVISED') return proposalConfidence >= 0.8;
    // AUTONOMOUS level — not enabled in Phase 12.1
    return false;
  }

  getDiagnostics(): AutonomyGateDiagnostics {
    return {
      currentLevel: this.config.level,
      userOptIn: this.config.userOptIn,
      readyForSupervised: false, // Requires runtime context
      blockers: [],
      config: { ...this.config },
    };
  }

  // -----------------------------------------------------------------------
  // Persistence
  // -----------------------------------------------------------------------

  private loadState(): void {
    try {
      const statePath = path.join(this.dataDir, 'autonomy-gate.json');
      if (fs.existsSync(statePath)) {
        const saved = JSON.parse(fs.readFileSync(statePath, 'utf-8'));
        this.config = { ...DEFAULT_AUTONOMY_CONFIG, ...saved };
      }
    } catch {
      // Start with defaults
    }
  }

  private saveState(): void {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const statePath = path.join(this.dataDir, 'autonomy-gate.json');
      fs.writeFileSync(statePath + '.tmp', JSON.stringify(this.config, null, 2));
      fs.renameSync(statePath + '.tmp', statePath);
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to save autonomy gate state');
    }
  }
}
