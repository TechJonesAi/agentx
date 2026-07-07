import React, { useState, useEffect } from 'react';
import '../styles/Pages.css';

type FeatureName = 'builderV2' | 'buildLearning' | 'projectWorkflows' | 'toolCallEvaluator' | 'otelTracing' | 'otelContentTracing';

const FEATURE_LABELS: Record<FeatureName, string> = {
  builderV2: 'Builder V2',
  buildLearning: 'Build Learning',
  projectWorkflows: 'Project Workflows',
  toolCallEvaluator: 'Tool-Call Evaluator',
  otelTracing: 'OpenTelemetry Tracing',
  otelContentTracing: 'OTel Content Capture',
};

const FEATURE_DESCRIPTIONS: Record<FeatureName, string> = {
  builderV2: 'Use the BuilderV2 app-generation pipeline instead of the legacy chat-based build path. Turn off to fall back to legacy behaviour.',
  buildLearning: 'Bias model routing using BuildIntelligence recommendations. AgentX learns which models work best and reranks the fallback chain accordingly.',
  projectWorkflows: 'Record execution runs in the Projects tab. Turn off to stop collecting automation_runs data.',
  toolCallEvaluator: 'After each chat turn that used tools, run a tiny background critic that scores tool-call quality (tool selection, argument quality, grounding). Weak scores are recorded in the performance store and drift the weak model down the routing chain. Fire-and-forget — zero user-visible latency.',
  otelTracing: 'Emit OpenTelemetry GenAI-conventioned spans for every LLM call, tool execution, and subagent run. Spans stay in-process unless you set OTEL_EXPORTER_OTLP_ENDPOINT (typically http://localhost:6006/v1/traces for Arize Phoenix — fully local). Off by default.',
  otelContentTracing: 'When also on, OTel spans include prompt and tool-argument content. Useful for debugging but more privacy-sensitive. Requires Tracing to be on.',
};

/**
 * A row with a label, a one-line description, and a toggle switch that
 * posts the change to /api/config immediately (no explicit Save required).
 */
function FeaturesCard({
  features,
  onToggle,
}: {
  features: Partial<Record<FeatureName, boolean>>;
  onToggle: (name: FeatureName, value: boolean) => void | Promise<void>;
}) {
  return (
    <div className="content-card" style={{ marginBottom: 'var(--spacing-lg)' }}>
      <div className="content-card-title">Features</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
        {(Object.keys(FEATURE_LABELS) as FeatureName[]).map((name) => {
          const enabled = features[name] !== false; // default = enabled
          return (
            <div
              key={name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--spacing-md)',
                padding: 'var(--spacing-md)',
                background: 'var(--bg-tertiary)',
                borderRadius: 'var(--radius-md)',
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{FEATURE_LABELS[name]}</div>
                <div style={{ fontSize: 'var(--text-xs, 12px)', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                  {FEATURE_DESCRIPTIONS[name]}
                </div>
              </div>
              <ToggleSwitch
                checked={enabled}
                onChange={(v) => onToggle(name, v)}
                ariaLabel={FEATURE_LABELS[name]}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Tiny accessible toggle switch. Pure CSS — no dependency on shadcn/headlessui.
 */
function ToggleSwitch({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      style={{
        position: 'relative',
        width: 48,
        height: 26,
        borderRadius: 13,
        background: checked ? '#10b981' : '#6b7280',
        border: 'none',
        cursor: 'pointer',
        padding: 0,
        transition: 'background 160ms',
        flexShrink: 0,
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: checked ? 25 : 3,
          width: 20,
          height: 20,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left 160ms',
          boxShadow: '0 2px 4px rgba(0,0,0,0.25)',
        }}
      />
    </button>
  );
}

export function Settings() {
  const [config, setConfig] = useState<any>(null);
  const [editConfig, setEditConfig] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState('');
  /**
   * Available local models (from /api/models/routing) for the Default Model
   * dropdown, plus the current forceModel override. When forceModel is null,
   * the UI shows "Auto (AgentX chooses)" as the selected option — meaning
   * normal capability-based routing applies.
   */
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [forceModel, setForceModel] = useState<string | null>(null);

  useEffect(() => {
    const fetchConfig = async () => {
      try {
        const res = await fetch('/api/config');
        const data = await res.json();
        setConfig(data);
        setEditConfig(data);
      } catch {
        // No fake fallback — config stays null, loading completes
      } finally {
        setLoading(false);
      }
    };

    const fetchRouting = async () => {
      try {
        const res = await fetch('/api/models/routing');
        if (!res.ok) return;
        const data = await res.json();
        // API shape: { policy: { mode, forceModel? }, availableModels: [{name, size}] }
        // (the old data.models/privacyLevel shape no longer exists — the
        // dropdown rendered empty and overrides were impossible to set).
        const models = (data.availableModels ?? [])
          .map((m: { name?: string }) => m.name)
          .filter((n: string | undefined): n is string => !!n);
        setAvailableModels(models);
        const fm = data.policy?.forceModel;
        setForceModel(typeof fm === 'string' && fm.length > 0 ? fm : null);
      } catch { /* non-critical */ }
    };

    fetchConfig();
    fetchRouting();
  }, []);

  /** Persist the Default Model selection and let the Header badge know. */
  const handleForceModelChange = async (nextValue: string) => {
    const newValue = nextValue === 'auto' || nextValue === '' ? null : nextValue;
    setSaving(true);
    setSaveMessage('');
    try {
      const res = await fetch('/api/models/routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ forceModel: newValue }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      const savedFm = data.policy?.forceModel;
      setForceModel(typeof savedFm === 'string' && savedFm.length > 0 ? savedFm : null);
      setSaveMessage(newValue ? `Default model set to ${newValue}. AgentX will use this for every request.` : 'Default model cleared — AgentX routing is back on Auto.');
      // Nudge the Header model-badge to re-poll. Not strictly needed (it
      // already polls every 5s) but makes the change feel instant.
      try { window.dispatchEvent(new CustomEvent('agentx:chat-complete')); } catch { /* */ }
      setTimeout(() => setSaveMessage(''), 4000);
    } catch (err) {
      setSaveMessage(`Failed to set default model: ${err instanceof Error ? err.message : 'unknown'}`);
    } finally {
      setSaving(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveMessage('');
    try {
      const res = await fetch('/api/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          agent: {
            model: editConfig?.agent?.model,
            defaultProvider: editConfig?.agent?.defaultProvider,
          },
        }),
      });
      if (!res.ok) throw new Error('Failed to save');
      const data = await res.json();
      setConfig(editConfig);
      setIsEditing(false);
      setSaveMessage('Settings saved successfully!');
      setTimeout(() => setSaveMessage(''), 3000);
    } catch (err) {
      setSaveMessage('Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1>Settings</h1>
        </div>
        <div style={{ textAlign: 'center', padding: 'var(--spacing-2xl)' }}>
          <div className="spinner" />
        </div>
      </div>
    );
  }

  if (!config) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1>Settings</h1>
          <p>Configure AgentX behavior and features</p>
        </div>
        <div className="content-card" style={{ textAlign: 'center', padding: 'var(--spacing-2xl)' }}>
          <div style={{ color: 'var(--text-secondary)' }}>Unable to load configuration. Server may be unavailable.</div>
        </div>
      </div>
    );
  }

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Settings</h1>
        <p>Configure AgentX behavior and features</p>
        <div style={{ marginTop: 'var(--spacing-md)', display: 'flex', gap: 'var(--spacing-sm)' }}>
          {!isEditing ? (
            <button
              onClick={() => setIsEditing(true)}
              style={{
                background: 'var(--color-primary)',
                color: 'white',
                border: 'none',
                padding: '8px 16px',
                borderRadius: 'var(--radius-md)',
                cursor: 'pointer',
                fontWeight: '500',
              }}
            >
              Edit Settings
            </button>
          ) : (
            <>
              <button
                onClick={handleSave}
                disabled={saving}
                style={{
                  background: '#10b981',
                  color: 'white',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: 'var(--radius-md)',
                  cursor: saving ? 'not-allowed' : 'pointer',
                  fontWeight: '500',
                  opacity: saving ? 0.6 : 1,
                }}
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
              <button
                onClick={() => {
                  setIsEditing(false);
                  setEditConfig(config);
                  setSaveMessage('');
                }}
                style={{
                  background: 'var(--bg-tertiary)',
                  color: 'var(--text-primary)',
                  border: 'none',
                  padding: '8px 16px',
                  borderRadius: 'var(--radius-md)',
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
            </>
          )}
        </div>
        {saveMessage && (
          <div
            style={{
              marginTop: 'var(--spacing-sm)',
              padding: 'var(--spacing-sm)',
              background: saveMessage.includes('successfully') ? '#10b98122' : '#f8544422',
              color: saveMessage.includes('successfully') ? '#10b981' : '#f85444',
              borderRadius: 'var(--radius-md)',
              fontSize: 'var(--text-sm)',
            }}
          >
            {saveMessage}
          </div>
        )}
      </div>

      <div style={{ maxWidth: '600px', margin: '0 auto' }}>
        {/* Agent Configuration */}
        <div className="content-card" style={{ marginBottom: 'var(--spacing-lg)' }}>
          <div className="content-card-title">Agent Configuration</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
            <div>
              <label style={{ display: 'block', marginBottom: 'var(--spacing-sm)', color: 'var(--text-secondary)', fontWeight: 'bold', fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Agent Name
              </label>
              <input
                type="text"
                value={editConfig?.agent?.name || ''}
                disabled={!isEditing}
                onChange={(e) => setEditConfig({ ...editConfig, agent: { ...editConfig.agent, name: e.target.value } })}
                style={{ opacity: isEditing ? 1 : 0.6 }}
              />
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 'var(--spacing-sm)', color: 'var(--text-secondary)', fontWeight: 'bold', fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Default Model
              </label>
              <select
                value={forceModel ?? 'auto'}
                disabled={saving}
                onChange={(e) => handleForceModelChange(e.target.value)}
                style={{
                  width: '100%',
                  padding: 'var(--spacing-sm) var(--spacing-md)',
                  background: forceModel ? '#f0883e22' : 'var(--bg-secondary, #1e1e2e)',
                  color: 'var(--text-primary)',
                  border: `1px solid ${forceModel ? '#f0883e66' : 'var(--border-primary, #333)'}`,
                  borderRadius: 'var(--radius-md, 6px)',
                  fontSize: 'var(--text-md, 14px)',
                  fontFamily: 'monospace',
                  cursor: saving ? 'wait' : 'pointer',
                }}
              >
                <option value="auto">Auto — AgentX chooses per task (recommended)</option>
                {availableModels.map((m) => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
              <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: 'var(--spacing-xs)', lineHeight: 1.5 }}>
                {forceModel ? (
                  <>
                    <strong style={{ color: '#f0883e' }}>Override active:</strong>{' '}
                    Every chat uses <code>{forceModel}</code>. AgentX's routing, capability pins, and auto-escalation are bypassed. Choose <em>Auto</em> to restore smart routing.
                  </>
                ) : (
                  <>AgentX picks the best model per task automatically. Pick a specific model above to force every chat to use it.</>
                )}
              </div>
            </div>
            <div>
              <label style={{ display: 'block', marginBottom: 'var(--spacing-sm)', color: 'var(--text-secondary)', fontWeight: 'bold', fontSize: 'var(--text-sm)', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                Default Provider
              </label>
              <input
                type="text"
                value={editConfig?.agent?.defaultProvider || ''}
                disabled={!isEditing}
                onChange={(e) => setEditConfig({ ...editConfig, agent: { ...editConfig.agent, defaultProvider: e.target.value } })}
                style={{ opacity: isEditing ? 1 : 0.6 }}
              />
            </div>
          </div>
        </div>

        {/* Features */}
        <FeaturesCard
          features={config?.features ?? {}}
          onToggle={async (name, value) => {
            try {
              const res = await fetch('/api/config', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ features: { [name]: value } }),
              });
              if (!res.ok) throw new Error(`${res.status}`);
              const data = await res.json();
              setConfig((prev: any) => ({ ...(prev ?? {}), features: data.features }));
              setEditConfig((prev: any) => ({ ...(prev ?? {}), features: data.features }));
              setSaveMessage(`${FEATURE_LABELS[name]} ${value ? 'enabled' : 'disabled'}`);
              setTimeout(() => setSaveMessage(''), 3000);
            } catch (err) {
              setSaveMessage(`Failed to toggle ${FEATURE_LABELS[name]}`);
            }
          }}
        />

        {/* System Info */}
        <div className="content-card">
          <div className="content-card-title">System Information</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)', fontSize: 'var(--text-sm)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Version:</span>
              <code>0.1.0</code>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>API Version:</span>
              <code>v1</code>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Runtime:</span>
              <code>Node.js</code>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
