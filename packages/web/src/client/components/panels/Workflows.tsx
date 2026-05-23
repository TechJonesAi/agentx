import React, { useEffect, useState, useMemo } from 'react';
import { ApprovalModal } from './ApprovalModal';

interface WorkflowRun {
  loopId: string;
  goal: string;
  state: 'running' | 'paused' | 'awaiting_approval' | 'succeeded' | 'failed' | 'interrupted_by_restart';
  executionPhase: string | null;
  retryCount: number;
  failureReason: string | null;
  startedAt: number;
  updatedAt: number;
  repairAction?: string | null;
}

interface WorkflowEvent {
  eventId: string;
  loopId: string;
  eventKind: string;
  detail: string | null;
  ts: number;
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
  const [expanded, setExpanded] = useState<string | null>(null);
  const [events, setEvents] = useState<Record<string, WorkflowEvent[]>>({});
  const [filter, setFilter] = useState<string>('all');
  const [search, setSearch] = useState<string>('');
  const [approvalTarget, setApprovalTarget] = useState<{ run: WorkflowRun; decision: 'approve' | 'reject' } | null>(null);

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

  const action = async (loopId: string, op: 'pause' | 'resume', body: Record<string, unknown> = {}): Promise<void> => {
    setBusy(true);
    try {
      await fetch(`/api/workflows/${encodeURIComponent(loopId)}/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      await load();
    } finally { setBusy(false); }
  };

  // Approval flow uses the ApprovalModal. The modal calls back with the
  // operator's comment / rejection reason — we forward to /resume or
  // /reject accordingly. Both rotues record the audit trail server-side.
  const submitApproval = async (reason: string): Promise<void> => {
    if (!approvalTarget) return;
    const { run, decision } = approvalTarget;
    const op = decision === 'approve' ? 'resume' : 'reject';
    setBusy(true);
    try {
      const res = await fetch(`/api/workflows/${encodeURIComponent(run.loopId)}/${op}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(decision === 'approve' ? { from: 'approved', reason } : { reason }),
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(`HTTP ${res.status}: ${txt}`);
      }
      await load();
    } finally { setBusy(false); }
  };

  /** Workflow duration: completedAt - startedAt for terminal rows,
   *  Date.now() - startedAt for in-flight rows. Returns ms. */
  const duration = (r: WorkflowRun): number => {
    const end = (r as { completedAt?: number | null }).completedAt ?? Date.now();
    return Math.max(0, end - r.startedAt);
  };

  const formatDuration = (ms: number): string => {
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
    return `${Math.floor(ms / 3_600_000)}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  };

  /** Workflow is "stuck" if it has been running > 5 minutes with no
   *  recent updatedAt change. */
  const isStuck = (r: WorkflowRun): boolean => {
    if (r.state !== 'running' && r.state !== 'paused') return false;
    return Date.now() - r.updatedAt > 5 * 60 * 1000;
  };

  const filteredRuns = useMemo(() => {
    if (!data) return [];
    let rs = data.runs;
    if (filter !== 'all') rs = rs.filter((r) => r.state === filter);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      rs = rs.filter((r) => r.goal.toLowerCase().includes(q) || r.loopId.toLowerCase().includes(q));
    }
    return rs;
  }, [data, filter, search]);

  const toggleTimeline = async (loopId: string) => {
    if (expanded === loopId) { setExpanded(null); return; }
    setExpanded(loopId);
    if (events[loopId]) return; // cached
    try {
      const r = await fetch(`/api/workflows/${encodeURIComponent(loopId)}`);
      if (!r.ok) return;
      const d = await r.json();
      setEvents((prev) => ({ ...prev, [loopId]: d.events ?? [] }));
    } catch { /* silent */ }
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

          {/* Batch 8D — filter + search */}
          <div style={{ display: 'flex', gap: '6px', marginBottom: 'var(--spacing-md)', flexWrap: 'wrap' }}>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              style={{ fontSize: '11px', padding: '4px 6px', background: 'var(--bg-primary)', border: '1px solid var(--border-primary)', borderRadius: '4px', color: 'var(--text-primary)' }}
            >
              <option value="all">All states</option>
              <option value="running">Running</option>
              <option value="paused">Paused</option>
              <option value="awaiting_approval">Awaiting approval</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="interrupted_by_restart">Interrupted</option>
            </select>
            <input
              type="text"
              placeholder="Search goal / loop id…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ flex: '1 1 200px', fontSize: '11px', padding: '4px 6px', background: 'var(--bg-primary)', border: '1px solid var(--border-primary)', borderRadius: '4px', color: 'var(--text-primary)' }}
            />
          </div>

          {data.runs.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
              No workflows recorded yet. Autonomous loop/builder runs will appear here.
            </div>
          ) : filteredRuns.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
              No workflows match the current filter / search.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '320px', overflowY: 'auto' }}>
              {filteredRuns.map((r) => {
                const evList = events[r.loopId];
                const isExpanded = expanded === r.loopId;
                return (
                  <div key={r.loopId} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: '4px', borderLeft: `3px solid ${STATE_COLOR[r.state] ?? '#888'}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                      <code style={{ fontFamily: 'monospace', fontSize: '11px', color: 'var(--text-secondary)' }}>{r.loopId.slice(0, 24)}</code>
                      <span style={{ display: 'flex', gap: '4px', alignItems: 'center' }}>
                        {isStuck(r) && (
                          <span title={`No update for ${formatDuration(Date.now() - r.updatedAt)}`}
                            style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '3px', background: '#d2992233', color: '#d29922', fontWeight: 600 }}>
                            STUCK
                          </span>
                        )}
                        <span style={{ fontSize: '10px', color: STATE_COLOR[r.state] ?? '#888', fontWeight: 600 }}>{r.state}</span>
                      </span>
                    </div>
                    <div style={{ fontSize: '12px', marginTop: '2px', color: 'var(--text-primary)' }}>{r.goal.slice(0, 100)}</div>
                    <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                      {r.executionPhase && <>phase={r.executionPhase} · </>}
                      retries={r.retryCount}
                      {' · '}duration={formatDuration(duration(r))}
                      {r.failureReason && <> · <span style={{ color: '#f85444' }}>{r.failureReason.slice(0, 60)}</span></>}
                    </div>
                    <div style={{ marginTop: '6px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                      <button onClick={() => toggleTimeline(r.loopId)}
                        style={{ fontSize: '10px', padding: '2px 6px', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: '3px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                        {isExpanded ? 'Hide timeline' : 'View timeline'}
                      </button>
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
                      {r.state === 'awaiting_approval' && (
                        <>
                          <button onClick={() => setApprovalTarget({ run: r, decision: 'approve' })} disabled={busy}
                            style={{ fontSize: '10px', padding: '2px 6px', background: 'transparent', border: '1px solid #3fb95066', borderRadius: '3px', color: '#3fb950', cursor: 'pointer' }}>
                            Approve{r.repairAction ? ` (${r.repairAction.slice(0, 28)})` : ''}
                          </button>
                          <button onClick={() => setApprovalTarget({ run: r, decision: 'reject' })} disabled={busy}
                            style={{ fontSize: '10px', padding: '2px 6px', background: 'transparent', border: '1px solid #f8514966', borderRadius: '3px', color: '#f85149', cursor: 'pointer' }}>
                            Reject
                          </button>
                        </>
                      )}
                    </div>
                    {isExpanded && (
                      <div style={{ marginTop: '8px', padding: '6px 8px', background: 'var(--bg-secondary)', borderRadius: '4px', fontSize: '10px' }}>
                        {!evList ? (
                          <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>Loading timeline…</div>
                        ) : evList.length === 0 ? (
                          <div style={{ color: 'var(--text-secondary)', fontStyle: 'italic' }}>No events recorded.</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', maxHeight: '180px', overflowY: 'auto' }}>
                            {evList.map((e) => (
                              <div key={e.eventId} style={{ display: 'flex', gap: '8px' }}>
                                <span style={{ color: 'var(--text-secondary)', minWidth: '60px' }}>{new Date(e.ts).toLocaleTimeString()}</span>
                                <span style={{ color: 'var(--accent-cyan)', minWidth: '110px' }}>{e.eventKind}</span>
                                <span style={{ color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.detail ?? ''}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {approvalTarget && (
        <ApprovalModal
          loopId={approvalTarget.run.loopId}
          goal={approvalTarget.run.goal}
          repairAction={approvalTarget.run.repairAction ?? null}
          decision={approvalTarget.decision}
          onClose={() => setApprovalTarget(null)}
          onSubmit={submitApproval}
        />
      )}
    </div>
  );
}
