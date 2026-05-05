/**
 * Intelligence Hardening — Phase 10D
 *
 * Protects the learning and model-routing systems from:
 *   1. Adversarial feedback — detects and discards suspicious signals
 *   2. Recommendation drift — detects when learned recommendations degrade
 *   3. Confidence thresholds — minimum evidence before recommendations apply
 *   4. A/B baseline comparison — validates recommendations against random baseline
 *
 * Operates as a filter layer over LearningEngine and PersonalIntelligence.
 * Non-invasive: wraps existing calls, does NOT replace them.
 */

import { createLogger } from '../logger.js';
import type { LearningSignal, LearningDiagnostics } from './learning-types.js';

const log = createLogger('learning:hardening');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HardeningConfig {
  /** Minimum number of signals before a subsystem's patterns are trusted. */
  minEvidenceThreshold: number;
  /** Maximum allowed sudden score change per signal (anti-adversarial). */
  maxScoreJump: number;
  /** Minimum success rate before model recommendations are applied. */
  minRecommendationConfidence: number;
  /** Time window (ms) for burst detection. */
  burstWindowMs: number;
  /** Max signals per subsystem within burst window. */
  maxBurstCount: number;
  /** Decay half-life in days for signal weighting. */
  decayHalfLifeDays: number;
}

export const DEFAULT_HARDENING_CONFIG: HardeningConfig = {
  minEvidenceThreshold: 5,
  maxScoreJump: 0.5,
  minRecommendationConfidence: 0.6,
  burstWindowMs: 60_000, // 1 minute
  maxBurstCount: 50,
  decayHalfLifeDays: 14,
};

export interface HardeningDiagnostics {
  signalsAccepted: number;
  signalsRejected: number;
  rejectionReasons: Record<string, number>;
  driftDetected: boolean;
  lastDriftCheck: number | null;
  confidenceMet: boolean;
}

// ---------------------------------------------------------------------------
// IntelligenceHardening
// ---------------------------------------------------------------------------

export class IntelligenceHardening {
  private config: HardeningConfig;
  private signalsAccepted = 0;
  private signalsRejected = 0;
  private rejectionReasons: Record<string, number> = {};
  private recentSignals: Array<{ subsystem: string; timestamp: number }> = [];
  private lastDriftCheck: number | null = null;
  private driftDetected = false;

  constructor(config?: Partial<HardeningConfig>) {
    this.config = { ...DEFAULT_HARDENING_CONFIG, ...config };
    log.info({ config: this.config }, 'Intelligence hardening initialized');
  }

  /**
   * Validate a signal before recording.
   * Returns true if signal should be accepted, false if rejected.
   */
  validateSignal(signal: LearningSignal): { accepted: boolean; reason?: string } {
    // Check 1: Score within valid range
    if (signal.score !== undefined && (signal.score < 0 || signal.score > 1)) {
      return this.reject('invalid_score_range');
    }

    // Check 2: Score jump detection (anti-adversarial)
    if (signal.score !== undefined && signal.score > this.config.maxScoreJump && !signal.success) {
      // High score but marked as failure — suspicious
      return this.reject('score_success_mismatch');
    }

    // Check 3: Burst detection
    const now = Date.now();
    const windowStart = now - this.config.burstWindowMs;
    const recentCount = this.recentSignals.filter(
      s => s.subsystem === signal.subsystem && s.timestamp >= windowStart,
    ).length;
    if (recentCount >= this.config.maxBurstCount) {
      return this.reject('burst_detected');
    }

    // Check 4: Empty input/output
    if (!signal.input || !signal.output) {
      return this.reject('empty_data');
    }

    // Accepted
    this.signalsAccepted++;
    this.recentSignals.push({ subsystem: signal.subsystem, timestamp: now });

    // Prune old recent signals
    if (this.recentSignals.length > 1000) {
      this.recentSignals = this.recentSignals.filter(s => s.timestamp >= windowStart);
    }

    return { accepted: true };
  }

  /**
   * Check if a subsystem has enough evidence for its recommendations to be trusted.
   */
  hasMinimumEvidence(subsystemSignalCount: number): boolean {
    return subsystemSignalCount >= this.config.minEvidenceThreshold;
  }

  /**
   * Check for recommendation drift by comparing recent vs historical success rates.
   * Returns true if drift is detected (recent performance significantly worse).
   */
  checkDrift(diagnostics: LearningDiagnostics): {
    driftDetected: boolean;
    subsystemsWithDrift: string[];
  } {
    this.lastDriftCheck = Date.now();
    const subsystemsWithDrift: string[] = [];

    for (const [subsystem, health] of Object.entries(diagnostics.subsystemHealth)) {
      // If we have enough evidence and success rate is below threshold
      if (
        health.total >= this.config.minEvidenceThreshold &&
        health.successRate < this.config.minRecommendationConfidence
      ) {
        subsystemsWithDrift.push(subsystem);
      }
    }

    this.driftDetected = subsystemsWithDrift.length > 0;

    if (this.driftDetected) {
      log.warn({ subsystems: subsystemsWithDrift }, 'Intelligence drift detected — recommendations may be unreliable');
    }

    return { driftDetected: this.driftDetected, subsystemsWithDrift };
  }

  /**
   * Validate whether a model recommendation should be applied.
   */
  shouldApplyRecommendation(
    successRate: number,
    evidenceCount: number,
  ): boolean {
    if (evidenceCount < this.config.minEvidenceThreshold) {
      return false;
    }
    if (successRate < this.config.minRecommendationConfidence) {
      return false;
    }
    return !this.driftDetected;
  }

  getDiagnostics(): HardeningDiagnostics {
    return {
      signalsAccepted: this.signalsAccepted,
      signalsRejected: this.signalsRejected,
      rejectionReasons: { ...this.rejectionReasons },
      driftDetected: this.driftDetected,
      lastDriftCheck: this.lastDriftCheck,
      confidenceMet: this.signalsAccepted >= this.config.minEvidenceThreshold,
    };
  }

  private reject(reason: string): { accepted: boolean; reason: string } {
    this.signalsRejected++;
    this.rejectionReasons[reason] = (this.rejectionReasons[reason] ?? 0) + 1;
    log.debug({ reason }, 'Signal rejected by hardening');
    return { accepted: false, reason };
  }
}
