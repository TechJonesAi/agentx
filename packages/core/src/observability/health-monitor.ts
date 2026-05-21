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

export type RepairPolicy = 'auto-safe' | 'always-ask' | 'never';

/** Function the HealthMonitor uses to ask the runtime for the current policy.
 *  Injected at construction so the monitor stays decoupled from settings. */
export type RepairPolicyResolver = () => RepairPolicy;

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
  private policyResolver: RepairPolicyResolver = () => 'auto-safe';

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

  /** Inject the resolver. Called once at agent boot with a closure that
   *  reads from RuntimeSettingsStore. */
  setPolicyResolver(fn: RepairPolicyResolver): void {
    this.policyResolver = fn;
  }

  /** Approve a previously-queued repair attempt and re-run it. Returns
   *  the updated attempt or null if id was not found / already executed. */
  async approveRepair(id: string): Promise<RepairAttempt | null> {
    const idx = this.repairs.findIndex((r) => r.id === id);
    if (idx < 0) return null;
    const attempt = this.repairs[idx]!;
    if (!attempt.requiresApproval || attempt.approvedByUser) return attempt;
    // Find the probe by name and re-run its repair.
    const probe = this.probes.find((p) => p.name === attempt.subsystem);
    if (!probe?.repair) return attempt;
    const t0 = Date.now();
    try {
      const r = await probe.repair();
      attempt.outcome = r.outcome;
      attempt.action = r.action;
      if (r.detail !== undefined) attempt.detail = r.detail;
      attempt.durationMs = Date.now() - t0;
      attempt.approvedByUser = true;
      attempt.requiresApproval = false;
      if (r.outcome === 'success') {
        this.repairSuccessCounts.set(attempt.subsystem, (this.repairSuccessCounts.get(attempt.subsystem) ?? 0) + 1);
      } else if (r.outcome === 'failed') {
        this.repairFailureCounts.set(attempt.subsystem, (this.repairFailureCounts.get(attempt.subsystem) ?? 0) + 1);
      }
    } catch (e) {
      attempt.outcome = 'failed';
      attempt.detail = e instanceof Error ? e.message : String(e);
      attempt.durationMs = Date.now() - t0;
      attempt.approvedByUser = true;
      attempt.requiresApproval = false;
    }
    return attempt;
  }

  /** Reject a queued repair — records "skipped" outcome. */
  rejectRepair(id: string): RepairAttempt | null {
    const attempt = this.repairs.find((r) => r.id === id);
    if (!attempt) return null;
    if (!attempt.requiresApproval || attempt.approvedByUser) return attempt;
    attempt.outcome = 'skipped';
    attempt.requiresApproval = false;
    attempt.approvedByUser = false;
    attempt.detail = (attempt.detail ?? '') + ' [rejected by user]';
    return attempt;
  }

  /** List repairs awaiting user approval (oldest first). */
  pendingApprovals(): RepairAttempt[] {
    return this.repairs.filter((r) => r.requiresApproval && !r.approvedByUser);
  }

  start(intervalMs = 60000): void {
    if (this.timer) return;
    // Defer the first probe cycle to setImmediate / setTimeout so the
    // caller (typically agent constructor) never blocks on probe work.
    // On Windows CI, synchronous file-system + dynamic-import latency
    // in 11 probes can push the test-runner hook timeout past 10s if
    // microtasks queue ahead of the test's own beforeEach work.
    const kickoff = setTimeout(() => {
      this.runAll().catch(() => { /* never throw from background */ });
    }, 0);
    if (typeof kickoff.unref === 'function') kickoff.unref();
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

    // Batch 3 — repair policy gate.
    //   'never'       → record skipped, do not invoke repair() at all.
    //   'always-ask'  → record a pending entry the user must approve.
    //   'auto-safe'   → run repair() now (existing behavior).
    const policy: RepairPolicy = (() => {
      try { return this.policyResolver(); } catch { return 'auto-safe'; }
    })();
    if (policy === 'never') {
      const id = `repair-${Date.now()}-${(this.seq++).toString(36)}`;
      this.repairs.push({
        id,
        subsystem: probe.name,
        trigger,
        action: '(repair policy = never)',
        outcome: 'skipped',
        detail: 'repair policy is set to "never" — no action taken',
        requiresApproval: false,
        approvedByUser: false,
        timestamp: new Date().toISOString(),
        durationMs: 0,
      });
      if (this.repairs.length > 500) this.repairs.splice(0, this.repairs.length - 500);
      return;
    }
    if (policy === 'always-ask') {
      const id = `repair-${Date.now()}-${(this.seq++).toString(36)}`;
      this.repairs.push({
        id,
        subsystem: probe.name,
        trigger,
        action: '(pending user approval)',
        outcome: 'needs-approval',
        detail: 'repair policy is set to "always-ask" — call POST /api/health/approve-repair/:id to run',
        requiresApproval: true,
        approvedByUser: false,
        timestamp: new Date().toISOString(),
        durationMs: 0,
      });
      if (this.repairs.length > 500) this.repairs.splice(0, this.repairs.length - 500);
      return;
    }

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
