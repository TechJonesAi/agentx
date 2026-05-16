import React, { useEffect, useState } from 'react';

interface Subsystem {
  name: string;
  lastStatus: 'ok' | 'degraded' | 'failed' | 'unknown';
  lastDetail?: string;
  lastCheckedAt?: string;
  successCount: number;
  failureCount: number;
  repairSuccessCount: number;
  repairFailureCount: number;
}

interface RepairAttempt {
  id: string;
  subsystem: string;
  trigger: string;
  action: string;
  outcome: 'success' | 'failed' | 'skipped' | 'needs-approval';
  detail?: string;
  requiresApproval: boolean;
  timestamp: string;
  durationMs: number;
}

interface HealthSnapshot {
  overall: 'ok' | 'degraded' | 'failed';
  subsystems: Subsystem[];
  recentRepairs: RepairAttempt[];
}

const STATUS_COLOR: Record<string, string> = {
  ok: '#3fb950',
  degraded: '#d29922',
  failed: '#f85149',
  unknown: '#8b949e',
};

/**
 * SelfHealing panel — backed by /api/health/* (HealthMonitor singleton).
 * Polls every 5s; user can force an immediate probe cycle.
 */
export function SelfHealing() {
  const [snap, setSnap] = useState<HealthSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/api/health/status');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSnap(await r.json());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 5000);
    return () => clearInterval(iv);
  }, []);

  const runNow = async () => {
    setBusy(true);
    try {
      await fetch('/api/health/run', { method: 'POST' });
      await load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{
      padding: 'var(--spacing-md)',
      background: 'var(--bg-secondary)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-primary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-md)' }}>
        <h3 style={{ margin: 0, fontSize: '14px', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Self-Healing
        </h3>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {snap && (
            <span style={{
              padding: '3px 10px', borderRadius: '20px', fontSize: '11px', fontWeight: 600,
              background: STATUS_COLOR[snap.overall] + '22', color: STATUS_COLOR[snap.overall],
            }}>
              {snap.overall.toUpperCase()}
            </span>
          )}
          <button
            onClick={runNow}
            disabled={busy}
            style={{ fontSize: '11px', padding: '4px 8px', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: '4px', color: 'var(--text-secondary)', cursor: busy ? 'wait' : 'pointer' }}
          >
            {busy ? 'Running…' : 'Run Now'}
          </button>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--spacing-md)', padding: '8px', background: '#f8544422', border: '1px solid #f85444', borderRadius: '4px', color: '#f85444', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {!snap ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Loading…</div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: 'var(--spacing-md)' }}>
            {snap.subsystems.map((s) => (
              <div key={s.name} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '12px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0, flex: '1 1 auto' }}>
                  <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: STATUS_COLOR[s.lastStatus], flex: '0 0 auto' }} />
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '12px', fontWeight: 600 }}>{s.name}</div>
                    {s.lastDetail && (
                      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.lastDetail}>
                        {s.lastDetail}
                      </div>
                    )}
                  </div>
                </div>
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', whiteSpace: 'nowrap', flex: '0 0 auto' }}>
                  ✓{s.successCount} ✗{s.failureCount}
                  {s.repairSuccessCount + s.repairFailureCount > 0 && (
                    <> · 🔧 {s.repairSuccessCount}/{s.repairSuccessCount + s.repairFailureCount}</>
                  )}
                </div>
              </div>
            ))}
          </div>

          {snap.recentRepairs.length > 0 && (
            <>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                Recent repair attempts ({snap.recentRepairs.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '160px', overflowY: 'auto' }}>
                {snap.recentRepairs.map((r) => (
                  <div key={r.id} style={{ padding: '6px 8px', background: 'var(--bg-primary)', borderRadius: '4px', fontSize: '11px' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                      <span style={{ fontWeight: 600 }}>{r.subsystem}</span>
                      <span style={{ color: STATUS_COLOR[r.outcome === 'success' ? 'ok' : r.outcome === 'failed' ? 'failed' : 'degraded'] }}>
                        {r.outcome}
                      </span>
                    </div>
                    <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                      {r.action}
                      {r.requiresApproval && <span style={{ marginLeft: '6px', color: '#d29922' }}>· needs approval</span>}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
