/**
 * Adaptive Status — Central registry for all adaptive intelligence state.
 *
 * P6-12: Provides a unified view of what AgentX is learning, what has been
 * auto-applied, and what is waiting for user approval.
 *
 * Classification:
 *   ACTIVE    — influencing runtime decisions
 *   PASSIVE   — collecting data only
 *   DISCONNECTED — implemented but not wired
 *   MISSING   — not implemented
 */

import { createLogger } from '../logger.js';

const log = createLogger('learning:adaptive-status');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SubsystemStatus = 'ACTIVE' | 'PASSIVE' | 'DISCONNECTED' | 'MISSING';

export interface AdaptiveSubsystem {
  name: string;
  status: SubsystemStatus;
  description: string;
  /** Whether it auto-applies changes without user approval */
  autoApplies: boolean;
  /** Whether changes require user approval */
  requiresApproval: boolean;
  /** Recent decisions or adaptations made */
  recentDecisions: AdaptiveDecision[];
  /** Current metrics */
  metrics: Record<string, unknown>;
}

export interface AdaptiveDecision {
  id: string;
  subsystem: string;
  type: 'auto_applied' | 'pending_approval' | 'approved' | 'rejected';
  description: string;
  impact: 'low' | 'medium' | 'high';
  timestamp: number;
  details?: Record<string, unknown>;
}

export interface PendingAdaptation {
  id: string;
  subsystem: string;
  description: string;
  impact: 'low' | 'medium' | 'high';
  confidence: number;
  proposedAt: number;
  details: Record<string, unknown>;
}

export interface AdaptiveStatusReport {
  subsystems: AdaptiveSubsystem[];
  pendingApprovals: PendingAdaptation[];
  recentAutoApplied: AdaptiveDecision[];
  summary: {
    activeCount: number;
    passiveCount: number;
    disconnectedCount: number;
    pendingCount: number;
    autoAppliedCount: number;
    autonomyLevel: string;
  };
}

// ---------------------------------------------------------------------------
// AdaptiveStatusService
// ---------------------------------------------------------------------------

export class AdaptiveStatusService {
  private decisions: AdaptiveDecision[] = [];
  private pendingAdaptations: PendingAdaptation[] = [];

  /**
   * Record an adaptive decision (auto-applied or pending).
   */
  recordDecision(decision: Omit<AdaptiveDecision, 'id'>): void {
    const id = `adapt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const full: AdaptiveDecision = { ...decision, id };
    this.decisions.push(full);

    // Keep bounded
    if (this.decisions.length > 200) {
      this.decisions = this.decisions.slice(-100);
    }

    log.debug({ id, subsystem: decision.subsystem, type: decision.type }, 'Adaptive decision recorded');
  }

  /**
   * Add a pending adaptation requiring user approval.
   */
  addPendingAdaptation(adaptation: Omit<PendingAdaptation, 'id'>): string {
    const id = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    this.pendingAdaptations.push({ ...adaptation, id });
    log.info({ id, subsystem: adaptation.subsystem, impact: adaptation.impact }, 'Pending adaptation added — requires approval');
    return id;
  }

  /**
   * Approve a pending adaptation.
   */
  approveAdaptation(id: string): boolean {
    const idx = this.pendingAdaptations.findIndex(p => p.id === id);
    if (idx === -1) return false;

    const adaptation = this.pendingAdaptations.splice(idx, 1)[0];
    this.recordDecision({
      subsystem: adaptation.subsystem,
      type: 'approved',
      description: adaptation.description,
      impact: adaptation.impact,
      timestamp: Date.now(),
      details: adaptation.details,
    });

    log.info({ id, subsystem: adaptation.subsystem }, 'Adaptation approved');
    return true;
  }

  /**
   * Reject a pending adaptation.
   */
  rejectAdaptation(id: string): boolean {
    const idx = this.pendingAdaptations.findIndex(p => p.id === id);
    if (idx === -1) return false;

    const adaptation = this.pendingAdaptations.splice(idx, 1)[0];
    this.recordDecision({
      subsystem: adaptation.subsystem,
      type: 'rejected',
      description: adaptation.description,
      impact: adaptation.impact,
      timestamp: Date.now(),
      details: adaptation.details,
    });

    log.info({ id, subsystem: adaptation.subsystem }, 'Adaptation rejected');
    return true;
  }

  /**
   * Get all pending adaptations.
   */
  getPendingAdaptations(): PendingAdaptation[] {
    return [...this.pendingAdaptations];
  }

  /**
   * Get recent auto-applied decisions.
   */
  getRecentAutoApplied(limit = 20): AdaptiveDecision[] {
    return this.decisions
      .filter(d => d.type === 'auto_applied')
      .slice(-limit);
  }

  /**
   * Get all recent decisions.
   */
  getRecentDecisions(limit = 50): AdaptiveDecision[] {
    return this.decisions.slice(-limit);
  }

  /**
   * Build the full adaptive status report.
   */
  buildReport(
    subsystems: AdaptiveSubsystem[],
    autonomyLevel: string,
  ): AdaptiveStatusReport {
    const autoApplied = this.getRecentAutoApplied();
    const pending = this.getPendingAdaptations();

    return {
      subsystems,
      pendingApprovals: pending,
      recentAutoApplied: autoApplied,
      summary: {
        activeCount: subsystems.filter(s => s.status === 'ACTIVE').length,
        passiveCount: subsystems.filter(s => s.status === 'PASSIVE').length,
        disconnectedCount: subsystems.filter(s => s.status === 'DISCONNECTED').length,
        pendingCount: pending.length,
        autoAppliedCount: autoApplied.length,
        autonomyLevel,
      },
    };
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      totalDecisions: this.decisions.length,
      pendingAdaptations: this.pendingAdaptations.length,
      recentAutoApplied: this.getRecentAutoApplied().length,
      decisionTypes: {
        auto_applied: this.decisions.filter(d => d.type === 'auto_applied').length,
        pending_approval: this.decisions.filter(d => d.type === 'pending_approval').length,
        approved: this.decisions.filter(d => d.type === 'approved').length,
        rejected: this.decisions.filter(d => d.type === 'rejected').length,
      },
    };
  }
}
