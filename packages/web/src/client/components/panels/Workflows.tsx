import React, { useEffect, useState } from 'react';

interface WorkflowRun {
  loopId: string;
  goal: string;
  state: 'running' | 'paused' | 'awaiting_approval' | 'succeeded' | 'failed' | 'interrupted_by_restart';
  executionPhase: string | null;
  retryCount: number;
  failureReason: string | null;
  startedAt: number;
  updatedAt: number;
}

interface Payload {
  available: boolean;
  summary: Record<string, number>;
  runs: WorkflowRun[];
}

const STATE_COLOR: Record<string, string> = {
  running: '#3fb950',
  paused: '#d29922',
  awaiting_approval: '#d29922',
  succeeded: '#3fb950',
  failed: '#f85149',
  interrupted_by_restart: '#f85149',
};

/**
 * Workflows panel — Batch 6A truth surface for the durable workflow runtime.
 *
 * Backed by /api/workflows. Shows total counts per state plus the recent
 * 50 runs with their phase + retry counts. Restart-recovery proof is
 * visible here: an "interrupted_by_restart" entry indicates the engine
 * marked an orphaned run from a prior process.
 */
export function Workflows() {
  const [data, setData] = useState<Payload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const r = await fetch('/api/workflows?limit=50');
      const d = await r.json();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 6000);
    return () => clearInterval(iv);
  }, []);

  const action = async (loopId: string, op: 'pause' | 'resume') => {
    setBusy(true);
    try {
      await fetch(`/api/workflows/${encodeURIComponent(loopId)}/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await load();
    } finally { setBusy(false); }
  };

  return (
    <div style={{ padding: 'var(--spacing-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-md)' }}>
        <h3 style={{ margin: 0, fontSize: '14px', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Workflows
        </h3>
        <button
          onClick={load}
          style={{ fontSize: '11px', padding: '4px 8px', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: '4px', color: 'var(--text-secondary)', cursor: 'pointer' }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--spacing-md)', padding: '8px', background: '#f8544422', border: '1px solid #f85444', borderRadius: '4px', color: '#f85444', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {!data ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Loading…</div>
      ) : (
        <>
          {/* Summary chips */}
          <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: 'var(--spacing-md)' }}>
            {(['running', 'paused', 'awaiting_approval', 'succeeded', 'failed', 'interrupted_by_restart'] as const).map((s) => {
              const n = data.summary[s] ?? 0;
              return (
                <span key={s} style={{ fontSize: '10px', padding: '2px 8px', borderRadius: '10px', background: STATE_COLOR[s] + '22', color: STATE_COLOR[s], fontWeight: 600 }}>
                  {s.replace(/_/g, ' ')} · {n}
                </span>
              );
            })}
          </div>

          {data.runs.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
              No workflows recorded yet. Autonomous loop/builder runs will appear here.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '320px', overflowY: 'auto' }}>
              {data.runs.map((r) => (
                <div key={r.loopId} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: '4px', borderLeft: `3px solid ${STATE_COLOR[r.state] ?? '#888'}` }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                    <code style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-secondary)' }}>{r.loopId.slice(0, 24)}</code>
                    <span style={{ fontSize: '10px', color: STATE_COLOR[r.state] ?? '#888', fontWeight: 600 }}>{r.state}</span>
                  </div>
                  <div style={{ fontSize: '12px', marginTop: '2px', color: 'var(--text-primary)' }}>{r.goal.slice(0, 100)}</div>
                  <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    {r.executionPhase && <>phase={r.executionPhase} · </>}
                    retries={r.retryCount}
                    {r.failureReason && <> · <span style={{ color: '#f85444' }}>{r.failureReason.slice(0, 60)}</span></>}
                  </div>
                  {(r.state === 'running' || r.state === 'paused') && (
                    <div style={{ marginTop: '6px', display: 'flex', gap: '4px' }}>
                      {r.state === 'running' && (
                        <button onClick={() => action(r.loopId, 'pause')} disabled={busy}
                          style={{ fontSize: '10px', padding: '2px 6px', background: 'transparent', border: '1px solid #d2992266', borderRadius: '3px', color: '#d29922', cursor: 'pointer' }}>
                          Pause
                        </button>
                      )}
                      {r.state === 'paused' && (
                        <button onClick={() => action(r.loopId, 'resume')} disabled={busy}
                          style={{ fontSize: '10px', padding: '2px 6px', background: 'transparent', border: '1px solid #3fb95066', borderRadius: '3px', color: '#3fb950', cursor: 'pointer' }}>
                          Resume
                        </button>
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
