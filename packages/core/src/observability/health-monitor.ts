/**
 * HealthMonitor — periodic real health checks across AgentX subsystems.
 *
 * Records every failure with a classification, optionally attempts a SAFE
 * repair, logs the outcome, and exposes the journal via the dashboard
 * Self-Healing surface (/api/health/*).
 *
 * Design rules:
 *   - All probes are read-only or idempotent.
 *   - "Repair" actions are only the safest possible — e.g. re-pinging an
 *     endpoint, re-instantiating a singleton getter, clearing a stale
 *     cache. NO destructive operations, NO restarts.
 *   - Every action is journaled so the user can see what was attempted.
 *   - Anything risky is flagged as "needs user approval" rather than run.
 *
 * Self-learning hook:
 *   - When a repair succeeds/fails, the outcome is recorded against the
 *     subsystem so future probes can show success-rate trends.
 */

export type HealthStatus = 'ok' | 'degraded' | 'failed';

export interface HealthCheck {
  subsystem: string;
  status: HealthStatus;
  detail?: string;
  latencyMs: number;
  timestamp: string;
}

export type RepairOutcome = 'success' | 'failed' | 'skipped' | 'needs-approval';

export interface RepairAttempt {
  id: string;
  subsystem: string;
  trigger: string;             // what failed health check triggered this
  action: string;              // human-readable description of the repair
  outcome: RepairOutcome;
  detail?: string;
  requiresApproval: boolean;
  approvedByUser: boolean;
  timestamp: string;
  durationMs: number;
}

export interface Probe {
  name: string;
  run: () => Promise<{ status: HealthStatus; detail?: string }>;
  repair?: () => Promise<{ outcome: RepairOutcome; detail?: string; action: string; requiresApproval?: boolean }>;
}

export class HealthMonitor {
  private static instance: HealthMonitor | null = null;
  private probes: Probe[] = [];
  private checks: HealthCheck[] = [];
  private repairs: RepairAttempt[] = [];
  private successCounts = new Map<string, number>();
  private failureCounts = new Map<string, number>();
  private repairSuccessCounts = new Map<string, number>();
  private repairFailureCounts = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;
  private seq = 0;

  static getInstance(): HealthMonitor {
    if (!this.instance) this.instance = new HealthMonitor();
    return this.instance;
  }

  static __createForTest(): HealthMonitor {
    return new HealthMonitor();
  }

  registerProbe(probe: Probe): void {
    this.probes.push(probe);
  }

  start(intervalMs = 60000): void {
    if (this.timer) return;
    // Run one immediate cycle for warm dashboard state, then every interval.
    this.runAll().catch(() => { /* never throw from background */ });
    this.timer = setInterval(() => {
      this.runAll().catch(() => { /* never throw from background */ });
    }, intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  /** Run every probe once and (for failures) attempt safe repair. */
  async runAll(): Promise<HealthCheck[]> {
    const results: HealthCheck[] = [];
    for (const probe of this.probes) {
      const t0 = Date.now();
      let r: { status: HealthStatus; detail?: string };
      try {
        r = await probe.run();
      } catch (e) {
        r = { status: 'failed', detail: e instanceof Error ? e.message : String(e) };
      }
      const latencyMs = Date.now() - t0;
      const check: HealthCheck = {
        subsystem: probe.name,
        status: r.status,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
        latencyMs,
        timestamp: new Date().toISOString(),
      };
      this.checks.push(check);
      // Cap journal at 500 entries
      if (this.checks.length > 500) this.checks.splice(0, this.checks.length - 500);
      if (r.status === 'ok') {
        this.successCounts.set(probe.name, (this.successCounts.get(probe.name) ?? 0) + 1);
      } else {
        this.failureCounts.set(probe.name, (this.failureCounts.get(probe.name) ?? 0) + 1);
        if (probe.repair) {
          await this.tryRepair(probe, r.detail ?? 'unknown');
        }
      }
      results.push(check);
    }
    return results;
  }

  private async tryRepair(probe: Probe, trigger: string): Promise<void> {
    if (!probe.repair) return;
    const t0 = Date.now();
    let outcome: RepairOutcome = 'failed';
    let action = '(no action)';
    let detail: string | undefined;
    let requiresApproval = false;
    try {
      const r = await probe.repair();
      outcome = r.outcome;
      action = r.action;
      detail = r.detail;
      requiresApproval = !!r.requiresApproval;
    } catch (e) {
      detail = e instanceof Error ? e.message : String(e);
    }
    const id = `repair-${Date.now()}-${(this.seq++).toString(36)}`;
    const attempt: RepairAttempt = {
      id,
      subsystem: probe.name,
      trigger,
      action,
      outcome,
      ...(detail !== undefined ? { detail } : {}),
      requiresApproval,
      approvedByUser: false,
      timestamp: new Date().toISOString(),
      durationMs: Date.now() - t0,
    };
    this.repairs.push(attempt);
    if (this.repairs.length > 500) this.repairs.splice(0, this.repairs.length - 500);
    if (outcome === 'success') {
      this.repairSuccessCounts.set(probe.name, (this.repairSuccessCounts.get(probe.name) ?? 0) + 1);
    } else if (outcome === 'failed') {
      this.repairFailureCounts.set(probe.name, (this.repairFailureCounts.get(probe.name) ?? 0) + 1);
    }
  }

  /** Snapshot for the dashboard. */
  snapshot(): {
    overall: HealthStatus;
    subsystems: Array<{
      name: string;
      lastStatus: HealthStatus | 'unknown';
      lastDetail?: string;
      lastCheckedAt?: string;
      successCount: number;
      failureCount: number;
      repairSuccessCount: number;
      repairFailureCount: number;
    }>;
    recentChecks: HealthCheck[];
    recentRepairs: RepairAttempt[];
  } {
    const subsystems = this.probes.map((p) => {
      const last = [...this.checks].reverse().find((c) => c.subsystem === p.name);
      const lastStatus: HealthStatus | 'unknown' = last?.status ?? 'unknown';
      return {
        name: p.name,
        lastStatus,
        ...(last?.detail !== undefined ? { lastDetail: last.detail } : {}),
        ...(last?.timestamp !== undefined ? { lastCheckedAt: last.timestamp } : {}),
        successCount: this.successCounts.get(p.name) ?? 0,
        failureCount: this.failureCounts.get(p.name) ?? 0,
        repairSuccessCount: this.repairSuccessCounts.get(p.name) ?? 0,
        repairFailureCount: this.repairFailureCounts.get(p.name) ?? 0,
      };
    });
    const anyFailed = subsystems.some((s) => s.lastStatus === 'failed');
    const anyDegraded = subsystems.some((s) => s.lastStatus === 'degraded');
    const overall: HealthStatus = anyFailed ? 'failed' : anyDegraded ? 'degraded' : 'ok';
    return {
      overall,
      subsystems,
      recentChecks: this.checks.slice(-50).reverse(),
      recentRepairs: this.repairs.slice(-50).reverse(),
    };
  }
}
