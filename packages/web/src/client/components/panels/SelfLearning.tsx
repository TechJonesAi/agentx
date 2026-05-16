import React, { useEffect, useState } from 'react';

interface Reliability {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;
  avgLatencyMs: number;
  lastUsedAt?: string;
  lastFailureReason?: string;
}

interface ToolOutcome {
  id: string;
  timestamp: string;
  toolName: string;
  success: boolean;
  latencyMs: number;
  resultPreview: string;
  failureReason?: string;
}

interface Payload {
  available: boolean;
  size: number;
  reliability: Reliability[];
  recent: ToolOutcome[];
}

/**
 * SelfLearning panel — backed by /api/learning/tool-outcomes.
 *
 * Shows per-tool reliability (success rate, avg latency) computed from
 * every real tool call recorded by ToolOutcomeStore. User can clear the
 * learned data; this is the only "destructive" control on the panel.
 */
export function SelfLearning() {
  const [data, setData] = useState<Payload | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/api/learning/tool-outcomes');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData(await r.json());
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

  const clearData = async () => {
    if (!confirm('Clear all learned tool-outcome data? This resets reliability stats.')) return;
    setBusy(true);
    try {
      await fetch('/api/learning/tool-outcomes', { method: 'DELETE' });
      await load();
    } finally { setBusy(false); }
  };

  const exportData = () => {
    if (!data) return;
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `agentx-learning-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
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
          Self-Learning
        </h3>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button
            onClick={exportData}
            disabled={!data || data.size === 0}
            style={{ fontSize: '11px', padding: '4px 8px', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: '4px', color: 'var(--text-secondary)', cursor: 'pointer' }}
          >
            Export
          </button>
          <button
            onClick={clearData}
            disabled={busy || !data || data.size === 0}
            style={{ fontSize: '11px', padding: '4px 8px', background: 'transparent', border: '1px solid #f8544466', borderRadius: '4px', color: '#f85444', cursor: 'pointer' }}
          >
            Clear
          </button>
        </div>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--spacing-md)', padding: '8px', background: '#f8544422', border: '1px solid #f85444', borderRadius: '4px', color: '#f85444', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {!data ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Loading…</div>
      ) : data.size === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic', padding: '12px 0' }}>
          No tool outcomes recorded yet. Send a chat message that triggers tool calls to populate.
        </div>
      ) : (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: 'var(--spacing-md)' }}>
            {data.reliability.map((r) => {
              const pct = Math.round(r.successRate * 100);
              const color = pct >= 90 ? '#3fb950' : pct >= 60 ? '#d29922' : '#f85149';
              return (
                <div key={r.toolName} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: '4px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                    <code style={{ fontFamily: 'monospace', fontSize: '12px', color: 'var(--accent-cyan)' }}>{r.toolName}</code>
                    <span style={{ fontSize: '11px', color, fontWeight: 600 }}>{pct}% · {r.totalCalls} call{r.totalCalls === 1 ? '' : 's'}</span>
                  </div>
                  <div style={{ marginTop: '4px', height: '4px', background: 'var(--bg-secondary)', borderRadius: '2px', overflow: 'hidden' }}>
                    <div style={{ width: `${pct}%`, height: '100%', background: color }} />
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                    <span>✓{r.successCount} ✗{r.failureCount} · avg {r.avgLatencyMs}ms</span>
                    {r.lastFailureReason && (
                      <span title={r.lastFailureReason} style={{ color: '#f85444', maxWidth: '50%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        last fail: {r.lastFailureReason}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
            Last {Math.min(data.recent.length, 5)} outcome{data.recent.length === 1 ? '' : 's'}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', maxHeight: '140px', overflowY: 'auto' }}>
            {data.recent.slice(0, 5).map((o) => (
              <div key={o.id} style={{ padding: '4px 8px', background: 'var(--bg-primary)', borderRadius: '4px', fontSize: '11px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
                  <span>
                    <span style={{ color: o.success ? '#3fb950' : '#f85149' }}>{o.success ? '✓' : '✗'}</span>{' '}
                    <code style={{ fontFamily: 'monospace' }}>{o.toolName}</code>
                  </span>
                  <span style={{ color: 'var(--text-secondary)', fontSize: '10px', whiteSpace: 'nowrap' }}>
                    {o.latencyMs}ms · {new Date(o.timestamp).toLocaleTimeString()}
                  </span>
                </div>
                {o.failureReason && (
                  <div style={{ color: '#f85444', marginTop: '2px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={o.failureReason}>
                    {o.failureReason}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
