import React, { useState, useEffect, useCallback } from 'react';
import '../styles/Pages.css';

// ---------------------------------------------------------------------------
// Types (mirrors core validation types for the UI)
// ---------------------------------------------------------------------------

interface ScenarioSummary {
  id: string;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  tags: string[];
}

interface RunSummary {
  id: string;
  scenarioId: string;
  status: string;
  pass: boolean;
  score: number;
  durationMs: number;
  completedAt?: number;
  modalityUsed?: string;
  pipelineStatus?: 'full' | 'fallback' | 'unavailable';
  failures: Array<{
    dimension: string;
    expected: string;
    actual: string;
    severity: string;
    explanation: string;
  }>;
}

interface RegressionSummary {
  scenarioId: string;
  previousScore: number;
  currentScore: number;
  delta: number;
  regressionDetected: boolean;
  improvementDetected: boolean;
  notes: string;
}

interface SuggestionSummary {
  id: string;
  subsystem: string;
  issue: string;
  suggestedFix: string;
  confidence: number;
  status: string;
}

interface ProposalSummary {
  id: string;
  targetSubsystem: string;
  reason: string;
  proposedChange: string;
  expectedBenefit: string;
  autoApplyAllowed: boolean;
  status: string;
}

interface ValidationReport {
  id: string;
  mode: string;
  totalScenarios: number;
  passed: number;
  failed: number;
  errors: number;
  skipped: number;
  overallScore: number;
  durationMs: number;
  runs: RunSummary[];
  regressions: RegressionSummary[];
  suggestions: SuggestionSummary[];
  proposals: ProposalSummary[];
}

type TabId = 'scenarios' | 'results' | 'regressions' | 'suggestions' | 'proposals';

// ---------------------------------------------------------------------------
// ValidationLab Page
// ---------------------------------------------------------------------------

export function ValidationLab() {
  const [activeTab, setActiveTab] = useState<TabId>('scenarios');
  const [scenarios, setScenarios] = useState<ScenarioSummary[]>([]);
  const [lastReport, setLastReport] = useState<ValidationReport | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [runMode, setRunMode] = useState<string>('quick');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [expandedRun, setExpandedRun] = useState<string | null>(null);

  const [loadError, setLoadError] = useState<string | null>(null);
  const [runError, setRunError] = useState<string | null>(null);

  // Fetch real scenarios from the backend on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const resp = await fetch('/api/validation/scenarios');
        if (!resp.ok) {
          const err = await resp.json().catch(() => ({ error: resp.statusText }));
          throw new Error(err.error || `HTTP ${resp.status}`);
        }
        const data = await resp.json();
        if (!cancelled && data.scenarios) {
          setScenarios(data.scenarios);
          setLoadError(null);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setLoadError(`Failed to load scenarios: ${msg}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const categories = ['all', ...new Set(scenarios.map(s => s.category))];

  const filteredScenarios = selectedCategory === 'all'
    ? scenarios
    : scenarios.filter(s => s.category === selectedCategory);

  const handleRunSuite = useCallback(async () => {
    setIsRunning(true);
    setActiveTab('results');
    setRunError(null);

    try {
      const categories = selectedCategory !== 'all' ? [selectedCategory] : undefined;
      const resp = await fetch('/api/validation/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          mode: runMode,
          deterministic: true,
          ...(categories ? { categories } : {}),
        }),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }

      const data = await resp.json();
      if (data.report) {
        setLastReport(data.report as ValidationReport);
      } else {
        throw new Error('No report returned from backend');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setRunError(`Suite run failed: ${msg}`);
    } finally {
      setIsRunning(false);
    }
  }, [runMode, selectedCategory]);

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Validation Lab</h1>
        <p>Autonomous validation, regression tracking, and self-improvement harness</p>
      </div>

      {/* Controls Bar */}
      <div className="content-card" style={{ marginBottom: 'var(--spacing-lg)', padding: 'var(--spacing-md) var(--spacing-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)', flexWrap: 'wrap' }}>
          <select
            value={runMode}
            onChange={e => setRunMode(e.target.value)}
            style={{
              background: 'var(--bg-secondary)', color: 'var(--text-primary)',
              border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
              padding: '8px 12px', fontSize: 'var(--text-sm)',
            }}
          >
            <option value="quick">Quick</option>
            <option value="full">Full</option>
            <option value="nightly">Nightly</option>
            <option value="pre-release">Pre-Release</option>
          </select>

          <select
            value={selectedCategory}
            onChange={e => setSelectedCategory(e.target.value)}
            style={{
              background: 'var(--bg-secondary)', color: 'var(--text-primary)',
              border: '1px solid var(--border-color)', borderRadius: 'var(--radius-md)',
              padding: '8px 12px', fontSize: 'var(--text-sm)',
            }}
          >
            {categories.map(c => (
              <option key={c} value={c}>{c === 'all' ? 'All Categories' : c}</option>
            ))}
          </select>

          <button
            onClick={handleRunSuite}
            disabled={isRunning}
            style={{
              background: isRunning ? 'var(--bg-tertiary)' : 'linear-gradient(135deg, #00d4aa, #7b61ff)',
              color: '#fff', border: 'none', borderRadius: 'var(--radius-md)',
              padding: '8px 20px', fontSize: 'var(--text-sm)', fontWeight: 600,
              cursor: isRunning ? 'not-allowed' : 'pointer',
              transition: 'all 0.2s ease',
            }}
          >
            {isRunning ? 'Running...' : 'Run Suite'}
          </button>

          {lastReport && (
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--spacing-md)', alignItems: 'center' }}>
              <span style={{
                fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: '10px',
                background: 'rgba(255,179,71,0.15)', color: '#ffb347', fontWeight: 600,
              }}>
                DETERMINISTIC
              </span>
              <span style={{ color: '#00d4aa', fontWeight: 600 }}>{lastReport.passed} passed</span>
              <span style={{ color: lastReport.failed > 0 ? '#ff6b6b' : 'var(--text-secondary)', fontWeight: 600 }}>{lastReport.failed} failed</span>
              <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
                Score: {(lastReport.overallScore * 100).toFixed(1)}%
              </span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)' }}>
                {(lastReport.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Error Banners */}
      {loadError && (
        <div className="content-card" style={{ marginBottom: 'var(--spacing-md)', background: 'rgba(255,107,107,0.1)', borderColor: 'rgba(255,107,107,0.3)' }}>
          <div style={{ color: '#ff6b6b', fontSize: 'var(--text-sm)', padding: '4px 0' }}>{loadError}</div>
        </div>
      )}
      {runError && (
        <div className="content-card" style={{ marginBottom: 'var(--spacing-md)', background: 'rgba(255,107,107,0.1)', borderColor: 'rgba(255,107,107,0.3)' }}>
          <div style={{ color: '#ff6b6b', fontSize: 'var(--text-sm)', padding: '4px 0' }}>{runError}</div>
        </div>
      )}

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: 'var(--spacing-xs)', marginBottom: 'var(--spacing-lg)' }}>
        {([
          { id: 'scenarios' as TabId, label: 'Scenarios', count: filteredScenarios.length },
          { id: 'results' as TabId, label: 'Results', count: lastReport?.runs.length || 0 },
          { id: 'regressions' as TabId, label: 'Regressions', count: lastReport?.regressions.length || 0 },
          { id: 'suggestions' as TabId, label: 'Suggestions', count: lastReport?.suggestions.length || 0 },
          { id: 'proposals' as TabId, label: 'Proposals', count: lastReport?.proposals.length || 0 },
        ]).map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              background: activeTab === tab.id ? 'var(--bg-tertiary)' : 'transparent',
              color: activeTab === tab.id ? 'var(--text-primary)' : 'var(--text-secondary)',
              border: `1px solid ${activeTab === tab.id ? 'var(--border-color)' : 'transparent'}`,
              borderRadius: 'var(--radius-md)',
              padding: '6px 16px', fontSize: 'var(--text-sm)', fontWeight: 500,
              cursor: 'pointer', transition: 'all 0.2s ease',
            }}
          >
            {tab.label}
            {tab.count > 0 && (
              <span style={{
                marginLeft: '6px', fontSize: 'var(--text-xs)',
                background: activeTab === tab.id ? 'var(--color-primary)' : 'var(--bg-tertiary)',
                color: activeTab === tab.id ? '#fff' : 'var(--text-secondary)',
                borderRadius: '10px', padding: '1px 7px',
              }}>
                {tab.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'scenarios' && (
        <div className="content-grid">
          {filteredScenarios.map(scenario => (
            <div key={scenario.id} className="content-card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '8px' }}>
                <div className="content-card-title">{scenario.name}</div>
                <span style={{
                  fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: '10px',
                  background: scenario.enabled ? 'rgba(0,212,170,0.15)' : 'rgba(255,107,107,0.15)',
                  color: scenario.enabled ? '#00d4aa' : '#ff6b6b',
                }}>
                  {scenario.enabled ? 'enabled' : 'disabled'}
                </span>
              </div>
              <div className="content-card-body">{scenario.description}</div>
              <div style={{ marginTop: '8px', display: 'flex', gap: '4px', flexWrap: 'wrap' }}>
                <span style={{
                  fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: '10px',
                  background: scenario.category === 'voice' ? 'rgba(168,85,247,0.15)'
                    : scenario.category === 'vision' ? 'rgba(59,130,246,0.15)'
                    : scenario.category === 'multimodal' ? 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(59,130,246,0.15))'
                    : 'var(--bg-tertiary)',
                  color: scenario.category === 'voice' ? '#a855f7'
                    : scenario.category === 'vision' ? '#3b82f6'
                    : scenario.category === 'multimodal' ? '#8b5cf6'
                    : 'var(--color-primary)',
                }}>
                  {scenario.category}
                </span>
                {scenario.tags.map(tag => (
                  <span key={tag} style={{
                    fontSize: 'var(--text-xs)', padding: '2px 6px', borderRadius: '10px',
                    background: 'var(--bg-secondary)', color: 'var(--text-tertiary)',
                  }}>
                    {tag}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {activeTab === 'results' && (
        <div>
          {!lastReport ? (
            <div className="content-card">
              <div className="content-card-body" style={{ textAlign: 'center', padding: 'var(--spacing-2xl)' }}>
                No results yet. Run a validation suite to see results.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
              {lastReport.runs.map(run => (
                <div key={run.id} className="content-card" style={{ cursor: 'pointer' }}
                  onClick={() => setExpandedRun(expandedRun === run.id ? null : run.id)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)' }}>
                    <span style={{
                      width: '10px', height: '10px', borderRadius: '50%',
                      background: run.pass ? '#00d4aa' : '#ff6b6b',
                      flexShrink: 0,
                    }} />
                    <span style={{ flex: 1, fontWeight: 500, color: 'var(--text-primary)', display: 'flex', alignItems: 'center', gap: '6px' }}>
                      {run.scenarioId}
                      {run.modalityUsed && run.modalityUsed !== 'text' && (
                        <span style={{
                          fontSize: '10px', padding: '1px 6px', borderRadius: '8px',
                          background: run.modalityUsed === 'voice' ? 'rgba(168,85,247,0.15)'
                            : run.modalityUsed === 'vision' ? 'rgba(59,130,246,0.15)'
                            : 'rgba(139,92,246,0.15)',
                          color: run.modalityUsed === 'voice' ? '#a855f7'
                            : run.modalityUsed === 'vision' ? '#3b82f6'
                            : '#8b5cf6',
                        }}>
                          {run.modalityUsed}
                        </span>
                      )}
                      {run.pipelineStatus && (
                        <span style={{
                          fontSize: '10px', padding: '1px 6px', borderRadius: '8px',
                          background: run.pipelineStatus === 'full' ? 'rgba(0,212,170,0.15)'
                            : run.pipelineStatus === 'fallback' ? 'rgba(255,179,71,0.15)'
                            : 'rgba(255,107,107,0.15)',
                          color: run.pipelineStatus === 'full' ? '#00d4aa'
                            : run.pipelineStatus === 'fallback' ? '#ffb347'
                            : '#ff6b6b',
                        }}>
                          {run.pipelineStatus}
                        </span>
                      )}
                    </span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
                      {(run.score * 100).toFixed(0)}%
                    </span>
                    <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-xs)', minWidth: '60px', textAlign: 'right' }}>
                      {run.durationMs}ms
                    </span>
                    <span style={{
                      fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: '10px',
                      background: run.pass ? 'rgba(0,212,170,0.15)' : 'rgba(255,107,107,0.15)',
                      color: run.pass ? '#00d4aa' : '#ff6b6b',
                    }}>
                      {run.status}
                    </span>
                  </div>

                  {expandedRun === run.id && run.failures.length > 0 && (
                    <div style={{ marginTop: 'var(--spacing-md)', paddingTop: 'var(--spacing-md)', borderTop: '1px solid var(--border-color)' }}>
                      {run.failures.map((f, i) => (
                        <div key={i} style={{ marginBottom: 'var(--spacing-sm)', fontSize: 'var(--text-sm)' }}>
                          <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginBottom: '4px' }}>
                            <span style={{
                              fontSize: 'var(--text-xs)', padding: '1px 6px', borderRadius: '8px',
                              background: f.severity === 'critical' ? 'rgba(255,107,107,0.2)' : f.severity === 'major' ? 'rgba(255,179,71,0.2)' : 'rgba(255,255,255,0.1)',
                              color: f.severity === 'critical' ? '#ff6b6b' : f.severity === 'major' ? '#ffb347' : 'var(--text-secondary)',
                            }}>
                              {f.severity}
                            </span>
                            <span style={{ color: 'var(--text-secondary)' }}>{f.dimension}</span>
                          </div>
                          <div style={{ color: 'var(--text-tertiary)', paddingLeft: 'var(--spacing-sm)' }}>
                            {f.explanation}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'regressions' && (
        <div>
          {(!lastReport || lastReport.regressions.length === 0) ? (
            <div className="content-card">
              <div className="content-card-body" style={{ textAlign: 'center', padding: 'var(--spacing-2xl)' }}>
                No regressions detected.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
              {lastReport.regressions.map((r, i) => (
                <div key={i} className="content-card">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)' }}>
                    <span style={{
                      width: '10px', height: '10px', borderRadius: '50%',
                      background: r.regressionDetected ? '#ff6b6b' : r.improvementDetected ? '#00d4aa' : 'var(--text-tertiary)',
                      flexShrink: 0,
                    }} />
                    <span style={{ flex: 1, fontWeight: 500, color: 'var(--text-primary)' }}>
                      {r.scenarioId}
                    </span>
                    <span style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)' }}>
                      {r.previousScore.toFixed(3)} &rarr; {r.currentScore.toFixed(3)}
                    </span>
                    <span style={{
                      fontSize: 'var(--text-sm)', fontWeight: 600,
                      color: r.delta < 0 ? '#ff6b6b' : '#00d4aa',
                    }}>
                      {r.delta >= 0 ? '+' : ''}{r.delta.toFixed(3)}
                    </span>
                  </div>
                  <div style={{ marginTop: '6px', fontSize: 'var(--text-sm)', color: 'var(--text-tertiary)' }}>
                    {r.notes}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'suggestions' && (
        <div>
          {(!lastReport || lastReport.suggestions.length === 0) ? (
            <div className="content-card">
              <div className="content-card-body" style={{ textAlign: 'center', padding: 'var(--spacing-2xl)' }}>
                No repair suggestions generated.
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
              {lastReport.suggestions.map(s => (
                <div key={s.id} className="content-card">
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '6px' }}>
                    <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{s.issue}</span>
                    <span style={{
                      fontSize: 'var(--text-xs)', padding: '2px 8px', borderRadius: '10px',
                      background: 'var(--bg-tertiary)', color: 'var(--color-primary)',
                    }}>
                      {s.subsystem}
                    </span>
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: '6px' }}>
                    {s.suggestedFix}
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--spacing-md)', fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)' }}>
                    <span>Confidence: {(s.confidence * 100).toFixed(0)}%</span>
                    <span>Status: {s.status}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'proposals' && (
        <div className="content-card">
          <div className="content-card-body" style={{ textAlign: 'center', padding: 'var(--spacing-2xl)' }}>
            <div style={{ fontSize: 'var(--text-lg)', marginBottom: 'var(--spacing-md)', color: 'var(--text-primary)' }}>
              Self-Improvement Proposals
            </div>
            <div style={{ color: 'var(--text-secondary)', maxWidth: '500px', margin: '0 auto' }}>
              Phase C proposals will appear here after sufficient validation data is collected.
              Auto-apply is disabled by default. All proposals require manual review.
            </div>
            <div style={{
              marginTop: 'var(--spacing-lg)', display: 'inline-flex', gap: 'var(--spacing-sm)',
              fontSize: 'var(--text-xs)', color: 'var(--text-tertiary)',
            }}>
              <span style={{ padding: '3px 10px', borderRadius: '10px', background: 'rgba(0,212,170,0.1)', color: '#00d4aa' }}>
                Phase A: Validation
              </span>
              <span style={{ padding: '3px 10px', borderRadius: '10px', background: 'rgba(123,97,255,0.1)', color: '#7b61ff' }}>
                Phase B: Suggestions
              </span>
              <span style={{ padding: '3px 10px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-tertiary)' }}>
                Phase C: Proposals (pending)
              </span>
              <span style={{ padding: '3px 10px', borderRadius: '10px', background: 'rgba(255,255,255,0.05)', color: 'var(--text-tertiary)' }}>
                Phase D: Auto-Apply (locked)
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
