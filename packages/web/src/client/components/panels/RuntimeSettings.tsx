import React, { useEffect, useState } from 'react';

interface Settings {
  localOnly: boolean;
  retrievalEnabled: boolean;
  toolCallingEnabled: boolean;
  builderV2Enabled: boolean;
  agentLoopsEnabled: boolean;
  repairPolicy: 'auto-safe' | 'always-ask' | 'never';
  autoRoutingMode: 'static' | 'reliability-aware';
  modelPins?: Record<string, string>;
}

/**
 * RuntimeSettings panel — Batch 2 truth surface.
 *
 * Every toggle here calls POST /api/settings/runtime, persists to
 * ~/.agentx/runtime-settings.json, and (for live toggles) applies on the
 * NEXT chat call without restart. Restart-required keys show a clear note.
 */
export function RuntimeSettings() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const r = await fetch('/api/settings/runtime');
      const data = await r.json();
      if (data.available && data.settings) setSettings(data.settings);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  };

  useEffect(() => { load(); }, []);

  const apply = async (patch: Partial<Settings>) => {
    setBusy(true);
    setNote(null);
    try {
      const r = await fetch('/api/settings/runtime', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || 'Update failed');
      setSettings(data.settings);
      if (data.note) setNote(data.note);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const reset = async () => {
    if (!confirm('Reset all runtime settings to defaults?')) return;
    setBusy(true);
    try {
      const r = await fetch('/api/settings/runtime', { method: 'DELETE' });
      const data = await r.json();
      setSettings(data.settings);
    } finally { setBusy(false); }
  };

  const Toggle = ({
    label, value, onChange, hint,
  }: { label: string; value: boolean; onChange: (v: boolean) => void; hint?: string }) => (
    <label style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 0', cursor: 'pointer', borderBottom: '1px solid var(--border-primary)' }}>
      <div style={{ minWidth: 0, flex: '1 1 auto' }}>
        <div style={{ fontSize: '12px', fontWeight: 600 }}>{label}</div>
        {hint && <div style={{ fontSize: '10px', color: 'var(--text-secondary)' }}>{hint}</div>}
      </div>
      <input
        type="checkbox"
        checked={value}
        disabled={busy}
        onChange={(e) => onChange(e.target.checked)}
        style={{ flex: '0 0 auto', marginLeft: '8px' }}
      />
    </label>
  );

  return (
    <div style={{ padding: 'var(--spacing-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 'var(--spacing-md)' }}>
        <h3 style={{ margin: 0, fontSize: '14px', color: 'var(--accent-cyan)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
          Runtime Settings
        </h3>
        <button
          onClick={reset}
          disabled={busy}
          style={{ fontSize: '11px', padding: '4px 8px', background: 'transparent', border: '1px solid #f8544466', borderRadius: '4px', color: '#f85444', cursor: 'pointer' }}
        >
          Reset
        </button>
      </div>

      {error && (
        <div style={{ marginBottom: 'var(--spacing-md)', padding: '8px', background: '#f8544422', border: '1px solid #f85444', borderRadius: '4px', color: '#f85444', fontSize: '12px' }}>
          {error}
        </div>
      )}
      {note && (
        <div style={{ marginBottom: 'var(--spacing-md)', padding: '8px', background: '#d2992222', border: '1px solid #d29922', borderRadius: '4px', color: '#d29922', fontSize: '12px' }}>
          {note}
        </div>
      )}

      {!settings ? (
        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>Loading…</div>
      ) : (
        <>
          <Toggle label="localOnly" hint="Block all network-class tools and cloud providers (applies next call)"
            value={settings.localOnly} onChange={(v) => apply({ localOnly: v })} />
          <Toggle label="Retrieval enabled" hint="Inject memory/document context before model call (applies next call)"
            value={settings.retrievalEnabled} onChange={(v) => apply({ retrievalEnabled: v })} />
          <Toggle label="Tool-calling enabled" hint="Allow the LLM to invoke tools (applies next call)"
            value={settings.toolCallingEnabled} onChange={(v) => apply({ toolCallingEnabled: v })} />
          <Toggle label="Reliability-aware routing" hint="Demote tools with <50% success in last 10 calls (applies next call)"
            value={settings.autoRoutingMode === 'reliability-aware'}
            onChange={(v) => apply({ autoRoutingMode: v ? 'reliability-aware' : 'static' })} />
          <Toggle label="BuilderV2" hint="Multi-agent build pipeline (restart required)"
            value={settings.builderV2Enabled} onChange={(v) => apply({ builderV2Enabled: v })} />
          <Toggle label="Agent Loops" hint="Autonomous goal-driven loops (restart required)"
            value={settings.agentLoopsEnabled} onChange={(v) => apply({ agentLoopsEnabled: v })} />

          <div style={{ padding: '8px 0', borderTop: '1px solid var(--border-primary)', marginTop: '8px' }}>
            <div style={{ fontSize: '12px', fontWeight: 600, marginBottom: '4px' }}>Repair policy</div>
            <select
              value={settings.repairPolicy}
              disabled={busy}
              onChange={(e) => apply({ repairPolicy: e.target.value as Settings['repairPolicy'] })}
              style={{ width: '100%', padding: '4px', background: 'var(--bg-primary)', border: '1px solid var(--border-primary)', borderRadius: '4px', color: 'var(--text-primary)', fontSize: '12px' }}
            >
              <option value="auto-safe">Auto-safe (run idempotent repairs)</option>
              <option value="always-ask">Always ask before any repair</option>
              <option value="never">Never auto-repair</option>
            </select>
          </div>
        </>
      )}
    </div>
  );
}
