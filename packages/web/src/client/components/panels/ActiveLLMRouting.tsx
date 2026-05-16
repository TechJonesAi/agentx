import React, { useEffect, useState } from 'react';

interface ActiveModel {
  provider: string;
  model: string;
  localOnly: boolean;
  toolCallingEnabled: boolean;
}

interface RoutingDecision {
  id: string;
  timestamp: string;
  taskType: string;
  model: string;
  provider: string;
  reason: string;
  fallbackUsed: boolean;
  localOnly: boolean;
  toolCallingEnabled: boolean;
  latencyMs?: number;
}

/**
 * Active LLM Routing panel — Phase 4 truth surface.
 *
 * Shows the currently-active provider+model and the last N routing decisions
 * recorded by chatStream() so the user can verify which model handled each
 * request. Backed by GET /api/models/active and /api/models/routing/history.
 */
export function ActiveLLMRouting() {
  const [active, setActive] = useState<ActiveModel | null>(null);
  const [history, setHistory] = useState<RoutingDecision[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [aRes, hRes] = await Promise.all([
          fetch('/api/models/active'),
          fetch('/api/models/routing/history?limit=10'),
        ]);
        const aData = aRes.ok ? await aRes.json() : null;
        const hData = hRes.ok ? await hRes.json() : null;
        if (cancelled) return;
        if (aData && aData.model) setActive(aData as ActiveModel);
        if (hData && Array.isArray(hData.history)) setHistory(hData.history as RoutingDecision[]);
        setError(null);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load routing data');
      }
    };
    load();
    const iv = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [refreshTick]);

  return (
    <div style={{
      padding: 'var(--spacing-md)',
      background: 'var(--bg-secondary)',
      borderRadius: 'var(--radius-md)',
      border: '1px solid var(--border-primary)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-md)' }}>
        <h3 style={{ margin: 0, fontSize: '14px', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Active LLM Routing
        </h3>
        <button
          onClick={() => setRefreshTick(t => t + 1)}
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

      {active ? (
        <div style={{ marginBottom: 'var(--spacing-md)', padding: '10px', background: 'var(--bg-primary)', borderRadius: '6px' }}>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '4px' }}>Current</div>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>
            {active.provider} · <code style={{ fontFamily: 'monospace' }}>{active.model}</code>
          </div>
          <div style={{ marginTop: '6px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
            <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '3px', background: active.localOnly ? '#10b98122' : '#d2992222', color: active.localOnly ? '#10b981' : '#d29922' }}>
              {active.localOnly ? 'localOnly ✓' : 'localOnly off'}
            </span>
            <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '3px', background: active.toolCallingEnabled ? '#10b98122' : '#88888822', color: active.toolCallingEnabled ? '#10b981' : 'var(--text-secondary)' }}>
              tool-calling {active.toolCallingEnabled ? 'on' : 'off'}
            </span>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: 'var(--spacing-md)' }}>
          Loading active model…
        </div>
      )}

      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
        Recent decisions {history.length > 0 && `(${history.length})`}
      </div>
      {history.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
          No routing decisions recorded yet. Send a chat message to populate.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '240px', overflowY: 'auto' }}>
          {history.map(h => (
            <div key={h.id} style={{ padding: '6px 8px', background: 'var(--bg-primary)', borderRadius: '4px', fontSize: '11px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                <code style={{ fontFamily: 'monospace', color: 'var(--accent-cyan)' }}>{h.model}</code>
                <span style={{ color: 'var(--text-secondary)', fontSize: '10px', whiteSpace: 'nowrap' }}>
                  {new Date(h.timestamp).toLocaleTimeString()}
                  {typeof h.latencyMs === 'number' && <> · {h.latencyMs}ms</>}
                </span>
              </div>
              <div style={{ color: 'var(--text-secondary)', marginTop: '2px' }}>
                {h.taskType} · {h.reason}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
