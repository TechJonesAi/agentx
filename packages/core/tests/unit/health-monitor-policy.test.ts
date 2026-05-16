/**
 * HealthMonitor — repair policy enforcement + approval queue.
 * Batch 3 verification.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { HealthMonitor } from '../../src/observability/health-monitor.js';

let mon: HealthMonitor;
beforeEach(() => { mon = HealthMonitor.__createForTest(); });

describe('HealthMonitor — repair policy = never', () => {
  it('does NOT invoke repair() and records outcome:skipped', async () => {
    let repaired = false;
    mon.setPolicyResolver(() => 'never');
    mon.registerProbe({
      name: 'X',
      run: async () => ({ status: 'failed' }),
      repair: async () => { repaired = true; return { outcome: 'success', action: 'fix' }; },
    });
    await mon.runAll();
    expect(repaired).toBe(false);
    const r = mon.snapshot().recentRepairs[0]!;
    expect(r.outcome).toBe('skipped');
  });
});

describe('HealthMonitor — repair policy = always-ask', () => {
  it('queues repair as needs-approval without invoking repair()', async () => {
    let repaired = false;
    mon.setPolicyResolver(() => 'always-ask');
    mon.registerProbe({
      name: 'X',
      run: async () => ({ status: 'failed' }),
      repair: async () => { repaired = true; return { outcome: 'success', action: 'fix' }; },
    });
    await mon.runAll();
    expect(repaired).toBe(false);
    const pending = mon.pendingApprovals();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.outcome).toBe('needs-approval');
  });

  it('approveRepair() invokes the repair and records success', async () => {
    mon.setPolicyResolver(() => 'always-ask');
    mon.registerProbe({
      name: 'X',
      run: async () => ({ status: 'failed' }),
      repair: async () => ({ outcome: 'success', action: 'fix-it', detail: 'done' }),
    });
    await mon.runAll();
    const pending = mon.pendingApprovals();
    expect(pending).toHaveLength(1);
    const approved = await mon.approveRepair(pending[0]!.id);
    expect(approved?.outcome).toBe('success');
    expect(approved?.approvedByUser).toBe(true);
    expect(mon.pendingApprovals()).toHaveLength(0);
  });

  it('rejectRepair() marks the entry skipped and clears the queue', async () => {
    mon.setPolicyResolver(() => 'always-ask');
    mon.registerProbe({
      name: 'X',
      run: async () => ({ status: 'failed' }),
      repair: async () => ({ outcome: 'success', action: 'fix' }),
    });
    await mon.runAll();
    const pending = mon.pendingApprovals();
    const rejected = mon.rejectRepair(pending[0]!.id);
    expect(rejected?.outcome).toBe('skipped');
    expect(mon.pendingApprovals()).toHaveLength(0);
  });

  it('approveRepair returns null for unknown id', async () => {
    const r = await mon.approveRepair('does-not-exist');
    expect(r).toBeNull();
  });
});

describe('HealthMonitor — repair policy = auto-safe (default)', () => {
  it('invokes repair() immediately on failure', async () => {
    let repaired = false;
    mon.setPolicyResolver(() => 'auto-safe');
    mon.registerProbe({
      name: 'X',
      run: async () => ({ status: 'failed' }),
      repair: async () => { repaired = true; return { outcome: 'success', action: 'fix' }; },
    });
    await mon.runAll();
    expect(repaired).toBe(true);
    const r = mon.snapshot().recentRepairs[0]!;
    expect(r.outcome).toBe('success');
  });
});
