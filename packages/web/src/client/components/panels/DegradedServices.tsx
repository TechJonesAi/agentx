import React, { useEffect, useState } from 'react';

interface DegradedService {
  name: string;
  state: 'unavailable' | 'degraded' | 'ok';
  why: string;
  impact: string;
  nextAction: string;
  recoveryPath: string;
}

interface ServicePayload {
  services: DegradedService[];
}

/**
 * DegradedServices panel — Batch 4 operator-trust surface.
 *
 * No fake green badges. For every service AgentX depends on that is NOT
 * currently working at full capacity, the operator sees:
 *   - WHY it's degraded (the specific reason)
 *   - IMPACT (what the user-visible consequence is)
 *   - NEXT ACTION (what to click / install / set)
 *   - RECOVERY PATH (how to get back to "ok")
 *
 * Backed by GET /api/services/degraded which builds the list from
 * HealthMonitor subsystems + known feature-flag gates + missing optional
 * dependencies. Source of truth = live runtime state.
 */
export function DegradedServices() {
  const [data, setData] = useState<ServicePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/api/services/degraded');
      const d = await r.json();
      setData(d);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  };

  useEffect(() => {
    load();
    const iv = setInterval(load, 8000);
    return () => clearInterval(iv);
  }, []);

  const color = (state: DegradedService['state']) => ({
    unavailable: '#f85149',
    degraded: '#d29922',
    ok: '#3fb950',
  }[state]);

  return (
    <div style={{ padding: 'var(--spacing-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)' }}>
      <h3 style={{ margin: 0, marginBottom: 'var(--spacing-md)', fontSize: '14px', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        Degraded Services
      </h3>

      {error && (
        <div style={{ marginBottom: 'var(--spacing-md)', padding: '8px', background: '#f8544422', border: '1px solid #f85444', borderRadius: '4px', color: '#f85444', fontSize: '12px' }}>
          {error}
        </div>
      )}

      {!data ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Loading…</div>
      ) : data.services.length === 0 ? (
        <div style={{ fontSize: '12px', color: '#3fb950', fontStyle: 'italic' }}>
          Every dependency is operational. No degraded services.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {data.services.map((s) => (
            <div key={s.name} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: '6px', borderLeft: `3px solid ${color(s.state)}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                <strong style={{ fontSize: '12px' }}>{s.name}</strong>
                <span style={{ fontSize: '10px', padding: '2px 6px', borderRadius: '3px', background: color(s.state) + '22', color: color(s.state), textTransform: 'uppercase' }}>
                  {s.state}
                </span>
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                <div><strong>Why:</strong> {s.why}</div>
                <div><strong>Impact:</strong> {s.impact}</div>
                <div><strong>Next:</strong> {s.nextAction}</div>
                <div><strong>Recovery:</strong> {s.recoveryPath}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
