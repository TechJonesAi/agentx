import React, { useEffect, useState } from 'react';

interface TraceEvent {
  ts?: number;
  event: string;
  [k: string]: unknown;
}

const EVENT_COLOR: Record<string, string> = {
  retrieval_started: '#3fb950',
  retrieval_results: '#3fb950',
  retrieval_sufficiency_decision: '#d29922',
  tool_fallback_allowed: '#3fb950',
  tool_fallback_blocked: '#f85149',
  external_request_attempted: '#d29922',
  external_request_blocked: '#f85149',
};

/**
 * Decision Trace panel — Batch 4 truth surface.
 *
 * Streams the agent's most-recent _decisionTrace.snapshot() so the operator
 * can see, per chat call:
 *   - retrieval start/results/sufficiency
 *   - tool gate decisions (allowed / blocked / reason)
 *   - external request attempts and blocks (localOnly enforcement proof)
 *
 * No fake events — only what the agent actually emitted during the most
 * recent call.
 */
export function DecisionTrace() {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setBusy(true);
    try {
      const r = await fetch('/api/decision-trace/last');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      setEvents(Array.isArray(data.events) ? data.events : []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally { setBusy(false); }
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 4000);
    return () => clearInterval(iv);
  }, []);

  return (
    <div style={{ padding: 'var(--spacing-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-md)' }}>
        <h3 style={{ margin: 0, fontSize: '14px', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Decision Trace (last call)
        </h3>
        <button
          onClick={load}
          disabled={busy}
          style={{ fontSize: '11px', padding: '4px 8px', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: '4px', color: 'var(--text-secondary)', cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--spacing-md)', padding: '8px', background: '#f8544422', border: '1px solid #f85444', borderRadius: '4px', color: '#f85444', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {events.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic', padding: '8px 0' }}>
          No decision events yet. Send a chat message to populate.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '320px', overflowY: 'auto' }}>
          {events.map((e, i) => {
            const color = EVENT_COLOR[e.event] ?? 'var(--text-secondary)';
            const reason = (e['reason'] as string | undefined) ?? '';
            const tool = (e['tool'] as string | undefined) ?? '';
            const host = (e['host'] as string | undefined) ?? '';
            return (
              <div key={i} style={{ padding: '6px 8px', background: 'var(--bg-primary)', borderRadius: '4px', fontSize: '11px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                  <span style={{ color, fontWeight: 600 }}>{e.event}</span>
                  {e.ts && <span style={{ color: 'var(--text-secondary)', fontSize: '10px', whiteSpace: 'nowrap' }}>{new Date(e.ts).toLocaleTimeString()}</span>}
                </div>
                {(reason || tool || host) && (
                  <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                    {tool && <code style={{ fontFamily: 'monospace' }}>{tool}</code>}
                    {tool && reason && ' · '}
                    {reason}
                    {host && ` · host=${host}`}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
