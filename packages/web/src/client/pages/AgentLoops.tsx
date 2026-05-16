import React, { useState, useEffect, useCallback } from 'react';
import '../styles/Pages.css';

interface LoopHistoryEntry {
  loopId: string;
  goal: string;
  status: string;
  currentStep: number;
  totalSteps: number;
  startTime: number;
  duration: number;
  finalOutcome: {
    success: boolean;
    summary: string;
    metrics?: {
      totalSteps: number;
      successfulSteps: number;
      failedSteps: number;
      totalDuration: number;
      toolsUsed: string[];
    };
  } | null;
}

interface StepFinding {
  step: number;
  action: string;
  description: string;
  outcome: string;
  analysis: string;
  output?: Record<string, unknown>;
}

interface LoopResult {
  loopId: string;
  success: boolean;
  status: string;
  summary: string;
  steps: number;
  duration: number;
  tasks: Array<{ action: string; description: string }>;
  reasoning?: string;
  expectedOutcome?: string;
  findings?: StepFinding[];
}

/** Render key fields from a step's execution output */
function OutputDetails({ output }: { output: Record<string, unknown> }) {
  // Extract the most user-relevant fields based on action type
  const entries: Array<{ label: string; value: string }> = [];

  const add = (label: string, raw: unknown) => {
    if (raw === undefined || raw === null) return;
    const v = typeof raw === 'object' ? JSON.stringify(raw) : String(raw);
    if (v.length > 0) entries.push({ label, value: v.length > 200 ? v.slice(0, 200) + '...' : v });
  };

  // Common fields across action types
  add('Status', output.status);
  add('Path', output.path);
  add('Files', output.fileCount);
  add('Errors', output.errorCount);
  add('Warnings', output.warningCount);
  add('Suggestions', output.totalSuggestions);

  // Structured sub-arrays (errors, warnings, suggestions)
  if (Array.isArray(output.errors) && output.errors.length > 0) {
    add('Error details', output.errors.slice(0, 5).join('; '));
  }
  if (Array.isArray(output.warnings) && output.warnings.length > 0) {
    add('Warning details', output.warnings.slice(0, 5).join('; '));
  }
  if (Array.isArray(output.suggestions) && output.suggestions.length > 0) {
    const summaries = output.suggestions.slice(0, 5).map((s: unknown) =>
      typeof s === 'object' && s !== null && 'description' in s ? (s as { description: string }).description : String(s)
    );
    add('Suggestions', summaries.join('; '));
  }
  if (Array.isArray(output.structure)) {
    add('Structure', output.structure.slice(0, 8).join(', '));
  }

  if (entries.length === 0) return null;

  return (
    <div style={{ marginTop: '6px', paddingTop: '6px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
      {entries.map((e, i) => (
        <div key={i} style={{ fontSize: '11px', color: 'var(--text-secondary)', margin: '2px 0', display: 'flex', gap: '6px' }}>
          <span style={{ color: '#8b949e', minWidth: '80px', flexShrink: 0 }}>{e.label}:</span>
          <span style={{ color: 'var(--text-primary)', wordBreak: 'break-word' }}>{e.value}</span>
        </div>
      ))}
    </div>
  );
}

/**
 * AgentLoopsPanel — the Run-a-Loop UI + History table, without a page header.
 *
 * Used inside the Projects page as a tab. If a standalone Agent Loops page
 * ever comes back, wrap this in a page-container with its own header.
 */
export function AgentLoopsPanel() {
  const [goal, setGoal] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<LoopResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<LoopHistoryEntry[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch('/api/agent-loops/history');
      if (res.ok) {
        const data = await res.json();
        setHistory(Array.isArray(data.history) ? data.history : []);
      }
    } catch {
      // Silently fail — history is non-critical
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  const runLoop = async () => {
    const trimmed = goal.trim();
    if (!trimmed || running) return;

    setRunning(true);
    setResult(null);
    setError(null);

    try {
      const res = await fetch('/api/agent-loops/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: trimmed }),
      });
      const data = await res.json();

      if (!res.ok) {
        // Honest disabled-state messaging when the feature is gated off.
        if (res.status === 503 && data?.reason === 'agent_loops_disabled') {
          setError(
            'Agent Loops are disabled by default. To enable, restart the server with '
            + 'AGENTX_ENABLE_AGENT_LOOPS=true. Loops run autonomously for up to 5 minutes '
            + 'and can call any registered tool.'
          );
          return;
        }
        setError(data?.error || `Failed to run agent loop (HTTP ${res.status})`);
        return;
      }

      setResult(data);
      setGoal('');
      // Refresh history after completion
      fetchHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setRunning(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      runLoop();
    }
  };

  const formatDuration = (ms: number): string => {
    const sec = ms / 1000;
    if (sec < 60) return `${sec.toFixed(1)}s`;
    return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  };

  const formatTime = (ts: number): string => {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getOutcomeLabel = (entry: LoopHistoryEntry): { text: string; color: string } => {
    const fo = entry.finalOutcome;
    if (!fo) return { text: '\u2014', color: 'var(--text-secondary)' };
    if (!fo.success) return { text: 'Failed', color: '#f85149' };
    if (fo.metrics && fo.metrics.failedSteps > 0) {
      return {
        text: `Partial (${fo.metrics.successfulSteps}/${fo.metrics.totalSteps})`,
        color: '#d29922',
      };
    }
    return { text: 'Success', color: '#3fb950' };
  };

  return (
    <div>
      {/* Run Agent Loop */}
      <div
        style={{
          maxWidth: '900px',
          margin: '0 auto var(--spacing-xl)',
          padding: 'var(--spacing-lg)',
          background: 'var(--bg-secondary)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <h3 style={{ marginBottom: 'var(--spacing-md)', color: 'var(--text-primary)' }}>
          Run Agent Loop
        </h3>
        <div style={{ display: 'flex', gap: '10px' }}>
          <input
            type="text"
            value={goal}
            onChange={(e) => setGoal(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Enter goal (e.g. Inspect and analyze the project structure)"
            disabled={running}
            style={{
              flex: 1,
              padding: '10px 14px',
              background: 'var(--bg-primary)',
              border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--text-primary)',
              fontSize: 'var(--text-sm)',
              outline: 'none',
            }}
          />
          <button
            onClick={runLoop}
            disabled={running || !goal.trim()}
            style={{
              padding: '10px 24px',
              background: running ? 'var(--bg-tertiary, #30363d)' : '#238636',
              color: '#fff',
              border: 'none',
              borderRadius: 'var(--radius-sm)',
              fontWeight: 600,
              fontSize: 'var(--text-sm)',
              cursor: running || !goal.trim() ? 'not-allowed' : 'pointer',
              whiteSpace: 'nowrap',
              minWidth: '80px',
            }}
          >
            {running ? 'Running...' : 'Run'}
          </button>
        </div>

        {/* Running indicator */}
        {running && (
          <div
            style={{
              marginTop: 'var(--spacing-md)',
              padding: 'var(--spacing-md)',
              background: '#1f2d3d',
              border: '1px solid #30363d',
              borderRadius: 'var(--radius-sm)',
              color: '#58a6ff',
              fontSize: 'var(--text-sm)',
            }}
          >
            Agent loop is running... This may take a few seconds.
          </div>
        )}

        {/* Error display */}
        {error && (
          <div
            style={{
              marginTop: 'var(--spacing-md)',
              padding: 'var(--spacing-md)',
              background: '#f8514422',
              border: '1px solid #f85149',
              borderRadius: 'var(--radius-sm)',
              color: '#f85149',
              fontSize: 'var(--text-sm)',
            }}
          >
            {error}
          </div>
        )}

        {/* Result display with findings */}
        {result && (
          <div
            style={{
              marginTop: 'var(--spacing-md)',
              padding: 'var(--spacing-md)',
              background: result.success ? '#1f3a2e' : '#3d1f1f',
              border: `1px solid ${result.success ? '#3fb950' : '#f85149'}`,
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {/* Summary header */}
            <div style={{ marginBottom: '12px' }}>
              <span
                style={{
                  fontWeight: 700,
                  color: result.success ? '#3fb950' : '#f85149',
                  fontSize: 'var(--text-sm)',
                }}
              >
                {result.success ? 'Done' : 'Failed'}
              </span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginLeft: '8px' }}>
                {result.summary}
              </span>
            </div>

            {/* Plan reasoning */}
            {result.reasoning && (
              <div style={{ marginBottom: '12px', padding: '8px 10px', background: 'rgba(88,166,255,0.08)', borderRadius: '4px', borderLeft: '3px solid #58a6ff' }}>
                <div style={{ fontSize: '11px', fontWeight: 600, color: '#58a6ff', marginBottom: '4px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Strategy</div>
                <div style={{ fontSize: '12px', color: 'var(--text-primary)', lineHeight: '1.5' }}>{result.reasoning}</div>
              </div>
            )}

            {/* Per-step findings */}
            {result.findings && result.findings.length > 0 && (
              <div>
                <div style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)', marginBottom: '8px', textTransform: 'uppercase', letterSpacing: '0.5px' }}>Findings</div>
                {result.findings.map((f) => (
                  <div
                    key={f.step}
                    style={{
                      marginBottom: '8px',
                      padding: '8px 10px',
                      background: 'rgba(255,255,255,0.03)',
                      borderRadius: '4px',
                      borderLeft: `3px solid ${f.outcome === 'success' ? '#3fb950' : '#f85149'}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '4px' }}>
                      <span style={{ fontSize: '11px', fontWeight: 700, color: '#58a6ff' }}>{f.step}.</span>
                      <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--text-primary)' }}>{f.description}</span>
                      <span style={{
                        fontSize: '10px', fontWeight: 600, padding: '1px 6px', borderRadius: '8px',
                        background: f.outcome === 'success' ? '#1f3a2e' : '#3d1f1f',
                        color: f.outcome === 'success' ? '#3fb950' : '#f85149',
                        marginLeft: 'auto', flexShrink: 0,
                      }}>{f.outcome}</span>
                    </div>
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>{f.analysis}</div>
                    {f.output && typeof f.output === 'object' && (
                      <OutputDetails output={f.output} />
                    )}
                  </div>
                ))}
              </div>
            )}

            {/* Expected outcome */}
            {result.expectedOutcome && (
              <div style={{ marginTop: '8px', fontSize: '12px', color: 'var(--text-secondary)', fontStyle: 'italic' }}>
                Expected: {result.expectedOutcome}
              </div>
            )}
          </div>
        )}
      </div>

      {/* History */}
      <div
        style={{
          maxWidth: '900px',
          margin: '0 auto',
          padding: 'var(--spacing-lg)',
          background: 'var(--bg-secondary)',
          borderRadius: 'var(--radius-md)',
          border: '1px solid var(--border-primary)',
        }}
      >
        <h3 style={{ marginBottom: 'var(--spacing-md)', color: 'var(--text-primary)' }}>
          Loop History
        </h3>

        {loadingHistory ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
            Loading history...
          </div>
        ) : history.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
            No loops have been run yet.
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table
              style={{
                width: '100%',
                borderCollapse: 'collapse',
                fontSize: '13px',
              }}
            >
              <thead>
                <tr>
                  {['Goal', 'Status', 'Steps', 'Duration', 'Outcome', 'Time'].map((h) => (
                    <th
                      key={h}
                      style={{
                        textAlign: 'left',
                        padding: '8px 12px',
                        color: 'var(--text-secondary)',
                        fontWeight: 600,
                        fontSize: '11px',
                        textTransform: 'uppercase',
                        letterSpacing: '0.5px',
                        borderBottom: '1px solid var(--border-primary)',
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map((entry) => {
                  const outcome = getOutcomeLabel(entry);
                  return (
                    <tr key={entry.loopId}>
                      <td
                        style={{
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--border-primary)',
                          color: 'var(--text-primary)',
                          maxWidth: '300px',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={entry.goal}
                      >
                        {entry.goal}
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--border-primary)',
                        }}
                      >
                        <span
                          style={{
                            display: 'inline-block',
                            padding: '2px 8px',
                            borderRadius: '12px',
                            fontSize: '11px',
                            fontWeight: 600,
                            background:
                              entry.status === 'completed'
                                ? '#1f3a2e'
                                : entry.status === 'failed'
                                ? '#3d1f1f'
                                : '#1f2d3d',
                            color:
                              entry.status === 'completed'
                                ? '#3fb950'
                                : entry.status === 'failed'
                                ? '#f85149'
                                : '#58a6ff',
                          }}
                        >
                          {entry.status}
                        </span>
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--border-primary)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {entry.currentStep}
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--border-primary)',
                          color: 'var(--text-secondary)',
                        }}
                      >
                        {formatDuration(entry.duration)}
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--border-primary)',
                          color: outcome.color,
                          fontWeight: 600,
                        }}
                      >
                        {outcome.text}
                      </td>
                      <td
                        style={{
                          padding: '8px 12px',
                          borderBottom: '1px solid var(--border-primary)',
                          color: 'var(--text-secondary)',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatTime(entry.startTime)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
