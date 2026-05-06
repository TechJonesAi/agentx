import React, { useState, useEffect } from 'react';
import '../styles/Pages.css';

interface Permission {
  type: string;
  granted: boolean;
}

interface Tool {
  name: string;
  version: string;
  description: string;
  enabled: boolean;
  type: 'built-in' | 'user';
  testable: boolean;
  permissions: Permission[];
}

interface TestResult {
  success: boolean;
  output: string;
  duration_ms: number;
}

export function Tools() {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingName, setTogglingName] = useState<string | null>(null);
  const [testingName, setTestingName] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<Record<string, TestResult>>({});

  const fetchTools = async () => {
    try {
      const response = await fetch('/api/skills');
      if (!response.ok) {
        throw new Error(`Failed to load tools: ${response.statusText}`);
      }
      const data = await response.json();
      // Backend returns { skills: [...] } — accept both shapes for safety
      const list: Tool[] = Array.isArray(data) ? data : (Array.isArray(data?.skills) ? data.skills : []);
      setTools(list);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load tools';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchTools(); }, []);

  const toggle = async (name: string) => {
    setTogglingName(name);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}/toggle`, { method: 'POST' });
      if (!res.ok) throw new Error(`Toggle failed: ${res.statusText}`);
      const data = await res.json();
      setTools(prev => prev.map(t => t.name === name ? { ...t, enabled: !!data.enabled } : t));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Toggle failed');
    } finally {
      setTogglingName(null);
    }
  };

  const test = async (name: string) => {
    setTestingName(name);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}/test`, { method: 'POST' });
      const data = await res.json();
      setTestResult(prev => ({ ...prev, [name]: { success: !!data.success, output: String(data.output ?? ''), duration_ms: Number(data.duration_ms ?? 0) } }));
    } catch (err) {
      setTestResult(prev => ({ ...prev, [name]: { success: false, output: err instanceof Error ? err.message : String(err), duration_ms: 0 } }));
    } finally {
      setTestingName(null);
    }
  };

  const removeSkill = async (name: string) => {
    if (!confirm(`Delete user skill "${name}"? This cannot be undone.`)) return;
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Delete failed: ${res.statusText}`);
      }
      await fetchTools();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1>Tools</h1>
          <p>Available capabilities and integrations</p>
        </div>
        <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center' }}>
          <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Loading tools...</div>
        </div>
      </div>
    );
  }

  const builtInCount = tools.filter(t => t.type === 'built-in').length;
  const userCount = tools.filter(t => t.type === 'user').length;
  const enabledCount = tools.filter(t => t.enabled).length;

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Tools</h1>
        <p>Available capabilities and integrations</p>
      </div>

      {error && (
        <div
          style={{
            maxWidth: '900px',
            margin: '0 auto var(--spacing-lg)',
            padding: 'var(--spacing-md)',
            background: '#f8544422',
            border: '1px solid #f85444',
            borderRadius: 'var(--radius-md)',
            color: '#f85444',
            fontSize: 'var(--text-sm)',
          }}
        >
          ⚠️ {error}
        </div>
      )}

      {/* Summary bar */}
      <div style={{ maxWidth: '900px', margin: '0 auto var(--spacing-lg)', display: 'flex', gap: '12px', flexWrap: 'wrap' }}>
        <div style={{ padding: '6px 12px', background: 'var(--bg-secondary)', borderRadius: '6px', border: '1px solid var(--border-primary)', fontSize: '12px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Total </span>
          <strong>{tools.length}</strong>
        </div>
        <div style={{ padding: '6px 12px', background: 'var(--bg-secondary)', borderRadius: '6px', border: '1px solid var(--border-primary)', fontSize: '12px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>Built-in </span>
          <strong>{builtInCount}</strong>
        </div>
        <div style={{ padding: '6px 12px', background: 'var(--bg-secondary)', borderRadius: '6px', border: '1px solid var(--border-primary)', fontSize: '12px' }}>
          <span style={{ color: 'var(--text-secondary)' }}>User </span>
          <strong>{userCount}</strong>
        </div>
        <div style={{ padding: '6px 12px', background: '#10b98122', borderRadius: '6px', border: '1px solid #10b98144', fontSize: '12px', color: '#10b981' }}>
          <strong>{enabledCount}</strong> enabled
        </div>
      </div>

      <div style={{ maxWidth: '900px', margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
        {tools.map((tool) => {
          const result = testResult[tool.name];
          const isToggling = togglingName === tool.name;
          const isTesting = testingName === tool.name;
          return (
            <div
              key={tool.name}
              style={{
                padding: 'var(--spacing-md)',
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-md)',
                border: '1px solid var(--border-primary)',
                opacity: tool.enabled ? 1 : 0.7,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  marginBottom: '6px',
                  gap: '10px',
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flex: '1 1 220px', minWidth: 0, flexWrap: 'wrap' }}>
                  <strong style={{ fontSize: '14px', wordBreak: 'break-word' }}>{tool.name}</strong>
                  <span
                    style={{
                      fontSize: '10px',
                      padding: '2px 8px',
                      borderRadius: '10px',
                      background: tool.type === 'built-in' ? '#58a6ff22' : '#8b5cf622',
                      color: tool.type === 'built-in' ? '#58a6ff' : '#8b5cf6',
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.5px',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {tool.type}
                  </span>
                  <span style={{ fontSize: '11px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>v{tool.version}</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, flexWrap: 'wrap' }}>
                  {tool.testable && (
                    <button
                      onClick={() => test(tool.name)}
                      disabled={isTesting || !tool.enabled}
                      title={tool.enabled ? 'Run a safe self-test' : 'Enable the skill first'}
                      style={{
                        padding: '4px 10px',
                        fontSize: '11px',
                        background: 'transparent',
                        color: 'var(--text-secondary)',
                        border: '1px solid var(--border-primary)',
                        borderRadius: '4px',
                        cursor: isTesting || !tool.enabled ? 'not-allowed' : 'pointer',
                      }}
                    >
                      {isTesting ? 'Testing...' : 'Test'}
                    </button>
                  )}
                  {tool.type === 'user' && (
                    <button
                      onClick={() => removeSkill(tool.name)}
                      title="Remove user skill"
                      style={{
                        padding: '4px 10px',
                        fontSize: '11px',
                        background: 'transparent',
                        color: '#ef4444',
                        border: '1px solid #ef444444',
                        borderRadius: '4px',
                        cursor: 'pointer',
                      }}
                    >
                      Delete
                    </button>
                  )}
                  <button
                    onClick={() => toggle(tool.name)}
                    disabled={isToggling}
                    title={tool.enabled ? 'Click to disable' : 'Click to enable'}
                    style={{
                      padding: '4px 12px',
                      fontSize: '11px',
                      fontWeight: 600,
                      background: tool.enabled ? '#10b98122' : '#ef444422',
                      color: tool.enabled ? '#10b981' : '#ef4444',
                      border: `1px solid ${tool.enabled ? '#10b98144' : '#ef444444'}`,
                      borderRadius: '4px',
                      cursor: isToggling ? 'wait' : 'pointer',
                      minWidth: '90px',
                    }}
                  >
                    {isToggling ? '...' : tool.enabled ? '✓ Enabled' : '✗ Disabled'}
                  </button>
                </div>
              </div>

              <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                {tool.description}
              </div>

              {tool.permissions && tool.permissions.length > 0 && (
                <div style={{ marginTop: '8px', display: 'flex', gap: '6px', flexWrap: 'wrap' }}>
                  {tool.permissions.map((p, i) => (
                    <span
                      key={i}
                      style={{
                        fontSize: '10px',
                        padding: '2px 8px',
                        borderRadius: '10px',
                        background: p.granted ? '#10b98122' : '#d2992222',
                        color: p.granted ? '#10b981' : '#d29922',
                        border: `1px solid ${p.granted ? '#10b98144' : '#d2992244'}`,
                        fontWeight: 600,
                      }}
                    >
                      {p.granted ? '✓' : '!'} {p.type}
                    </span>
                  ))}
                </div>
              )}

              {result && (
                <div
                  style={{
                    marginTop: '10px',
                    padding: '8px 10px',
                    borderRadius: '4px',
                    background: result.success ? '#1f3a2e' : '#3d1f1f',
                    border: `1px solid ${result.success ? '#3fb95044' : '#f8514944'}`,
                    fontSize: '12px',
                    fontFamily: 'monospace',
                    color: result.success ? '#3fb950' : '#f85149',
                  }}
                >
                  <div style={{ fontWeight: 600, marginBottom: '4px' }}>
                    {result.success ? '✓ PASS' : '✗ FAIL'} · {result.duration_ms}ms
                  </div>
                  <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                    {result.output.slice(0, 500)}
                    {result.output.length > 500 ? '…' : ''}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div
        style={{
          maxWidth: '900px',
          margin: 'var(--spacing-lg) auto 0',
          padding: 'var(--spacing-lg)',
          background: 'var(--bg-secondary)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Tool Management</h3>
        <p style={{ lineHeight: '1.6', color: 'var(--text-secondary)' }}>
          Toggle a skill to enable or disable it — the change is persisted to the <code>skill_settings</code> table and applied immediately to the tool registry. Built-in skills can be disabled but not removed; user skills can be deleted entirely with the Delete button.
        </p>
      </div>

      {/* MCP Servers — external tool protocol (Model Context Protocol) */}
      <MCPServersPanel />

      {/* Device Control — Permission Center */}
      <div
        style={{
          maxWidth: '900px',
          margin: 'var(--spacing-lg) auto 0',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: 'var(--spacing-md)',
          }}
        >
          <div>
            <h2 style={{ fontSize: '20px', fontWeight: 600 }}>Device Control</h2>
            <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
              Manage computer control permissions — mouse, keyboard, screenshots, and app access
            </p>
          </div>
        </div>
        <div
          style={{
            background: 'var(--bg-secondary)',
            borderRadius: 'var(--radius-md)',
            border: '1px solid var(--border-primary)',
            overflow: 'hidden',
          }}
        >
          <iframe
            src="/api/device/permission-center"
            style={{
              width: '100%',
              minHeight: '700px',
              border: 'none',
              background: 'transparent',
            }}
            title="Device Control Permission Center"
          />
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────
// MCPServersPanel — inline React component.
//
// Lives on the Tools page (NOT a new tab, NOT a separate dashboard), between
// "Tool Management" and "Device Control". Same card styling, same toggle
// pattern as the Skills list above it.
//
// Key UX rules:
//   - Safety band badge per server: 🟢 green / 🟡 yellow / 🔴 red.
//   - Toggle enables/disables in-place; disabled server shows no tool count.
//   - Connection failures surface inline with the exact server-side error
//     string (e.g. the HTTPS allow-gate refusal).
//   - The "Allow remote servers" toggle has a red warning panel explaining
//     what it does before it can be flipped.
// ────────────────────────────────────────────────────────────────────────

interface MCPServerRow {
  name: string;
  enabled: boolean;
  connected: boolean;
  transport: 'stdio' | 'http';
  toolCount: number;
  safety: 'green' | 'yellow' | 'red';
  lastError: string | null;
  description?: string;
  command: string | null;
  args: string[];
  url: string | null;
  toolAllowlist?: string[] | null;
}

function MCPServersPanel() {
  const [servers, setServers] = useState<MCPServerRow[]>([]);
  const [allowRemote, setAllowRemote] = useState(false);
  const [mcpEnabled, setMcpEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const [togglingName, setTogglingName] = useState<string | null>(null);
  const [panelError, setPanelError] = useState<string | null>(null);

  const fetchServers = async () => {
    try {
      const res = await fetch('/api/mcp/servers');
      if (!res.ok) throw new Error(`${res.status}`);
      const data = await res.json();
      setServers(data.servers ?? []);
      setAllowRemote(!!data.allowRemote);
      setMcpEnabled(data.enabled !== false);
      setPanelError(null);
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Failed to load MCP servers');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { fetchServers(); }, []);

  const toggleServer = async (name: string, enabled: boolean) => {
    setTogglingName(name);
    try {
      const res = await fetch(`/api/mcp/servers/${encodeURIComponent(name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      await fetchServers();
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Toggle failed');
    } finally {
      setTogglingName(null);
    }
  };

  const toggleAllowRemote = async () => {
    const nextValue = !allowRemote;
    if (nextValue && !confirm(
      'Enabling remote MCP servers lets AgentX connect to third-party HTTPS endpoints that can see the prompts and arguments of any tool call routed through them.\n\nOnly turn this on if you trust every server URL you configure. A server restart is required for the change to take effect.\n\nProceed?'
    )) return;

    try {
      const res = await fetch('/api/mcp/allow-remote', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allowRemote: nextValue }),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      await fetchServers();
      setPanelError(nextValue
        ? 'Remote MCP transport enabled — restart server for the change to take effect.'
        : 'Remote MCP transport disabled — restart server to fully enforce.');
    } catch (err) {
      setPanelError(err instanceof Error ? err.message : 'Failed to update allowRemote');
    }
  };

  const safetyBadge = (band: 'green' | 'yellow' | 'red') => {
    const meta = {
      green:  { label: 'SAFE',     bg: '#10b98122', color: '#10b981', border: '#10b98144', title: 'Local stdio, zero network, maintained by Anthropic or reputable org.' },
      yellow: { label: 'OPT-IN',   bg: '#d2992222', color: '#d29922', border: '#d2992244', title: 'Uses a cloud API with your credentials — same exposure as the underlying SaaS.' },
      red:    { label: 'CAUTION',  bg: '#ef444422', color: '#ef4444', border: '#ef444444', title: 'Third-party hosted or unmaintained — audit before enabling.' },
    }[band];
    return (
      <span
        title={meta.title}
        style={{
          fontSize: '10px',
          fontWeight: 700,
          padding: '2px 8px',
          background: meta.bg,
          color: meta.color,
          border: `1px solid ${meta.border}`,
          borderRadius: '10px',
          letterSpacing: '0.5px',
          textTransform: 'uppercase',
        }}
      >
        {band === 'green' ? '🟢 ' : band === 'yellow' ? '🟡 ' : '🔴 '}{meta.label}
      </span>
    );
  };

  return (
    <div style={{ maxWidth: '900px', margin: 'var(--spacing-lg) auto 0' }}>
      <div style={{ marginBottom: 'var(--spacing-md)' }}>
        <h2 style={{ fontSize: '20px', fontWeight: 600 }}>MCP Servers</h2>
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', marginTop: '4px' }}>
          Plug external tools into AgentX via the Model Context Protocol. All servers are disabled by default. Local (stdio) servers stay fully offline — nothing leaves your Mac. Remote (HTTPS) transport is gated behind an explicit opt-in.
        </p>
      </div>

      {panelError && (
        <div style={{
          padding: 'var(--spacing-md)', marginBottom: 'var(--spacing-md)',
          background: '#f8544422', border: '1px solid #f85444', borderRadius: 'var(--radius-md)',
          color: '#f85444', fontSize: 'var(--text-sm)',
        }}>
          {panelError}
        </div>
      )}

      {/* Allow-remote master switch */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)',
        padding: 'var(--spacing-md)',
        background: allowRemote ? '#ef444411' : 'var(--bg-secondary)',
        border: `1px solid ${allowRemote ? '#ef444466' : 'var(--border-primary)'}`,
        borderRadius: 'var(--radius-md)', marginBottom: 'var(--spacing-md)',
      }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            Allow Remote (HTTPS) MCP Servers
            {allowRemote && (
              <span style={{
                marginLeft: 8, fontSize: 10, padding: '2px 8px',
                background: '#ef444433', color: '#ef4444',
                border: '1px solid #ef444466', borderRadius: 10, fontWeight: 700,
              }}>EXPOSED</span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
            {allowRemote
              ? '⚠ Third-party HTTPS MCP servers can now be enabled. They will receive any prompts/tool-arguments sent to them.'
              : 'Off — HTTPS MCP servers are refused even if individually marked enabled. Defence-in-depth default.'}
          </div>
        </div>
        <button
          onClick={toggleAllowRemote}
          style={{
            padding: '8px 16px',
            background: allowRemote ? '#ef4444' : 'var(--color-primary)',
            color: '#fff', border: 'none', borderRadius: 'var(--radius-md)',
            fontWeight: 600, cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {allowRemote ? 'Disable Remote' : 'Allow Remote…'}
        </button>
      </div>

      {/* Server list */}
      {loading ? (
        <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)' }}>
          Loading MCP servers…
        </div>
      ) : !mcpEnabled ? (
        <div style={{
          padding: 'var(--spacing-md)',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text-secondary)', fontSize: 'var(--text-sm)',
        }}>
          MCP client not available on this server. Restart with MCP support enabled to use this panel.
        </div>
      ) : servers.length === 0 ? (
        <div style={{
          padding: 'var(--spacing-md)',
          background: 'var(--bg-secondary)',
          border: '1px solid var(--border-primary)',
          borderRadius: 'var(--radius-md)',
          color: 'var(--text-secondary)', fontSize: 'var(--text-sm)',
        }}>
          No MCP servers configured yet. A default <code>~/.agentx/mcp.json</code> will be created on next server start with five safe local-only servers (all disabled).
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
          {servers.map(s => (
            <div
              key={s.name}
              style={{
                padding: 'var(--spacing-md)',
                background: 'var(--bg-secondary)',
                borderRadius: 'var(--radius-md)',
                border: `1px solid ${s.connected ? 'rgba(16,185,129,0.35)' : 'var(--border-primary)'}`,
                opacity: s.enabled ? 1 : 0.75,
              }}
            >
              <div style={{
                display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)',
                flexWrap: 'wrap', marginBottom: 6,
              }}>
                <strong style={{ fontSize: 14, fontFamily: 'monospace' }}>{s.name}</strong>
                {safetyBadge(s.safety)}
                <span style={{ fontSize: 10, color: 'var(--text-secondary)' }}>{s.transport}</span>
                {s.connected && (
                  <span style={{
                    fontSize: 10, padding: '2px 8px', borderRadius: 10, fontWeight: 700,
                    background: '#10b98122', color: '#10b981', border: '1px solid #10b98144',
                  }}>✓ CONNECTED · {s.toolCount} TOOLS</span>
                )}
                <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                  <button
                    onClick={() => toggleServer(s.name, !s.enabled)}
                    disabled={togglingName === s.name}
                    style={{
                      padding: '4px 12px', fontSize: 11, fontWeight: 600,
                      background: s.enabled ? '#10b98122' : '#6b728022',
                      color: s.enabled ? '#10b981' : 'var(--text-secondary)',
                      border: `1px solid ${s.enabled ? '#10b98144' : 'var(--border-primary)'}`,
                      borderRadius: 4, cursor: togglingName === s.name ? 'wait' : 'pointer',
                      minWidth: 90,
                    }}
                  >
                    {togglingName === s.name ? '…' : s.enabled ? '✓ Enabled' : '✗ Disabled'}
                  </button>
                </div>
              </div>
              {s.description && (
                <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5, marginBottom: 4 }}>
                  {s.description}
                </div>
              )}
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', fontFamily: 'monospace' }}>
                {s.command ? (
                  <><span style={{ color: 'var(--text-tertiary)' }}>cmd:</span> {s.command} {s.args.join(' ')}</>
                ) : s.url ? (
                  <><span style={{ color: 'var(--text-tertiary)' }}>url:</span> {s.url}</>
                ) : null}
              </div>
              {s.lastError && (
                <div style={{
                  marginTop: 8, padding: '6px 10px', fontSize: 12,
                  background: 'rgba(248,81,73,0.08)',
                  border: '1px solid rgba(248,81,73,0.25)',
                  borderRadius: 4, color: '#f85149',
                }}>
                  <strong>Error:</strong> {s.lastError}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
