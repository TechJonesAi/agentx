import React, { useState, useEffect, useCallback } from 'react';
import '../styles/Pages.css';

interface RegisteredModelView {
  provider: string;
  model: string;
  capabilities: string[];
  privacyLevel: string;
  costPerMToken?: number;
  avgLatencyMs?: number;
  enabled?: boolean;
  parameterSize?: string;
  family?: string;
  specialization?: string;
}

interface CapabilityRouting {
  model: string;
  provider: string;
  reason: string;
  score?: number;
  specialization?: string;
}

interface RoutingState {
  mode: string;
  config: {
    mode: string;
    localFirst: boolean;
    maxLocalFailuresBeforeCloud: number;
    allowCloudForLatencySensitiveTasks: boolean;
    latencySensitiveThresholdMs: number;
    capabilityPins?: Record<string, string>;
    contextOverflowTokens?: number;
  };
  capabilityPins?: Record<string, string>;
  models: RegisteredModelView[];
  fallbackChains?: Record<string, string[]>;
  capabilityRouting?: Record<string, CapabilityRouting | null>;
  performance?: {
    totalAggregateRecords: number;
    totalRunLogs: number;
    topModels: Array<{
      model: string;
      capability: string;
      success_count: number;
      failure_count: number;
      avg_latency_ms: number;
      success_pct: number;
    }>;
  } | null;
  diagnostics: {
    registry: {
      totalRegistered: number;
      enabledCount: number;
      localCount: number;
      cloudCount: number;
      byProvider: Record<string, number>;
      byCapability: Record<string, number>;
      bySpecialization?: Record<string, number>;
    };
    policy: {
      mode: string;
      cloudAllowed: boolean;
      [key: string]: unknown;
    };
  };
}

const SPEC_LABELS: Record<string, { label: string; color: string; icon: string }> = {
  code:             { label: 'Code',           color: '#58a6ff', icon: '💻' },
  vision:           { label: 'Vision',         color: '#d2a8ff', icon: '👁️' },
  voice:            { label: 'Voice',          color: '#3fb950', icon: '🎙️' },
  general:          { label: 'General',        color: '#d29922', icon: '🧠' },
  'deep-reasoning': { label: 'Deep Reasoning', color: '#f0883e', icon: '🔬' },
  embedding:        { label: 'Embedding',      color: '#8b949e', icon: '📐' },
};

const REASON_LABELS: Record<string, { label: string; color: string }> = {
  'voice_locked_to_qwen3_tts':              { label: '🔒 Locked',             color: '#3fb950' },
  'capability_pin':                         { label: '📌 Pinned',             color: '#f0883e' },
  'specialization_match':                   { label: '✓ Specialized',        color: '#3fb950' },
  'specialization_match_with_performance_data': { label: '✓ Specialized + Learned', color: '#58a6ff' },
  'performance_leader':                     { label: '📊 Best Performance',  color: '#d2a8ff' },
  'fallback_chain_position':                { label: '🔗 Chain Position',    color: '#d29922' },
  'chain:code':                             { label: '🔗 Chain (code)',      color: '#d29922' },
  'chain:text':                             { label: '🔗 Chain (text)',      color: '#d29922' },
  'chain:reasoning':                        { label: '🔗 Chain (reasoning)', color: '#d29922' },
  'chain:vision':                           { label: '🔗 Chain (vision)',    color: '#d29922' },
  'preferred':                              { label: '⭐ Preferred',          color: '#58a6ff' },
  'default':                                { label: 'Default',              color: 'var(--text-secondary)' },
};

interface ClaudeAuthStatus {
  connected: boolean;
  email?: string;
  expiresAt?: number;
  expiresInSec?: number;
  stale?: boolean;
  reason?: string;
}

export function Models() {
  const [routing, setRouting] = useState<RoutingState | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [claudeAuth, setClaudeAuth] = useState<ClaudeAuthStatus | null>(null);
  const [connecting, setConnecting] = useState(false);

  const fetchRouting = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/models/routing');
      if (res.ok) {
        const data = await res.json();
        setRouting(data);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchRouting(); }, [fetchRouting]);

  // ── Claude subscription auth ───────────────────────────────────────────
  const fetchClaudeStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/auth/claude/status');
      if (res.ok) setClaudeAuth(await res.json());
    } catch { /* non-critical */ }
  }, []);

  useEffect(() => { fetchClaudeStatus(); }, [fetchClaudeStatus]);

  // Poll every 2s while a Connect flow is in progress.
  useEffect(() => {
    if (!connecting) return;
    const timer = setInterval(async () => {
      try {
        const res = await fetch('/api/auth/claude/status');
        if (!res.ok) return;
        const status: ClaudeAuthStatus = await res.json();
        setClaudeAuth(status);
        if (status.connected) {
          setConnecting(false);
          setMessage(`Connected Claude account${status.email ? ` (${status.email})` : ''}`);
          fetchRouting();
        }
      } catch { /* keep polling */ }
    }, 2000);
    return () => clearInterval(timer);
  }, [connecting, fetchRouting]);

  const connectClaude = async () => {
    setConnecting(true);
    setMessage(null);
    try {
      const res = await fetch('/api/auth/claude/start', { method: 'POST' });
      const data = await res.json();
      if (!res.ok || !data.started) {
        setMessage(`Connect failed: ${data.error ?? res.statusText}`);
        setConnecting(false);
        return;
      }
      // The server already tried to open the browser; provide a manual fallback link.
      setMessage(`Authorize in the browser tab that just opened (or paste this URL): ${data.authUrl}`);
    } catch (err) {
      setMessage(`Connect failed: ${err instanceof Error ? err.message : 'network error'}`);
      setConnecting(false);
    }
  };

  const disconnectClaude = async () => {
    if (!confirm('Disconnect your Claude subscription? You will need to re-authorize to use it again.')) return;
    try {
      await fetch('/api/auth/claude/disconnect', { method: 'POST' });
      setMessage('Claude subscription disconnected');
      setClaudeAuth({ connected: false });
    } catch {
      setMessage('Disconnect failed');
    }
  };

  const setMode = async (mode: string) => {
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/models/routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json();
      if (data.saved) {
        setMessage(`Routing mode changed to ${mode}`);
        fetchRouting();
      } else {
        setMessage(`Failed: ${data.error ?? 'unknown'}`);
      }
    } catch {
      setMessage('Failed to update routing mode');
    } finally {
      setSaving(false);
    }
  };

  const setPin = async (capability: string, model: string) => {
    setSaving(true);
    setMessage(null);
    try {
      // Merge with existing pins — empty string / 'auto' means "remove pin"
      const current = { ...(routing?.capabilityPins ?? routing?.config?.capabilityPins ?? {}) };
      if (!model || model === 'auto') {
        delete current[capability];
      } else {
        current[capability] = model;
      }
      const res = await fetch('/api/models/routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ capabilityPins: current }),
      });
      const data = await res.json();
      if (data.saved) {
        setMessage(model && model !== 'auto' ? `Pinned ${capability} → ${model}` : `Cleared pin for ${capability}`);
        fetchRouting();
      } else {
        setMessage(`Failed: ${data.error ?? 'unknown'}`);
      }
    } catch {
      setMessage('Failed to update capability pin');
    } finally {
      setSaving(false);
    }
  };

  const currentMode = routing?.mode ?? 'LOCAL_ONLY';
  const localModels = routing?.models.filter(m => m.privacyLevel === 'local' && m.enabled !== false) ?? [];
  const cloudModels = routing?.models.filter(m => m.privacyLevel === 'cloud') ?? [];
  const embeddingModels = routing?.models.filter(m => m.specialization === 'embedding') ?? [];
  const capRouting = routing?.capabilityRouting ?? {};
  const chains = routing?.fallbackChains ?? {};
  const perf = routing?.performance;

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Models</h1>
        <p>Self-optimising local model routing — AgentX learns which model works best for each task</p>
      </div>

      {/* ─── Routing Mode Selector ──────────────────────────────────── */}
      <Panel title="Routing Mode">
        {message && (
          <div style={{
            padding: '6px 10px', marginBottom: '8px', fontSize: '12px',
            background: 'var(--bg-primary)', borderRadius: '4px',
            color: '#79c0ff', border: '1px solid var(--border-secondary)',
          }}>
            {message}
          </div>
        )}

        <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
          <button
            onClick={() => setMode('LOCAL_ONLY')}
            disabled={saving}
            style={{
              flex: 1, padding: '12px', cursor: saving ? 'wait' : 'pointer',
              background: currentMode === 'LOCAL_ONLY' ? '#238636' : 'var(--bg-tertiary)',
              border: currentMode === 'LOCAL_ONLY' ? '2px solid #3fb950' : '1px solid var(--border-primary)',
              borderRadius: '8px', color: '#fff', fontWeight: 600, fontSize: '13px',
              opacity: saving ? 0.6 : 1,
            }}
          >
            🏠 Local LLM
          </button>
          <button
            onClick={() => setMode('COMBINATION')}
            disabled={saving || !claudeAuth?.connected}
            title={claudeAuth?.connected ? '' : 'Connect your Claude subscription first (below) to enable Combination mode'}
            style={{
              flex: 1, padding: '12px', cursor: saving ? 'wait' : (!claudeAuth?.connected ? 'not-allowed' : 'pointer'),
              background: currentMode === 'COMBINATION' ? '#1f6feb' : 'var(--bg-tertiary)',
              border: currentMode === 'COMBINATION' ? '2px solid #58a6ff' : '1px solid var(--border-primary)',
              borderRadius: '8px', color: '#fff', fontWeight: 600, fontSize: '13px',
              opacity: (saving || !claudeAuth?.connected) ? 0.5 : 1,
            }}
          >
            🔀 Combination
          </button>
          <button
            onClick={() => setMode('SUBSCRIPTION_ONLY')}
            disabled={saving || !claudeAuth?.connected}
            title={claudeAuth?.connected ? '' : 'Connect your Claude subscription first (below) to enable Subscription mode'}
            style={{
              flex: 1, padding: '12px', cursor: saving ? 'wait' : (!claudeAuth?.connected ? 'not-allowed' : 'pointer'),
              background: currentMode === 'SUBSCRIPTION_ONLY' ? '#f0883e' : 'var(--bg-tertiary)',
              border: currentMode === 'SUBSCRIPTION_ONLY' ? '2px solid #f0883e' : '1px solid var(--border-primary)',
              borderRadius: '8px', color: '#fff', fontWeight: 600, fontSize: '13px',
              opacity: (saving || !claudeAuth?.connected) ? 0.5 : 1,
            }}
          >
            🔑 Subscription
          </button>
        </div>

        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
          {currentMode === 'LOCAL_ONLY' ? (
            <>
              <strong style={{ color: '#3fb950' }}>Local LLM Only</strong> — All tasks use your installed local models exclusively.
              Cloud APIs will never be called. AgentX intelligently selects the best local model per task
              and improves its routing decisions over time.
            </>
          ) : currentMode === 'COMBINATION' ? (
            <>
              <strong style={{ color: '#58a6ff' }}>Combination</strong> — Local LLM first; if the task isn't possible locally
              (after {routing?.config?.maxLocalFailuresBeforeCloud ?? 3} consecutive failures) <strong>or</strong> the context
              exceeds ~{Math.round((routing?.config?.contextOverflowTokens ?? 28000) / 1000)}k tokens, escalate to your
              connected Claude subscription. No pay-per-token API calls — usage counts against your Pro/Max plan quota only.
            </>
          ) : (
            <>
              <strong style={{ color: '#f0883e' }}>Subscription Only</strong> — All tasks route straight to your connected
              Claude subscription via OAuth. Local models are skipped. Usage counts against your Claude Pro/Max plan quota;
              no pay-per-token API billing.
            </>
          )}
        </div>

        {routing && (
          <div style={{
            display: 'flex', gap: '16px', flexWrap: 'wrap', marginTop: '12px',
            padding: '8px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', fontSize: '12px',
          }}>
            <span style={{ color: 'var(--text-secondary)' }}>
              Cloud fallback: <strong style={{ color: routing.diagnostics?.policy?.cloudAllowed ? '#d29922' : '#3fb950' }}>
                {routing.diagnostics?.policy?.cloudAllowed ? 'Allowed (last resort)' : 'Blocked'}
              </strong>
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>
              Local: <strong style={{ color: 'var(--text-primary)' }}>{routing.diagnostics?.registry?.localCount ?? 0}</strong>
            </span>
            <span style={{ color: 'var(--text-secondary)' }}>
              Cloud: <strong style={{ color: 'var(--text-primary)' }}>{routing.diagnostics?.registry?.cloudCount ?? 0}</strong>
            </span>
            {perf && (
              <span style={{ color: 'var(--text-secondary)' }}>
                Performance data: <strong style={{ color: '#d2a8ff' }}>{perf.totalRunLogs} runs</strong>
              </span>
            )}
          </div>
        )}
      </Panel>

      {/* ─── Subscription Accounts ─────────────────────────────────── */}
      <Panel title="Subscription Accounts">
        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '10px' }}>
          Connect a paid AI subscription account via OAuth. Usage counts against your plan quota (not per-token API billing). Combination mode falls back to Claude when local can't handle a task or the context exceeds local capacity.
        </div>

        {/* Claude row */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            padding: '12px',
            background: 'var(--bg-primary)',
            borderRadius: '6px',
            border: '1px solid var(--border-secondary)',
          }}
        >
          <div style={{ fontSize: '24px', width: '32px', textAlign: 'center' }}>🅰️</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '14px', fontWeight: 600, color: 'var(--text-primary)' }}>
              Claude
              <span style={{
                marginLeft: '8px', fontSize: '10px', padding: '2px 8px', borderRadius: '10px',
                background: claudeAuth?.connected ? '#10b98122' : '#6b728022',
                color: claudeAuth?.connected ? '#10b981' : '#6b7280',
                fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px',
              }}>
                {claudeAuth?.connected ? (claudeAuth.stale ? '⚠ Re-auth needed' : '✓ Connected') : 'Not connected'}
              </span>
            </div>
            <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              {claudeAuth?.connected ? (
                <>
                  {claudeAuth.email ? <>Account: <strong>{claudeAuth.email}</strong> · </> : null}
                  Uses subscription quota (no per-token API billing). OAuth token stored in macOS Keychain.
                </>
              ) : (
                <>Click Connect — a browser tab opens, you authorize access to your Claude Pro/Max account, tokens are stored securely in the macOS Keychain.</>
              )}
            </div>
          </div>
          {claudeAuth?.connected ? (
            <button
              onClick={disconnectClaude}
              style={{
                padding: '8px 16px', fontSize: '12px', fontWeight: 600,
                background: 'transparent', color: '#ef4444',
                border: '1px solid #ef444466', borderRadius: '6px',
                cursor: 'pointer', whiteSpace: 'nowrap',
              }}
            >
              Disconnect
            </button>
          ) : (
            <button
              onClick={connectClaude}
              disabled={connecting}
              style={{
                padding: '8px 18px', fontSize: '12px', fontWeight: 600,
                background: connecting ? 'var(--bg-tertiary)' : '#f0883e',
                color: '#fff', border: 'none', borderRadius: '6px',
                cursor: connecting ? 'wait' : 'pointer', whiteSpace: 'nowrap',
                opacity: connecting ? 0.6 : 1,
              }}
            >
              {connecting ? 'Waiting for authorization…' : 'Connect Claude'}
            </button>
          )}
        </div>

        <div style={{ marginTop: '10px', fontSize: '10px', color: 'var(--text-tertiary)', lineHeight: '1.6' }}>
          <strong>Note on ChatGPT:</strong> OpenAI does not officially support subscription-based programmatic access —
          ChatGPT Plus subscriptions can only be used via chat.openai.com. If you want OpenAI in Combination mode,
          set <code>OPENAI_API_KEY</code> — that's pay-per-token billing, not subscription-backed.
        </div>
      </Panel>

      {/* ─── Intelligent Task Routing ──────────────────────────────── */}
      <Panel title="Intelligent Task Routing">
        <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '10px' }}>
          AgentX automatically selects the best model per task. Use the dropdown to <strong>pin</strong> a capability to a specific model — the router will bypass its normal chain and always route that capability to your pick. Set back to "Auto" to restore learning-based routing.
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
          {(['code', 'vision', 'voice', 'text', 'reasoning'] as const).map(cap => {
            const route = capRouting[cap];
            const specColor = SPEC_LABELS[cap]?.color ?? '#d29922';
            const specIcon = SPEC_LABELS[cap]?.icon ?? '🧠';
            const reasonInfo = route ? (REASON_LABELS[route.reason] ?? REASON_LABELS.default) : null;
            const pinned = (routing?.capabilityPins ?? routing?.config?.capabilityPins ?? {})[cap] ?? '';
            // Eligible pin targets: local models only (cloud models excluded to avoid surprise escalations).
            const pinOptions = (routing?.models ?? [])
              .filter(m => m.privacyLevel === 'local' && m.enabled !== false)
              .map(m => m.model);
            return (
              <div key={cap} style={{
                padding: '10px', background: 'var(--bg-primary)', borderRadius: '6px',
                border: '1px solid var(--border-secondary)',
              }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{ fontSize: '11px', color: specColor, fontWeight: 700, textTransform: 'uppercase' }}>
                    {specIcon} {cap}
                  </span>
                  {reasonInfo && (
                    <span style={{ fontSize: '9px', color: reasonInfo.color, fontWeight: 600 }}>
                      {reasonInfo.label}
                    </span>
                  )}
                </div>
                <div style={{ fontSize: '12px', color: 'var(--text-primary)', fontFamily: 'monospace' }}>
                  {route?.model ?? 'No model available'}
                </div>
                {route?.score !== undefined && route.score !== 50 && (
                  <div style={{ fontSize: '10px', color: '#d2a8ff', marginTop: '2px' }}>
                    Score: {route.score.toFixed(1)}
                  </div>
                )}
                <div style={{ marginTop: '8px', display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <label style={{ fontSize: '10px', color: 'var(--text-tertiary)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Pin:</label>
                  <select
                    value={pinned || 'auto'}
                    disabled={saving}
                    onChange={(e) => setPin(cap, e.target.value)}
                    style={{
                      flex: 1,
                      fontSize: '11px',
                      padding: '3px 6px',
                      background: pinned ? '#f0883e22' : 'var(--bg-tertiary, #30363d)',
                      color: 'var(--text-primary)',
                      border: `1px solid ${pinned ? '#f0883e66' : 'var(--border-secondary)'}`,
                      borderRadius: '4px',
                      fontFamily: 'monospace',
                      cursor: saving ? 'wait' : 'pointer',
                    }}
                  >
                    <option value="auto">Auto (learn)</option>
                    {pinOptions.map(m => <option key={m} value={m}>{m}</option>)}
                  </select>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* ─── Fallback Chains ───────────────────────────────────────── */}
      {Object.keys(chains).length > 0 && (
        <Panel title="Fallback Chains">
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '10px' }}>
            When the primary model fails, AgentX falls back through these chains before giving up (or escalating to cloud).
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '8px' }}>
            {Object.entries(chains).map(([cap, chain]) => {
              const specColor = SPEC_LABELS[cap]?.color ?? '#d29922';
              return (
                <div key={cap} style={{
                  padding: '8px', background: 'var(--bg-primary)', borderRadius: '6px',
                  border: '1px solid var(--border-secondary)',
                }}>
                  <div style={{ fontSize: '10px', color: specColor, fontWeight: 700, textTransform: 'uppercase', marginBottom: '4px' }}>
                    {cap}
                  </div>
                  {chain.map((model, i) => (
                    <div key={model} style={{
                      fontSize: '11px', fontFamily: 'monospace',
                      color: i === 0 ? 'var(--text-primary)' : 'var(--text-tertiary)',
                      paddingLeft: i > 0 ? '8px' : '0',
                    }}>
                      {i === 0 ? '→ ' : '↳ '}{model}
                    </div>
                  ))}
                  {cap === 'voice' && (
                    <div style={{ fontSize: '9px', color: '#3fb950', marginTop: '4px', fontWeight: 600 }}>
                      🔒 Locked — No fallback, no cloud
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {/* ─── Available Local Models (from Ollama) ──────────────────── */}
      {localModels.length > 0 && (
        <Panel title={`Available Local Models (${localModels.length})`}>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>
            Dynamically discovered from Ollama. All models can attempt any task — specialization guides selection.
          </div>
          {localModels.map((m, i) => {
            const spec = SPEC_LABELS[m.specialization ?? 'general'] ?? SPEC_LABELS.general;
            return (
              <div key={i} style={{
                display: 'flex', gap: '10px', alignItems: 'center',
                padding: '8px 0', borderBottom: '1px solid var(--border-secondary)',
                fontSize: '12px',
              }}>
                <span style={{
                  padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                  background: spec.color + '22', color: spec.color, minWidth: '55px', textAlign: 'center',
                }}>
                  {spec.icon} {spec.label}
                </span>
                <span style={{ color: '#d2a8ff', fontFamily: 'monospace', fontWeight: 600, minWidth: '200px' }}>
                  {m.model}
                </span>
                {m.parameterSize && (
                  <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', minWidth: '55px' }}>
                    {m.parameterSize}
                  </span>
                )}
                {m.family && (
                  <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', minWidth: '70px' }}>
                    {m.family}
                  </span>
                )}
                <span style={{ color: 'var(--text-secondary)', flex: 1, fontSize: '11px' }}>
                  {m.capabilities.join(', ')}
                </span>
                <span style={{ color: '#3fb950', fontSize: '11px', fontWeight: 600 }}>
                  Free
                </span>
              </div>
            );
          })}
        </Panel>
      )}

      {/* ─── Performance Learning ──────────────────────────────────── */}
      {perf && perf.topModels.length > 0 && (
        <Panel title={`Performance Learning (${perf.totalRunLogs} runs)`}>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>
            AgentX learns from every model run. Models with higher success rates are preferred for future routing.
          </div>
          {perf.topModels.map((m, i) => {
            const pct = m.success_pct;
            const total = m.success_count + m.failure_count;
            return (
              <div key={i} style={{
                display: 'flex', gap: '10px', alignItems: 'center',
                padding: '6px 0', borderBottom: '1px solid var(--border-secondary)',
                fontSize: '12px',
              }}>
                <span style={{ color: 'var(--text-primary)', fontFamily: 'monospace', minWidth: '200px' }}>
                  {m.model}
                </span>
                <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', minWidth: '70px' }}>
                  [{m.capability}]
                </span>
                <div style={{
                  flex: 1, height: '8px', background: 'var(--bg-tertiary)',
                  borderRadius: '4px', overflow: 'hidden', minWidth: '100px',
                }}>
                  <div style={{
                    height: '100%', width: `${pct}%`,
                    background: pct >= 80 ? '#3fb950' : pct >= 50 ? '#d29922' : '#f85149',
                    borderRadius: '4px',
                  }} />
                </div>
                <span style={{
                  fontSize: '11px', fontWeight: 600, minWidth: '50px', textAlign: 'right',
                  color: pct >= 80 ? '#3fb950' : pct >= 50 ? '#d29922' : '#f85149',
                }}>
                  {pct.toFixed(0)}%
                </span>
                <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', minWidth: '60px' }}>
                  {total} runs
                </span>
                <span style={{ fontSize: '10px', color: 'var(--text-tertiary)', minWidth: '60px' }}>
                  {m.avg_latency_ms.toFixed(0)}ms
                </span>
              </div>
            );
          })}
        </Panel>
      )}

      {/* ─── Cloud Models ──────────────────────────────────────────── */}
      {cloudModels.length > 0 && (
        <Panel title={`Cloud Models (${cloudModels.length})`}>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>
            {currentMode === 'LOCAL_ONLY'
              ? 'Cloud models are registered but will NOT be used in Local LLM mode.'
              : 'Used only as last resort after local models fail.'}
          </div>
          {cloudModels.map((m, i) => (
            <div key={i} style={{
              display: 'flex', gap: '10px', alignItems: 'center',
              padding: '8px 0', borderBottom: '1px solid var(--border-secondary)',
              fontSize: '12px', opacity: currentMode === 'LOCAL_ONLY' ? 0.5 : 1,
            }}>
              <span style={{
                padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                background: '#1f6feb22', color: '#58a6ff',
              }}>
                ☁️ Cloud
              </span>
              <span style={{ color: '#d2a8ff', fontFamily: 'monospace', fontWeight: 600 }}>
                {m.provider}:{m.model}
              </span>
              <span style={{ color: 'var(--text-secondary)', flex: 1, fontSize: '11px' }}>
                {m.capabilities.join(', ')}
              </span>
              <span style={{ color: '#f85149', fontSize: '11px' }}>
                ${m.costPerMToken}/MT
              </span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>
                {m.avgLatencyMs ?? '?'}ms
              </span>
            </div>
          ))}
        </Panel>
      )}

      {/* ─── Embedding Models ──────────────────────────────────────── */}
      {embeddingModels.length > 0 && (
        <Panel title={`Embedding Models (${embeddingModels.length})`}>
          <div style={{ fontSize: '11px', color: 'var(--text-tertiary)', marginBottom: '8px' }}>
            Embedding models are used for memory/search, not for completions.
          </div>
          {embeddingModels.map((m, i) => (
            <div key={i} style={{
              display: 'flex', gap: '10px', alignItems: 'center',
              padding: '6px 0', fontSize: '12px', opacity: 0.6,
            }}>
              <span style={{
                padding: '2px 8px', borderRadius: '6px', fontSize: '10px', fontWeight: 700,
                background: '#8b949e22', color: '#8b949e',
              }}>
                📐 Embed
              </span>
              <span style={{ color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                {m.model}
              </span>
              {m.parameterSize && (
                <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>
                  {m.parameterSize}
                </span>
              )}
            </div>
          ))}
        </Panel>
      )}
    </div>
  );
}

// ─── Shared Panel component ─────────────────────────────────────────────

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)',
      borderRadius: 'var(--radius-lg)',
      padding: 'var(--spacing-md)',
      marginBottom: 'var(--spacing-md)',
    }}>
      <div style={{
        fontSize: '13px', color: 'var(--color-primary)', fontWeight: 600,
        marginBottom: '10px', borderBottom: '1px solid var(--border-secondary)',
        paddingBottom: '6px',
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}
