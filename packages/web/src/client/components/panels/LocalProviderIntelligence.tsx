import React, { useEffect, useState } from 'react';

interface OmlxStatus {
  available: boolean;
  endpoint: string | null;
  models?: string[];
  modelCount?: number;
  blocked?: boolean;
  reason?: string;
  recovery?: string;
}

interface ProviderEntry {
  provider: string;
  samples: number;
  avgScore: number;
  avgLatencyMs: number | null;
  lastFailureReason?: string;
}

interface CategoryComparison {
  taskCategory: string;
  winner: string | null;
  reasons: string[];
  perProvider: ProviderEntry[];
}

interface BenchmarkPayload {
  available: boolean;
  size: number;
  taskCategories: string[];
  benchmarks: Array<{ taskCategory: string; provider: string; score: number; ranAt: number }>;
}

/**
 * Local Provider Intelligence — Batch 10 truth surface.
 *
 * Shows the live oMLX endpoint status alongside the benchmark store's
 * per-category winners. Backed exclusively by real backend routes
 * (/api/providers/omlx/status, /api/providers/benchmarks,
 * /api/providers/comparison/:category). No fake data, no hardcoded
 * winners.
 */
export function LocalProviderIntelligence() {
  const [omlx, setOmlx] = useState<OmlxStatus | null>(null);
  const [bench, setBench] = useState<BenchmarkPayload | null>(null);
  const [comparisons, setComparisons] = useState<CategoryComparison[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    try {
      const [omlxRes, benchRes] = await Promise.all([
        fetch('/api/providers/omlx/status'),
        fetch('/api/providers/benchmarks'),
      ]);
      const omlxData = await omlxRes.json();
      const benchData = await benchRes.json();
      setOmlx(omlxData);
      setBench(benchData);

      // Pull a comparison for each category that has samples.
      const cats: string[] = benchData?.taskCategories ?? [];
      if (cats.length > 0) {
        const cmpResults = await Promise.all(
          cats.map((c) => fetch(`/api/providers/comparison/${encodeURIComponent(c)}`).then((r) => r.json()).catch(() => null)),
        );
        setComparisons(
          cmpResults
            .filter((r): r is { available: boolean; comparison: CategoryComparison } => r && r.available && r.comparison)
            .map((r) => r.comparison),
        );
      } else {
        setComparisons([]);
      }
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

  const runBenchmark = async () => {
    setBusy(true);
    try {
      await fetch('/api/models/benchmark-local-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Benchmark run failed');
    } finally { setBusy(false); }
  };

  const statusColor = (s: OmlxStatus | null) => {
    if (!s) return '#888';
    if (s.available) return '#3fb950';
    if (s.blocked) return '#f85149';
    return '#d29922';
  };

  return (
    <div style={{ padding: 'var(--spacing-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-md)' }}>
        <h3 style={{ margin: 0, fontSize: '14px', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Local Provider Intelligence
        </h3>
        <button
          onClick={runBenchmark}
          disabled={busy}
          style={{ fontSize: '11px', padding: '4px 8px', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: '4px', color: 'var(--text-secondary)', cursor: busy ? 'wait' : 'pointer' }}
        >
          {busy ? 'Running…' : 'Run Benchmark'}
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--spacing-md)', padding: '8px', background: '#f8544422', border: '1px solid #f85444', borderRadius: '4px', color: '#f85444', fontSize: '12px' }}>
          {error}
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginBottom: 'var(--spacing-md)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px', background: 'var(--bg-primary)', borderRadius: '4px' }}>
          <span style={{ fontSize: '12px', fontWeight: 600 }}>Ollama</span>
          <span style={{ fontSize: '10px', color: '#3fb950', fontWeight: 600 }}>DEFAULT</span>
        </div>
        <div style={{ padding: '8px', background: 'var(--bg-primary)', borderRadius: '4px', borderLeft: `3px solid ${statusColor(omlx)}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', fontWeight: 600 }}>oMLX</span>
            <span style={{ fontSize: '10px', color: statusColor(omlx), fontWeight: 600 }}>
              {!omlx ? 'LOADING' : omlx.available ? `READY · ${omlx.modelCount} model(s)` : (omlx.blocked ? 'BLOCKED' : 'OFFLINE')}
            </span>
          </div>
          {omlx?.endpoint && <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}><code>{omlx.endpoint}</code></div>}
          {omlx?.reason && !omlx.available && <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '2px' }}>{omlx.reason}</div>}
        </div>
      </div>

      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
        Benchmark categories {bench?.size ? `(${bench.size} samples)` : '(no samples)'}
      </div>
      {comparisons.length === 0 ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic', padding: '8px 0' }}>
          No benchmark data yet. Click "Run Benchmark" to compare local providers.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {comparisons.map((c) => (
            <div key={c.taskCategory} style={{ padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <strong style={{ fontSize: '12px' }}>{c.taskCategory}</strong>
                <span style={{ fontSize: '10px', color: c.winner ? '#3fb950' : 'var(--text-secondary)', fontWeight: 600 }}>
                  winner: {c.winner ?? 'insufficient samples'}
                </span>
              </div>
              <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
                {c.perProvider.map((p) => (
                  <span key={p.provider} style={{ fontSize: '10px', padding: '2px 6px', background: 'var(--bg-secondary)', borderRadius: '3px' }}>
                    {p.provider}: <strong>{p.avgScore.toFixed(3)}</strong> ({p.samples}) {p.avgLatencyMs ? `${p.avgLatencyMs}ms` : ''}
                  </span>
                ))}
              </div>
              {c.reasons.length > 0 && (
                <div style={{ fontSize: '10px', color: 'var(--text-secondary)', marginTop: '4px' }}>
                  {c.reasons.join(' · ')}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
