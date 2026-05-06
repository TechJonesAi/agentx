import React, { useState, useEffect } from 'react';
import '../styles/Pages.css';

interface Log {
  level: string;
  message: string;
  timestamp: string | Date;
  module?: string | null;
  details?: string | null;
}

// ─── LLM Interaction types (mirror server shape) ──────────────────────
interface LLMInteractionSummary {
  id: string;
  timestamp: string;
  sessionId?: string;
  query: string;
  model?: string;
  docCount: number;
  isEmailFocused: boolean;
  queryIntent?: string;
  grounded?: boolean;
  trustTier?: 'high' | 'medium' | 'low';
  groundingScore?: number;
  unsupportedCount?: number;
  invalidCitations?: string[];
  durationMs?: number;
  hasError?: boolean;
  finalResponsePreview?: string;
}

interface LLMInteractionDetail {
  id: string;
  timestamp: string;
  sessionId?: string;
  query: string;
  model?: string;
  systemPromptPreview?: string;
  evidence: Array<{
    citationRef: string;
    documentId: string;
    fileName: string | null;
    textSnippet: string;
    score?: number;
    pageNumber?: number | null;
  }>;
  knowledgeContext?: {
    docChunkCount: number;
    memoryItemCount: number;
    isEmailFocused: boolean;
    queryIntent?: string;
    retrievalFailed?: boolean;
    resolvedDomain?: string;
  };
  rawResponse?: string;
  finalResponse?: string;
  groundingReport?: {
    grounded: boolean;
    score: number;
    trustTier: 'high' | 'medium' | 'low';
    factualClaimCount: number;
    unsupportedCount: number;
    invalidCitations: string[];
    issueSample: Array<{ kind: string; message: string }>;
  };
  durationMs?: number;
  error?: string;
}

type TabId = 'system' | 'llm';

export function Logs() {
  const [activeTab, setActiveTab] = useState<TabId>('llm');
  const [logs, setLogs] = useState<Log[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [interactions, setInteractions] = useState<LLMInteractionSummary[]>([]);
  const [interactionsLoading, setInteractionsLoading] = useState(false);
  const [interactionsError, setInteractionsError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedDetail, setExpandedDetail] = useState<LLMInteractionDetail | null>(null);

  // System Logs tab filters
  const [systemLevel, setSystemLevel] = useState<string>('');
  const [systemSearch, setSystemSearch] = useState<string>('');

  const fetchSystemLogs = async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('limit', '200');
      if (systemLevel) qs.set('level', systemLevel);
      if (systemSearch) qs.set('search', systemSearch);
      const response = await fetch(`/api/logs?${qs.toString()}`);
      if (!response.ok) {
        throw new Error(`Failed to load logs: ${response.statusText}`);
      }
      const data = await response.json();
      setLogs(Array.isArray(data) ? data : []);
      setError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load logs';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSystemLogs();
    // re-fetch when filters change (debounced a touch via setTimeout)
    const t = setTimeout(fetchSystemLogs, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [systemLevel, systemSearch]);

  useEffect(() => {
    const fetchInteractions = async () => {
      setInteractionsLoading(true);
      try {
        const r = await fetch('/api/logs/llm-interactions?limit=100');
        if (!r.ok) throw new Error(`Failed to load interactions: ${r.statusText}`);
        const data = await r.json();
        setInteractions(data.interactions ?? []);
        setInteractionsError(null);
      } catch (err) {
        setInteractionsError(err instanceof Error ? err.message : 'Failed to load');
      } finally {
        setInteractionsLoading(false);
      }
    };
    if (activeTab === 'llm') fetchInteractions();
  }, [activeTab]);

  const refreshInteractions = async () => {
    setInteractionsLoading(true);
    try {
      const r = await fetch('/api/logs/llm-interactions?limit=100');
      if (r.ok) {
        const data = await r.json();
        setInteractions(data.interactions ?? []);
        setInteractionsError(null);
      }
    } finally {
      setInteractionsLoading(false);
    }
  };

  const expandInteraction = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      setExpandedDetail(null);
      return;
    }
    setExpandedId(id);
    setExpandedDetail(null);
    try {
      const r = await fetch(`/api/logs/llm-interactions/${encodeURIComponent(id)}`);
      if (r.ok) setExpandedDetail(await r.json());
    } catch { /* keep placeholder */ }
  };

  const getLevelColor = (level: string) => {
    switch (level) {
      case 'error': return '#ef4444';
      case 'warn': return '#f97316';
      case 'info': return '#00d9ff';
      case 'debug': return '#a0a0a0';
      default: return '#e0e0e0';
    }
  };

  const tierColor = (t?: string) =>
    t === 'high' ? '#10b981' : t === 'medium' ? '#f59e0b' : t === 'low' ? '#ef4444' : '#a0a0a0';

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Logs</h1>
        <p>System logs, LLM interactions, and grounding reports</p>
      </div>

      {/* Tab bar */}
      <div style={{
        maxWidth: '1100px', margin: '0 auto var(--spacing-md)', padding: '0 var(--spacing-lg)',
        display: 'flex', gap: '2px', borderBottom: '1px solid var(--border-primary)',
      }}>
        {(['llm', 'system'] as TabId[]).map(tab => (
          <button
            key={tab}
            onClick={() => setActiveTab(tab)}
            style={{
              padding: '10px 20px', background: 'none', border: 'none',
              color: activeTab === tab ? 'var(--color-primary)' : 'var(--text-secondary)',
              borderBottom: `2px solid ${activeTab === tab ? 'var(--color-primary)' : 'transparent'}`,
              cursor: 'pointer', fontSize: '14px', fontWeight: activeTab === tab ? 600 : 400,
            }}
          >
            {tab === 'llm' ? 'LLM Interactions' : 'System Logs'}
          </button>
        ))}
      </div>

      {/* ── LLM INTERACTIONS TAB ───────────────────────────────────── */}
      {activeTab === 'llm' && (
        <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 var(--spacing-lg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
            <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
              {interactions.length} recent interactions — showing query, evidence, grounding verdict, and response
            </div>
            <button
              onClick={refreshInteractions}
              style={{
                padding: '4px 12px', background: 'var(--bg-secondary)',
                border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer',
              }}
            >
              Refresh
            </button>
          </div>

          {interactionsError && (
            <div style={{ padding: 'var(--spacing-md)', color: '#ef4444', marginBottom: 'var(--spacing-md)' }}>
              {interactionsError}
            </div>
          )}

          {interactionsLoading && interactions.length === 0 && (
            <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)' }}>
              Loading interactions…
            </div>
          )}

          {!interactionsLoading && interactions.length === 0 && (
            <div style={{
              padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)',
              background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-md)',
            }}>
              No interactions logged yet. Ask a question in Chat — it will appear here.
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
            {interactions.map(i => (
              <div
                key={i.id}
                style={{
                  background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
                  borderRadius: 'var(--radius-md)', overflow: 'hidden',
                }}
              >
                <div
                  onClick={() => expandInteraction(i.id)}
                  style={{ padding: '12px 16px', cursor: 'pointer' }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'rgba(0, 224, 255, 0.05)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'transparent')}
                >
                  <div style={{ display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' }}>
                    <span style={{ fontSize: '11px', color: 'var(--text-tertiary)', fontFamily: 'monospace', minWidth: '140px' }}>
                      {new Date(i.timestamp).toLocaleString()}
                    </span>
                    {i.trustTier && (
                      <span style={{
                        padding: '2px 8px', borderRadius: '10px', fontSize: '11px',
                        background: `${tierColor(i.trustTier)}22`, color: tierColor(i.trustTier),
                        fontWeight: 600, textTransform: 'uppercase',
                      }}>
                        {i.trustTier} trust
                        {typeof i.groundingScore === 'number' && ` · ${(i.groundingScore * 100).toFixed(0)}%`}
                      </span>
                    )}
                    {i.docCount > 0 && (
                      <span style={{
                        padding: '2px 8px', borderRadius: '10px', fontSize: '11px',
                        background: 'rgba(0,224,255,0.1)', color: 'var(--color-primary)',
                      }}>
                        {i.docCount} doc{i.docCount !== 1 ? 's' : ''}
                      </span>
                    )}
                    {i.isEmailFocused && (
                      <span style={{ fontSize: '11px', color: 'var(--text-tertiary)' }}>email-focused</span>
                    )}
                    {i.unsupportedCount && i.unsupportedCount > 0 ? (
                      <span style={{ fontSize: '11px', color: '#ef4444' }}>
                        {i.unsupportedCount} unsupported
                      </span>
                    ) : null}
                    {i.invalidCitations && i.invalidCitations.length > 0 && (
                      <span style={{ fontSize: '11px', color: '#ef4444' }}>
                        invalid cites: {i.invalidCitations.join(', ')}
                      </span>
                    )}
                    {i.hasError && (
                      <span style={{ fontSize: '11px', color: '#ef4444' }}>ERROR</span>
                    )}
                    <span style={{ marginLeft: 'auto', fontSize: '11px', color: 'var(--text-tertiary)' }}>
                      {expandedId === i.id ? '▼' : '▶'}
                    </span>
                  </div>
                  <div style={{
                    marginTop: '6px', fontSize: '13px', color: 'var(--text-primary)',
                    fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {i.query}
                  </div>
                  {i.finalResponsePreview && (
                    <div style={{
                      marginTop: '4px', fontSize: '12px', color: 'var(--text-secondary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      → {i.finalResponsePreview}
                    </div>
                  )}
                </div>

                {/* Expanded detail */}
                {expandedId === i.id && (
                  <div style={{
                    padding: '16px', background: 'var(--bg-tertiary)',
                    borderTop: '1px solid var(--border-primary)',
                  }}>
                    {!expandedDetail && (
                      <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>Loading detail…</div>
                    )}
                    {expandedDetail && (
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
                        {/* Query */}
                        <div>
                          <SectionHeader>Query</SectionHeader>
                          <PreBlock>{expandedDetail.query}</PreBlock>
                        </div>

                        {/* Knowledge context */}
                        {expandedDetail.knowledgeContext && (
                          <div>
                            <SectionHeader>Knowledge context</SectionHeader>
                            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', display: 'flex', gap: '16px', flexWrap: 'wrap' }}>
                              <span>docs: {expandedDetail.knowledgeContext.docChunkCount}</span>
                              <span>memory: {expandedDetail.knowledgeContext.memoryItemCount}</span>
                              <span>email-focused: {String(expandedDetail.knowledgeContext.isEmailFocused)}</span>
                              <span>intent: {expandedDetail.knowledgeContext.queryIntent ?? '—'}</span>
                              <span>domain: {expandedDetail.knowledgeContext.resolvedDomain ?? '—'}</span>
                              <span>retrieval failed: {String(expandedDetail.knowledgeContext.retrievalFailed ?? false)}</span>
                            </div>
                          </div>
                        )}

                        {/* Evidence */}
                        {expandedDetail.evidence.length > 0 && (
                          <div>
                            <SectionHeader>Evidence chunks ({expandedDetail.evidence.length})</SectionHeader>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                              {expandedDetail.evidence.map((e) => (
                                <div key={e.citationRef} style={{
                                  padding: '8px', background: 'var(--bg-secondary)',
                                  border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                                  fontSize: '12px',
                                }}>
                                  <div style={{ display: 'flex', gap: '8px', marginBottom: '4px' }}>
                                    <span style={{ color: 'var(--color-primary)', fontWeight: 600 }}>{e.citationRef}</span>
                                    {e.fileName && <span style={{ color: 'var(--text-tertiary)' }}>{e.fileName}</span>}
                                    {typeof e.score === 'number' && (
                                      <span style={{ color: 'var(--text-tertiary)', marginLeft: 'auto' }}>
                                        score: {e.score.toFixed(3)}
                                      </span>
                                    )}
                                  </div>
                                  <pre style={{
                                    margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                                    color: 'var(--text-secondary)', fontSize: '11px', fontFamily: 'monospace',
                                  }}>{e.textSnippet}</pre>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Grounding report */}
                        {expandedDetail.groundingReport && (
                          <div>
                            <SectionHeader>Grounding report</SectionHeader>
                            <div style={{ fontSize: '12px', display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '6px' }}>
                              <span style={{ color: tierColor(expandedDetail.groundingReport.trustTier), fontWeight: 600 }}>
                                {expandedDetail.groundingReport.trustTier.toUpperCase()}
                              </span>
                              <span>score: {(expandedDetail.groundingReport.score * 100).toFixed(0)}%</span>
                              <span>factual claims: {expandedDetail.groundingReport.factualClaimCount}</span>
                              <span>unsupported: {expandedDetail.groundingReport.unsupportedCount}</span>
                              {expandedDetail.groundingReport.invalidCitations.length > 0 && (
                                <span style={{ color: '#ef4444' }}>
                                  invalid cites: {expandedDetail.groundingReport.invalidCitations.join(', ')}
                                </span>
                              )}
                            </div>
                            {expandedDetail.groundingReport.issueSample.length > 0 && (
                              <div style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                                {expandedDetail.groundingReport.issueSample.map((iss, idx) => (
                                  <div key={idx} style={{ marginBottom: '2px' }}>
                                    <strong>{iss.kind}:</strong> {iss.message}
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        )}

                        {/* Raw LLM response */}
                        {expandedDetail.rawResponse && (
                          <div>
                            <SectionHeader>Raw LLM response</SectionHeader>
                            <PreBlock>{expandedDetail.rawResponse}</PreBlock>
                          </div>
                        )}

                        {/* Final response (what user saw) */}
                        {expandedDetail.finalResponse && expandedDetail.finalResponse !== expandedDetail.rawResponse && (
                          <div>
                            <SectionHeader>Final response (after grounding hedge + post-processing)</SectionHeader>
                            <PreBlock>{expandedDetail.finalResponse}</PreBlock>
                          </div>
                        )}

                        {/* System prompt preview */}
                        {expandedDetail.systemPromptPreview && (
                          <div>
                            <SectionHeader>System prompt (preview)</SectionHeader>
                            <PreBlock>{expandedDetail.systemPromptPreview}</PreBlock>
                          </div>
                        )}

                        {expandedDetail.error && (
                          <div>
                            <SectionHeader>Error</SectionHeader>
                            <PreBlock>{expandedDetail.error}</PreBlock>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── SYSTEM LOGS TAB ────────────────────────────────────────── */}
      {activeTab === 'system' && (
        <div style={{ maxWidth: '1100px', margin: '0 auto', padding: '0 var(--spacing-lg)' }}>
          {/* Filter bar */}
          <div style={{
            display: 'flex', gap: '12px', alignItems: 'center', marginBottom: 'var(--spacing-md)',
            flexWrap: 'wrap',
          }}>
            <select
              value={systemLevel}
              onChange={(e) => setSystemLevel(e.target.value)}
              style={{
                padding: '6px 12px', background: 'var(--bg-secondary)',
                border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                color: 'var(--text-primary)', fontSize: '13px',
              }}
            >
              <option value="">All levels</option>
              <option value="error">Error</option>
              <option value="warn">Warn</option>
              <option value="info">Info</option>
              <option value="debug">Debug</option>
              <option value="trace">Trace</option>
            </select>
            <input
              type="text"
              placeholder="Search message, module, details…"
              value={systemSearch}
              onChange={(e) => setSystemSearch(e.target.value)}
              style={{
                flex: 1, minWidth: '200px', padding: '6px 12px',
                background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
                borderRadius: 'var(--radius-sm)', color: 'var(--text-primary)', fontSize: '13px',
              }}
            />
            <button
              onClick={fetchSystemLogs}
              style={{
                padding: '6px 14px', background: 'var(--bg-secondary)',
                border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)', fontSize: '12px', cursor: 'pointer',
              }}
            >
              Refresh
            </button>
            <span style={{ fontSize: '12px', color: 'var(--text-tertiary)' }}>
              {logs.length} entries
            </span>
          </div>

          {error && (
            <div style={{
              padding: 'var(--spacing-md)', marginBottom: 'var(--spacing-md)',
              background: '#f8544422', border: '1px solid #f85444',
              borderRadius: 'var(--radius-md)', color: '#f85444', fontSize: 'var(--text-sm)',
            }}>
              ⚠️ {error}
            </div>
          )}

          {loading && logs.length === 0 && (
            <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center' }}>
              <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>Loading logs…</div>
            </div>
          )}

          {(!loading || logs.length > 0) && (
            <div style={{
              padding: 'var(--spacing-md)',
              background: 'var(--bg-secondary)', border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-md)', fontFamily: 'monospace', fontSize: '12px',
              overflowX: 'auto',
            }}>
              {logs.length === 0 ? (
                <div style={{ color: 'var(--text-secondary)', textAlign: 'center', padding: 'var(--spacing-md)' }}>
                  No system logs match the current filters.
                </div>
              ) : (
                logs.map((log, idx) => (
                  <div key={idx} style={{
                    padding: '6px 0',
                    borderBottom: '1px solid var(--border-secondary)',
                  }}>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span style={{
                        fontWeight: 'bold', textTransform: 'uppercase', fontSize: '10px',
                        minWidth: '46px', color: getLevelColor(log.level),
                      }}>
                        {log.level}
                      </span>
                      <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', whiteSpace: 'nowrap' }}>
                        {typeof log.timestamp === 'string'
                          ? new Date(log.timestamp).toLocaleTimeString()
                          : log.timestamp.toLocaleTimeString?.()}
                      </span>
                      {log.module && (
                        <span style={{
                          fontSize: '11px', color: 'var(--color-primary)',
                          background: 'rgba(0,224,255,0.08)', padding: '1px 6px', borderRadius: '10px',
                        }}>
                          {log.module}
                        </span>
                      )}
                      <span style={{ flex: 1, color: 'var(--text-primary)' }}>{log.message}</span>
                    </div>
                    {log.details && (
                      <div style={{
                        marginLeft: '56px', marginTop: '2px', fontSize: '11px',
                        color: 'var(--text-tertiary)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                      }}>
                        {log.details}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Small helpers for detail panel ─────────────────────────────────────
function SectionHeader({ children }: { children: React.ReactNode }) {
  return (
    <div style={{
      fontSize: '11px', fontWeight: 600, color: 'var(--text-secondary)',
      textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: '4px',
    }}>
      {children}
    </div>
  );
}

function PreBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre style={{
      margin: 0, padding: '8px 10px', background: 'var(--bg-secondary)',
      border: '1px solid var(--border-primary)', borderRadius: 'var(--radius-sm)',
      fontSize: '12px', fontFamily: 'monospace', color: 'var(--text-primary)',
      whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '400px', overflow: 'auto',
    }}>{children}</pre>
  );
}
