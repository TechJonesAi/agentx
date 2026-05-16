/**
 * HealthMonitor unit tests — Batch 1 verification checkpoint.
 *
 * Coverage:
 *  - registers probes
 *  - runAll() captures ok / degraded / failed outcomes
 *  - failed-with-repair attempts the repair and journals outcome
 *  - failed-without-repair does NOT attempt any repair (no destructive fallback)
 *  - "needs-approval" repair classification is preserved (no auto-action)
 *  - snapshot() returns probes + journal + per-subsystem counts
 *  - throws inside probe.run() are caught and recorded as failed
 *  - throws inside probe.repair() are caught and journalled as failed
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HealthMonitor, type Probe } from '../../src/observability/health-monitor.js';

let mon: HealthMonitor;

beforeEach(() => {
  mon = HealthMonitor.__createForTest();
});

function okProbe(name: string): Probe {
  return { name, run: async () => ({ status: 'ok' }) };
}
function failProbe(name: string, detail = 'simulated'): Probe {
  return { name, run: async () => ({ status: 'failed', detail }) };
}

describe('HealthMonitor — registration + snapshot', () => {
  it('registers probes and exposes them in the snapshot', async () => {
    mon.registerProbe(okProbe('A'));
    mon.registerProbe(okProbe('B'));
    await mon.runAll();
    const snap = mon.snapshot();
    expect(snap.subsystems.map(s => s.name).sort()).toEqual(['A', 'B']);
    expect(snap.overall).toBe('ok');
  });

  it('starts each subsystem at "unknown" until first probe cycle', () => {
    mon.registerProbe(okProbe('NeverRun'));
    const snap = mon.snapshot();
    expect(snap.subsystems[0]?.lastStatus).toBe('unknown');
  });

  it('overall is "failed" if any probe last failed', async () => {
    mon.registerProbe(okProbe('ok'));
    mon.registerProbe(failProbe('bad'));
    await mon.runAll();
    expect(mon.snapshot().overall).toBe('failed');
  });

  it('overall is "degraded" if no fail but at least one degraded', async () => {
    mon.registerProbe(okProbe('ok'));
    mon.registerProbe({ name: 'partial', run: async () => ({ status: 'degraded', detail: 'partial' }) });
    await mon.runAll();
    expect(mon.snapshot().overall).toBe('degraded');
  });
});

describe('HealthMonitor — outcome recording', () => {
  it('runAll() returns one HealthCheck per probe with latency', async () => {
    mon.registerProbe(okProbe('A'));
    mon.registerProbe(failProbe('B', 'boom'));
    const checks = await mon.runAll();
    expect(checks).toHaveLength(2);
    expect(checks[0]?.subsystem).toBe('A');
    expect(checks[0]?.status).toBe('ok');
    expect(typeof checks[0]?.latencyMs).toBe('number');
    expect(checks[1]?.status).toBe('failed');
    expect(checks[1]?.detail).toBe('boom');
  });

  it('catches thrown errors inside probe.run() and records as failed', async () => {
    mon.registerProbe({ name: 'thrower', run: async () => { throw new Error('exploded'); } });
    const checks = await mon.runAll();
    expect(checks[0]?.status).toBe('failed');
    expect(checks[0]?.detail).toContain('exploded');
  });

  it('increments success/failure counts across multiple cycles', async () => {
    mon.registerProbe(okProbe('A'));
    mon.registerProbe(failProbe('B'));
    await mon.runAll();
    await mon.runAll();
    await mon.runAll();
    const snap = mon.snapshot();
    const a = snap.subsystems.find(s => s.name === 'A');
    const b = snap.subsystems.find(s => s.name === 'B');
    expect(a?.successCount).toBe(3);
    expect(a?.failureCount).toBe(0);
    expect(b?.successCount).toBe(0);
    expect(b?.failureCount).toBe(3);
  });
});

describe('HealthMonitor — repair contract', () => {
  it('attempts repair only on failure', async () => {
    let repairCalls = 0;
    mon.registerProbe({
      name: 'A',
      run: async () => ({ status: 'ok' }),
      repair: async () => { repairCalls++; return { outcome: 'success', action: 'noop' }; },
    });
    await mon.runAll();
    expect(repairCalls).toBe(0);
  });

  it('runs repair when probe fails and records the attempt', async () => {
    let repairCalls = 0;
    mon.registerProbe({
      name: 'A',
      run: async () => ({ status: 'failed', detail: 'fell over' }),
      repair: async () => { repairCalls++; return { outcome: 'success', action: 'restart-foo', detail: 'recovered' }; },
    });
    await mon.runAll();
    expect(repairCalls).toBe(1);
    const snap = mon.snapshot();
    expect(snap.recentRepairs).toHaveLength(1);
    const r = snap.recentRepairs[0]!;
    expect(r.subsystem).toBe('A');
    expect(r.action).toBe('restart-foo');
    expect(r.outcome).toBe('success');
    expect(r.trigger).toBe('fell over');
    expect(r.requiresApproval).toBe(false);
    expect(r.approvedByUser).toBe(false);
  });

  it('does NOT run any repair when probe has no repair function (no destructive fallback)', async () => {
    mon.registerProbe(failProbe('A'));
    await mon.runAll();
    expect(mon.snapshot().recentRepairs).toHaveLength(0);
  });

  it('preserves "needs-approval" outcome without auto-applying', async () => {
    mon.registerProbe({
      name: 'A',
      run: async () => ({ status: 'failed' }),
      repair: async () => ({ outcome: 'needs-approval', action: 'restart-ollama', requiresApproval: true, detail: 'user must restart' }),
    });
    await mon.runAll();
    const r = mon.snapshot().recentRepairs[0]!;
    expect(r.outcome).toBe('needs-approval');
    expect(r.requiresApproval).toBe(true);
    expect(r.approvedByUser).toBe(false);
  });

  it('catches throws inside repair() and journals as failed', async () => {
    mon.registerProbe({
      name: 'A',
      run: async () => ({ status: 'failed' }),
      repair: async () => { throw new Error('repair-blew-up'); },
    });
    await mon.runAll();
    const r = mon.snapshot().recentRepairs[0]!;
    expect(r.outcome).toBe('failed');
    expect(r.detail).toContain('repair-blew-up');
  });

  it('records repair success/failure counts per subsystem', async () => {
    let calls = 0;
    mon.registerProbe({
      name: 'A',
      run: async () => ({ status: 'failed' }),
      repair: async () => {
        calls++;
        return calls === 1
          ? { outcome: 'success', action: 'fix' }
          : { outcome: 'failed', action: 'fix-failed' };
      },
    });
    await mon.runAll();
    await mon.runAll();
    const a = mon.snapshot().subsystems.find(s => s.name === 'A')!;
    expect(a.repairSuccessCount).toBe(1);
    expect(a.repairFailureCount).toBe(1);
  });
});

describe('HealthMonitor — journal cap', () => {
  it('returns most recent 50 checks in snapshot regardless of total', async () => {
    mon.registerProbe(okProbe('A'));
    for (let i = 0; i < 60; i++) await mon.runAll();
    const snap = mon.snapshot();
    expect(snap.recentChecks.length).toBeLessThanOrEqual(50);
    // Newest-first
    if (snap.recentChecks.length >= 2) {
      const t0 = Date.parse(snap.recentChecks[0]!.timestamp);
      const t1 = Date.parse(snap.recentChecks[1]!.timestamp);
      expect(t0).toBeGreaterThanOrEqual(t1);
    }
  });
});
