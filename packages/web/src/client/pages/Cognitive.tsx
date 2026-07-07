import React, { useState, useEffect, useCallback, useRef } from 'react';
import '../styles/Pages.css';

interface CognitiveStatus {
  enabled: boolean;
  memoryGateway: { url: string; healthy: boolean };
  config: Record<string, unknown>;
}

interface EvidenceItem {
  documentId: string;
  chunkId: string;
  text: string;
  score: number;
}

interface EntityItem {
  id: string;
  name: string;
  type: string;
  aliases: string[];
  confidence: { value: number };
}

interface ClaimItem {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  sourceDocumentId: string;
}

interface ContradictionItem {
  severity: string;
  description: string;
}

interface TimelineEventItem {
  id: string;
  description: string;
  action: string;
  timestamp: { display?: string };
}

interface InsightItem {
  type: string;
  description: string;
  confidence: number;
}

interface ToolExecution {
  toolName: string;
  success: boolean;
  result: string;
  provider?: string;
  sourceUrl?: string;
  evidenceCount?: number;
  trustScore?: number;
  latencyMs?: number;
}

type SearchPrivacyMode = 'auto' | 'private' | 'open';

interface PlanTask {
  id: string;
  description: string;
  type: string;
  status: string;
  queryHints?: string[];
  result?: { output?: any; evidenceGathered?: any[] };
}

interface TraceStep {
  action: string;
  input: any;
  output: any;
  durationMs: number;
  success: boolean;
  reasoning?: string;
}

interface CognitiveOutcome {
  success: boolean;
  answer?: string;
  evidence: EvidenceItem[];
  entities: EntityItem[];
  claims: ClaimItem[];
  contradictions: ContradictionItem[];
  events: TimelineEventItem[];
  hypotheses: unknown[];
  confidence: { value: number; basis: string; evidenceCount: number };
  iterationsUsed: number;
  totalDurationMs: number;
}

interface LoopState {
  id: string;
  phase: string;
  iteration: number;
  maxIterations: number;
  plan?: { taskGraph: PlanTask[] };
  worldModel?: unknown;
  insights: InsightItem[];
  feedbackSignals: unknown[];
  memoryUpdates: unknown[];
  toolExecutions: ToolExecution[];
  traces?: Array<{ id: string; steps: TraceStep[]; outcome: string }>;
}

interface ReasoningMeta {
  model: string | null;
  provider: 'ollama' | 'anthropic' | 'deterministic' | 'none';
  synthesisSource: 'memory' | 'internet' | 'mixed' | 'none';
  insufficientDetail: string | null;
}

interface CognitiveResult {
  status: string;
  goal: string;
  mode?: string;
  reasoning?: ReasoningMeta;
  outcome: CognitiveOutcome;
  loop_state: LoopState;
  stats: Record<string, unknown>;
}

type RuntimeMode = 'baseline' | 'fast' | 'balanced' | 'deep';

interface BenchmarkRow {
  query: string;
  category: string;
  mode: string;
  baselineConfidence: number;
  frontierConfidence: number;
  entities: number;
  claims: number;
  contradictions: number;
  events: number;
  iterations: number;
  latencyMs: number;
  advantage: number;
  status: 'pending' | 'running' | 'done' | 'error';
}

const BENCHMARK_QUERIES = [
  { query: 'What is the day one right for unfair dismissal?', category: 'Direct Factual' },
  { query: 'How do the Employment Rights Bill and the Equality Act interact on dismissal protections?', category: 'Cross-Doc Synthesis' },
  { query: 'What is the chronological sequence of events in the Employment Rights Bill\'s passage?', category: 'Timeline' },
  { query: 'Are there any conflicting statements about the qualifying period for unfair dismissal?', category: 'Contradiction' },
  { query: 'Which organizations and bodies are mentioned in connection with unfair dismissal reform?', category: 'Entity Relationship' },
  { query: 'What consequences does removing the qualifying period have for employers?', category: 'Causal Reasoning' },
];

interface DocItem {
  document_id: string;
  title: string;
  chunk_count?: number;
}

export function Cognitive() {
  const [status, setStatus] = useState<CognitiveStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [goal, setGoal] = useState('');
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<CognitiveResult | null>(null);
  const [mode, setMode] = useState<RuntimeMode>('balanced');
  const [searchPrivacy, setSearchPrivacy] = useState<SearchPrivacyMode>('auto');
  const [scopeMode, setScopeMode] = useState<'all' | 'selected'>('all');
  const [documents, setDocuments] = useState<DocItem[]>([]);
  const [selectedDocs, setSelectedDocs] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [progressPhase, setProgressPhase] = useState<string>('');
  const [benchmarkResults, setBenchmarkResults] = useState<BenchmarkRow[]>([]);
  const [benchmarkRunning, setBenchmarkRunning] = useState(false);
  const [uiMismatch, setUiMismatch] = useState(false);
  const guardRef = useRef<HTMLDivElement>(null);

  // Runtime UI guard: verify all critical controls rendered after mount
  useEffect(() => {
    if (loading) return;
    const timer = setTimeout(() => {
      const container = guardRef.current;
      if (!container) return;
      const text = container.textContent || '';
      const required = ['baseline', 'fast', 'balanced', 'deep', 'Private', 'Auto', 'Open', 'All Documents', 'Selected Documents'];
      const lowerText = text.toLowerCase();
      const missing = required.filter(label => !lowerText.includes(label.toLowerCase()));
      if (missing.length > 0) {
        console.error(`[Cognitive] UI build mismatch — missing controls: ${missing.join(', ')}`);
        setUiMismatch(true);
        // Trigger SW update check
        navigator.serviceWorker?.controller?.postMessage({ type: 'CHECK_UPDATE' });
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [loading]);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/cognitive/status');
        if (res.ok) {
          const data = await res.json();
          setStatus(data);
        } else {
          // API returned non-200 — show degraded state
          setStatus({ enabled: false, memoryGateway: { url: '', healthy: false }, config: {} });
        }
      } catch {
        // Network error — show unavailable state
        setStatus({ enabled: false, memoryGateway: { url: '', healthy: false }, config: {} });
      } finally {
        setLoading(false);
      }
    };
    fetchStatus();
  }, []);

  const loadDocuments = useCallback(async () => {
    try {
      const res = await fetch('/api/memory/gateway/documents');
      if (res.ok) {
        const data = await res.json();
        setDocuments(data.documents || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    if (scopeMode === 'selected') loadDocuments();
  }, [scopeMode, loadDocuments]);

  const runCognitive = async () => {
    if (!goal.trim() || running) return;
    setRunning(true);
    setResult(null);
    setError(null);
    setProgressPhase('Submitting query...');

    // Progress phase timeline — honest status labels, no fake percentages
    const phases = [
      { delay: 400, label: 'Retrieving from memory...' },
      { delay: 2000, label: 'Analyzing evidence...' },
      { delay: 4000, label: searchPrivacy !== 'private' ? 'Checking external sources...' : 'Reasoning over evidence...' },
      { delay: 7000, label: 'Waiting on local LLM...' },
      { delay: 15000, label: 'Still processing — local LLM is generating...' },
    ];
    const timers: ReturnType<typeof setTimeout>[] = [];
    for (const p of phases) {
      timers.push(setTimeout(() => setProgressPhase(p.label), p.delay));
    }

    try {
      const payload: Record<string, unknown> = { goal: goal.trim(), mode, searchPrivacyMode: searchPrivacy };
      if (scopeMode === 'selected' && selectedDocs.size > 0) {
        payload.document_scope = Array.from(selectedDocs);
      }

      const res = await fetch('/api/cognitive/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();
      if (res.ok) {
        setResult(data);
      } else {
        setError(data.error || 'Request failed');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      timers.forEach(t => clearTimeout(t));
      setProgressPhase('');
      setRunning(false);
    }
  };

  const toggleDoc = (id: string) => {
    setSelectedDocs(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const runBenchmark = async () => {
    if (benchmarkRunning) return;
    setBenchmarkRunning(true);

    const rows: BenchmarkRow[] = BENCHMARK_QUERIES.map(q => ({
      query: q.query,
      category: q.category,
      mode: 'deep',
      baselineConfidence: 0,
      frontierConfidence: 0,
      entities: 0,
      claims: 0,
      contradictions: 0,
      events: 0,
      iterations: 0,
      latencyMs: 0,
      advantage: 0,
      status: 'pending' as const,
    }));
    setBenchmarkResults([...rows]);

    for (let i = 0; i < rows.length; i++) {
      rows[i].status = 'running';
      setBenchmarkResults([...rows]);

      try {
        const res = await fetch('/api/cognitive/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ goal: rows[i].query, mode: 'deep' }),
        });
        const data = await res.json();

        if (res.ok && data.outcome) {
          const o = data.outcome;
          const traces = data.loop_state?.traces?.[0]?.steps ?? [];
          const baseline = traces.find((s: any) => s.action === 'baseline_query');

          rows[i].baselineConfidence = baseline?.output?.confidence ?? 0;
          rows[i].frontierConfidence = o.confidence?.value ?? 0;
          rows[i].entities = o.entities?.length ?? 0;
          rows[i].claims = o.claims?.length ?? 0;
          rows[i].contradictions = o.contradictions?.length ?? 0;
          rows[i].events = o.events?.length ?? 0;
          rows[i].iterations = o.iterationsUsed ?? 0;
          rows[i].latencyMs = o.totalDurationMs ?? 0;

          // Calculate frontier advantage score
          const confDelta = rows[i].frontierConfidence - rows[i].baselineConfidence;
          const entityBonus = rows[i].entities * 0.01;
          const contradictionBonus = rows[i].contradictions * 0.2;
          const eventBonus = rows[i].events * 0.01;
          rows[i].advantage = Math.round((confDelta + entityBonus + contradictionBonus + eventBonus) * 100) / 100;

          rows[i].status = 'done';
        } else {
          rows[i].status = 'error';
        }
      } catch {
        rows[i].status = 'error';
      }

      setBenchmarkResults([...rows]);
    }

    setBenchmarkRunning(false);
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="page-header">
          <h1>Cognitive</h1>
          <p>Frontier Autonomous Research Agent</p>
        </div>
        <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)', fontSize: '14px' }}>
          Loading cognitive runtime status...
        </div>
      </div>
    );
  }

  const o = result?.outcome;
  const ls = result?.loop_state;

  // Extract trace data
  const traceSteps = ls?.traces?.[0]?.steps ?? [];
  const baselineStep = traceSteps.find(s => s.action === 'baseline_query');
  const goalStep = traceSteps.find(s => s.action === 'goal_interpretation');
  const retrieveSteps = traceSteps.filter(s => s.action === 'retrieve');
  const adaptiveSteps = traceSteps.filter(s => s.action === 'adaptive_rewrite');
  const planStepTraces = traceSteps.filter(s => s.action.startsWith('plan_step:'));
  const isPlanDriven = planStepTraces.length > 0;

  // Domain-aware classification data
  const domainStep = traceSteps.find(s => s.action === 'domain_classification');
  const domainInfo = domainStep?.output?.domain as { domain?: string; confidence?: number; matchedKeywords?: string[] } | undefined;
  const intentInfo = domainStep?.output?.intent as { primary?: string } | undefined;
  const freshnessInfo = domainStep?.output?.freshness as { level?: string } | undefined;
  const privacyModeUsed = domainStep?.output?.privacyMode as string | undefined;

  // Tool augmentation trace data
  const toolAugSteps = traceSteps.filter(s => s.action === 'tool_augmentation');
  const toolAugSkipStep = traceSteps.find(s => s.action === 'tool_augmentation_skipped');

  // Evidence gate trace data
  const evidenceGateStep = traceSteps.find(s => s.action === 'evidence_gate');
  const gateResult = evidenceGateStep?.output as {
    sufficient?: boolean; qualityScore?: number; accepted?: number; rejected?: number;
    domainMismatch?: boolean; mismatchDetail?: string; reason?: string;
    rejectionReasons?: string[];
  } | undefined;

  // Count internal vs external evidence
  const internalEvidenceCount = o?.evidence?.filter(e => !e.documentId?.startsWith('external:'))?.length ?? 0;
  const externalEvidenceCount = o?.evidence?.filter(e => e.documentId?.startsWith('external:'))?.length ?? 0;

  // Pipeline diagnostics from outcome
  const diag = (o as any)?.diagnostics as {
    rawInternalCount?: number; acceptedInternalCount?: number; rejectedInternalCount?: number;
    externalCount?: number; synthesisSource?: string; simpleAnswerMode?: boolean;
  } | undefined;

  // Get query variants from trace
  const queryVariants: Array<{ text: string; strategy: string; weight?: number }> =
    goalStep?.output?.variants ?? [];

  return (
    <div className="page-container" ref={guardRef}>
      <div className="page-header">
        <h1>Cognitive</h1>
        <p>Frontier Autonomous Research Agent</p>
      </div>

      {uiMismatch && (
        <div
          onClick={() => window.location.reload()}
          style={{
            padding: '10px', marginBottom: 'var(--spacing-lg)', textAlign: 'center',
            cursor: 'pointer', borderRadius: 'var(--radius-md)',
            background: '#f8544422', border: '1px solid #f85444',
            color: '#f85444', fontSize: '14px', fontWeight: 600,
          }}
        >
          UI build mismatch detected — click to refresh
        </div>
      )}

      {/* Status chips — driven by real backend probe */}
      <div style={{ display: 'flex', gap: '10px', marginBottom: 'var(--spacing-lg)', flexWrap: 'wrap' }}>
        <span
          title={status?.enabled ? 'Cognitive engine is enabled and ready.' : 'Cognitive engines offline — the memory-api reasoning engine and agent loops are both unavailable.'}
          style={{
            padding: '5px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 600,
            background: status?.enabled ? '#1b3a2d' : '#3a1b1b',
            color: status?.enabled ? '#3fb950' : '#f85149',
            cursor: 'help',
          }}
        >
          Cognitive: {status?.enabled ? 'Enabled (memory-api + agent loops)' : 'Unavailable — engines offline'}
        </span>
        <span
          title={status?.memoryGateway?.healthy ? 'Memory gateway is connected.' : 'The cognitive memory gateway is not wired. Note: the Memory tab itself (long-term memory + retrieval) works independently and is unaffected.'}
          style={{
            padding: '5px 14px', borderRadius: '20px', fontSize: '13px', fontWeight: 600,
            background: status?.memoryGateway?.healthy ? '#1b3a2d' : '#3a1b1b',
            color: status?.memoryGateway?.healthy ? '#3fb950' : '#f85149',
            cursor: 'help',
          }}
        >
          Memory Gateway: {status?.memoryGateway?.healthy ? 'Connected' : 'Unavailable (Memory tab unaffected)'}
        </span>
      </div>

      {error && (
        <div style={{
          margin: '0 0 var(--spacing-lg)',
          padding: 'var(--spacing-md)',
          background: '#f8544422',
          border: '1px solid #f85444',
          borderRadius: 'var(--radius-md)',
          color: '#f85444',
          fontSize: 'var(--text-sm)',
        }}>
          {error}
        </div>
      )}

      {/* Input section */}
      <div style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-primary)',
        borderRadius: 'var(--radius-lg)',
        padding: 'var(--spacing-lg)',
        marginBottom: 'var(--spacing-lg)',
      }}>
        <div style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
          <input
            type="text"
            value={goal}
            onChange={e => setGoal(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') runCognitive(); }}
            placeholder="Enter research goal or question..."
            style={{
              flex: 1, padding: '10px 14px',
              background: 'var(--bg-primary)', border: '1px solid var(--border-primary)',
              borderRadius: 'var(--radius-md)', color: 'var(--text-primary)',
              fontSize: '14px', outline: 'none',
            }}
          />
          <button
            onClick={runCognitive}
            disabled={running || !goal.trim()}
            style={{
              padding: '10px 24px', border: 'none', borderRadius: 'var(--radius-md)',
              fontSize: '14px', fontWeight: 600, cursor: running ? 'wait' : 'pointer',
              background: running ? '#1b3a2d' : '#238636', color: '#fff',
            }}
          >
            {running ? 'Running...' : 'Run Cognitive Loop'}
          </button>
        </div>
        {/* Mode selector */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
          {(['baseline', 'fast', 'balanced', 'deep'] as RuntimeMode[]).map(m => (
            <button
              key={m}
              onClick={() => setMode(m)}
              style={{
                padding: '5px 14px', border: 'none', borderRadius: '14px',
                fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                background: mode === m ? '#238636' : 'var(--bg-tertiary)',
                color: mode === m ? '#fff' : 'var(--text-secondary)',
                textTransform: 'capitalize',
              }}
            >
              {m}
            </button>
          ))}
          <span style={{ fontSize: '11px', color: '#D1D5DB', alignSelf: 'center', marginLeft: '8px' }}>
            {mode === 'baseline' ? '0 iterations — raw memory query only' :
             mode === 'fast' ? '≤2 iterations — quick answer' :
             mode === 'balanced' ? '≤5 iterations — standard depth' :
             '≤10 iterations — full analysis'}
          </span>
        </div>

        {/* Search Privacy Mode selector */}
        <div style={{ display: 'flex', gap: '6px', marginBottom: '10px', alignItems: 'center' }}>
          <span style={{ fontSize: '12px', color: '#D1D5DB', marginRight: '4px', fontWeight: 600 }}>Search:</span>
          {([
            { mode: 'private' as SearchPrivacyMode, icon: '\uD83D\uDD12', label: 'Private' },
            { mode: 'auto' as SearchPrivacyMode, icon: '\u26A1', label: 'Auto' },
            { mode: 'open' as SearchPrivacyMode, icon: '\uD83C\uDF10', label: 'Open' },
          ]).map(({ mode: pm, icon, label }) => (
            <button
              key={pm}
              onClick={() => setSearchPrivacy(pm)}
              style={{
                padding: '4px 12px', border: 'none', borderRadius: '14px',
                fontSize: '12px', fontWeight: 600, cursor: 'pointer',
                background: searchPrivacy === pm
                  ? pm === 'private' ? '#1b3a2d' : pm === 'auto' ? '#332d1a' : '#1c2333'
                  : 'var(--bg-tertiary)',
                color: searchPrivacy === pm
                  ? pm === 'private' ? '#3fb950' : pm === 'auto' ? '#d29922' : '#79c0ff'
                  : 'var(--text-secondary)',
              }}
            >
              {icon} {label}
            </button>
          ))}
          <span style={{ fontSize: '11px', color: '#D1D5DB', marginLeft: '8px' }}>
            {searchPrivacy === 'private' ? 'Official sources preferred, privacy-friendly search' :
             searchPrivacy === 'auto' ? 'Domain policy drives tool selection' :
             'All tools available, maximum coverage'}
          </span>
        </div>

        <div style={{ display: 'flex', gap: '14px', fontSize: '13px', color: 'var(--text-secondary)' }}>
          <label style={{ cursor: 'pointer' }}>
            <input type="radio" name="scope" checked={scopeMode === 'all'} onChange={() => setScopeMode('all')} style={{ marginRight: '4px' }} />
            All Documents
          </label>
          <label style={{ cursor: 'pointer' }}>
            <input type="radio" name="scope" checked={scopeMode === 'selected'} onChange={() => setScopeMode('selected')} style={{ marginRight: '4px' }} />
            Selected Documents
          </label>
        </div>
        {scopeMode === 'selected' && (
          <div style={{
            marginTop: '8px', padding: '8px',
            background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)',
            maxHeight: '120px', overflowY: 'auto',
          }}>
            {documents.length === 0 ? (
              <span style={{ color: '#F5F7FF', fontStyle: 'italic', fontSize: '13px', fontWeight: 500 }}>No documents ingested</span>
            ) : documents.map(d => (
              <label key={d.document_id} style={{ display: 'block', padding: '3px 0', fontSize: '13px', color: 'var(--text-secondary)', cursor: 'pointer' }}>
                <input type="checkbox" checked={selectedDocs.has(d.document_id)} onChange={() => toggleDoc(d.document_id)} style={{ marginRight: '6px' }} />
                {(d.title || d.document_id).substring(0, 60)} ({d.chunk_count || 0} chunks)
              </label>
            ))}
          </div>
        )}
      </div>

      {/* Answer */}
      {(o || running) && (
        <Panel title="Answer" full>
          {running ? (
            <div style={{ padding: '14px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
                <div style={{
                  width: '16px', height: '16px', border: '2px solid var(--color-primary)',
                  borderTopColor: 'transparent', borderRadius: '50%',
                  animation: 'spin 0.8s linear infinite',
                }} />
                <span style={{ color: 'var(--color-primary)', fontSize: '14px', fontWeight: 600 }}>
                  {progressPhase || 'Processing...'}
                </span>
              </div>
              <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
            </div>
          ) : o?.answer ? (
            <div>
              {/* Source origin + model/provider badges */}
              <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
                {/* Synthesis source badge */}
                {result?.reasoning?.synthesisSource && result.reasoning.synthesisSource !== 'none' && (
                  <span style={{
                    padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 700,
                    background: result.reasoning.synthesisSource === 'memory' ? '#1b3a2d'
                      : result.reasoning.synthesisSource === 'internet' ? '#1c2333' : '#332d1a',
                    color: result.reasoning.synthesisSource === 'memory' ? '#3fb950'
                      : result.reasoning.synthesisSource === 'internet' ? '#79c0ff' : '#d29922',
                  }}>
                    {result.reasoning.synthesisSource === 'memory' ? '📚 Memory Only'
                      : result.reasoning.synthesisSource === 'internet' ? '🌐 Internet Only'
                      : '📚+🌐 Memory + Internet'}
                  </span>
                )}
                {result?.reasoning?.synthesisSource === 'memory' && (
                  <span style={{
                    padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 600,
                    background: 'var(--bg-tertiary)', color: '#D1D5DB',
                  }}>
                    Internet not used
                  </span>
                )}
                {/* Provider/model badge */}
                {result?.reasoning?.provider && result.reasoning.provider !== 'none' && (
                  <span style={{
                    padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 700,
                    background: result.reasoning.provider === 'deterministic' ? '#1b3a2d'
                      : result.reasoning.provider === 'ollama' ? '#332d1a' : '#1c2333',
                    color: result.reasoning.provider === 'deterministic' ? '#3fb950'
                      : result.reasoning.provider === 'ollama' ? '#d29922' : '#79c0ff',
                  }}>
                    {result.reasoning.provider === 'deterministic' ? '⚡ Deterministic'
                      : result.reasoning.provider === 'ollama' ? `🦙 Ollama: ${result.reasoning.model || 'local'}`
                      : `🔷 Anthropic: ${result.reasoning.model || 'claude'}`}
                  </span>
                )}
              </div>
              <div style={{
                padding: '14px', background: 'var(--bg-primary)',
                border: '1px solid var(--border-primary)',
                borderLeft: '3px solid var(--color-success)',
                borderRadius: 'var(--radius-md)',
                fontSize: '14px', lineHeight: '1.5', whiteSpace: 'pre-wrap',
              }}>
                {o.answer?.replace(/```json\s*\[[\s\S]*?\]\s*```/g, '').replace(/\n\s*\[\s*\{[\s\S]*?"subject"[\s\S]*?\]\s*/g, '').trim()}
              </div>
            </div>
          ) : (
            <div>
              <div style={{
                padding: '14px', background: 'var(--bg-primary)',
                border: '1px solid var(--border-primary)',
                borderLeft: '3px solid var(--color-error)',
                borderRadius: 'var(--radius-md)',
                fontSize: '14px',
              }}>
                <div style={{ color: 'var(--text-primary)', fontWeight: 600, marginBottom: '6px' }}>
                  Insufficient evidence
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: '13px', lineHeight: '1.5' }}>
                  {result?.reasoning?.insufficientDetail
                    || 'No relevant evidence was found in the knowledge base for this query.'}
                </div>
                {o?.confidence?.basis === 'no-evidence' && (
                  <div style={{
                    marginTop: '8px', padding: '6px 10px',
                    background: 'var(--bg-tertiary)', borderRadius: 'var(--radius-sm)',
                    fontSize: '12px', color: 'var(--text-secondary)',
                  }}>
                    {internalEvidenceCount === 0 && externalEvidenceCount === 0
                      ? '📭 No documents matched this query — your ingested documents may not cover this topic.'
                      : `Found ${internalEvidenceCount} memory chunks and ${externalEvidenceCount} external items, but confidence was too low to generate a reliable answer.`}
                  </div>
                )}
              </div>
            </div>
          )}
        </Panel>
      )}

      {/* Domain-Aware Classification */}
      {o && domainInfo && (
        <Panel title="Classification" full>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '11px', color: '#D1D5DB', fontWeight: 600 }}>Domain:</span>
              <span style={{
                padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 700,
                background: domainInfo.domain === 'LEGAL' ? '#1c2333' : domainInfo.domain === 'SOFTWARE' ? '#1a332d' : domainInfo.domain === 'MIXED' ? '#332d1a' : '#2d1a33',
                color: domainInfo.domain === 'LEGAL' ? '#79c0ff' : domainInfo.domain === 'SOFTWARE' ? '#3fb950' : domainInfo.domain === 'MIXED' ? '#d29922' : '#d2a8ff',
              }}>
                {domainInfo.domain}
              </span>
            </div>
            {intentInfo?.primary && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '11px', color: '#D1D5DB', fontWeight: 600 }}>Intent:</span>
                <span style={{
                  padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600,
                  background: '#1c2333', color: '#79c0ff',
                }}>
                  {intentInfo.primary}
                </span>
              </div>
            )}
            {freshnessInfo?.level && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '11px', color: '#D1D5DB', fontWeight: 600 }}>Freshness:</span>
                <span style={{
                  padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600,
                  background: freshnessInfo.level === 'latest' ? '#3d1f1f' : freshnessInfo.level === 'current' ? '#332d1a' : 'var(--bg-tertiary)',
                  color: freshnessInfo.level === 'latest' ? '#f85149' : freshnessInfo.level === 'current' ? '#d29922' : '#D1D5DB',
                }}>
                  {freshnessInfo.level}
                </span>
              </div>
            )}
            {privacyModeUsed && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <span style={{ fontSize: '11px', color: '#D1D5DB', fontWeight: 600 }}>Search:</span>
                <span style={{
                  padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 600,
                  background: privacyModeUsed === 'private' ? '#1b3a2d' : privacyModeUsed === 'open' ? '#1c2333' : '#332d1a',
                  color: privacyModeUsed === 'private' ? '#3fb950' : privacyModeUsed === 'open' ? '#79c0ff' : '#d29922',
                }}>
                  {privacyModeUsed === 'private' ? '\uD83D\uDD12' : privacyModeUsed === 'open' ? '\uD83C\uDF10' : '\u26A1'} {privacyModeUsed}
                </span>
              </div>
            )}
          </div>
          {domainInfo.matchedKeywords && domainInfo.matchedKeywords.length > 0 && (
            <div style={{ marginTop: '8px', fontSize: '11px', color: 'var(--text-secondary)' }}>
              <span style={{ color: '#D1D5DB', fontWeight: 600 }}>Keywords: </span>
              {domainInfo.matchedKeywords.slice(0, 10).join(', ')}
            </div>
          )}
          {/* Evidence pool summary */}
          {(internalEvidenceCount > 0 || externalEvidenceCount > 0) && (
            <div style={{
              marginTop: '8px', padding: '6px 10px',
              background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)',
              fontSize: '12px', display: 'flex', gap: '16px',
            }}>
              <span style={{ color: 'var(--text-secondary)' }}>
                \uD83D\uDCDA Internal: <strong style={{ color: 'var(--text-primary)' }}>{internalEvidenceCount}</strong> chunks
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                \uD83C\uDF10 External: <strong style={{ color: 'var(--text-primary)' }}>{externalEvidenceCount}</strong> items
                {toolAugSteps.length > 0 && (
                  <span style={{ color: '#D1D5DB' }}>
                    {' '}from {toolAugSteps.length} tool{toolAugSteps.length > 1 ? 's' : ''}
                  </span>
                )}
              </span>
            </div>
          )}
        </Panel>
      )}

      {/* Evidence Gate */}
      {gateResult && (
        <Panel title="Evidence Gate" full>
          <div style={{
            padding: '10px',
            borderRadius: '8px',
            border: `1px solid ${gateResult.sufficient ? '#3fb950' : gateResult.domainMismatch ? '#f85149' : '#d29922'}`,
            background: gateResult.sufficient ? 'rgba(63,185,80,0.08)' : gateResult.domainMismatch ? 'rgba(248,81,73,0.08)' : 'rgba(210,153,34,0.08)',
          }}>
            <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center', marginBottom: '8px' }}>
              <span style={{
                padding: '3px 10px', borderRadius: '12px', fontSize: '12px', fontWeight: 700,
                background: gateResult.sufficient ? '#1b3a2d' : '#3d1a1a',
                color: gateResult.sufficient ? '#3fb950' : '#f85149',
              }}>
                {gateResult.sufficient ? '✅ Sufficient' : '❌ Insufficient'}
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                Quality: <b style={{ color: 'var(--text-primary)' }}>{(gateResult.qualityScore ?? 0).toFixed(2)}</b>
              </span>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                Accepted: <b style={{ color: '#3fb950' }}>{gateResult.accepted ?? 0}</b>
                {' / '}Rejected: <b style={{ color: '#f85149' }}>{gateResult.rejected ?? 0}</b>
              </span>
              {gateResult.domainMismatch && (
                <span style={{
                  padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 700,
                  background: '#3d1a1a', color: '#f85149',
                }}>
                  Domain Mismatch
                </span>
              )}
              {!gateResult.sufficient && externalEvidenceCount > 0 && (
                <span style={{
                  padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 700,
                  background: '#1c2333', color: '#79c0ff',
                }}>
                  Tool Escalation Triggered
                </span>
              )}
              {diag?.simpleAnswerMode && (
                <span style={{
                  padding: '3px 10px', borderRadius: '12px', fontSize: '11px', fontWeight: 700,
                  background: '#1b3a2d', color: '#3fb950',
                }}>
                  Simple Answer Mode
                </span>
              )}
            </div>
            {/* Pipeline diagnostics */}
            {diag && (
              <div style={{
                display: 'flex', gap: '16px', flexWrap: 'wrap', marginBottom: '8px',
                padding: '6px 10px', background: 'var(--bg-primary)', borderRadius: 'var(--radius-sm)', fontSize: '12px',
              }}>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Raw Internal: <b style={{ color: 'var(--text-primary)' }}>{diag.rawInternalCount ?? 0}</b>
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Accepted: <b style={{ color: '#3fb950' }}>{diag.acceptedInternalCount ?? 0}</b>
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Rejected: <b style={{ color: '#f85149' }}>{diag.rejectedInternalCount ?? 0}</b>
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  External: <b style={{ color: '#79c0ff' }}>{diag.externalCount ?? 0}</b>
                </span>
                <span style={{ color: 'var(--text-secondary)' }}>
                  Synthesis: <b style={{ color: diag.synthesisSource === 'external' ? '#79c0ff' : diag.synthesisSource === 'internal' ? '#3fb950' : diag.synthesisSource === 'mixed' ? '#d29922' : '#f85149' }}>
                    {diag.synthesisSource ?? 'none'}
                  </b>
                </span>
              </div>
            )}
            <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '6px' }}>
              {gateResult.reason}
            </div>
            {gateResult.mismatchDetail && (
              <div style={{ fontSize: '11px', color: '#f85149', marginBottom: '6px' }}>
                {gateResult.mismatchDetail}
              </div>
            )}
            {gateResult.rejectionReasons && gateResult.rejectionReasons.length > 0 && (
              <details style={{ fontSize: '11px', color: 'var(--text-secondary)' }}>
                <summary style={{ cursor: 'pointer', marginBottom: '4px' }}>
                  Rejection details ({gateResult.rejectionReasons.length})
                </summary>
                {gateResult.rejectionReasons.map((r: string, i: number) => (
                  <div key={i} style={{ padding: '2px 0', fontFamily: 'monospace', fontSize: '10px' }}>{r}</div>
                ))}
              </details>
            )}
          </div>
        </Panel>
      )}

      {/* Diagnostics */}
      {o && (
        <Panel title="Runtime Diagnostics" full>
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))',
            gap: '8px',
          }}>
            <StatCard label="Mode" value={(result?.mode || mode).toUpperCase()} />
            <StatCard label="Provider" value={result?.reasoning?.provider === 'ollama' ? 'Ollama' : result?.reasoning?.provider === 'anthropic' ? 'Anthropic' : result?.reasoning?.provider === 'deterministic' ? 'Deterministic' : 'None'} />
            <StatCard label="Model" value={result?.reasoning?.model ? String(result.reasoning.model).split(':')[0] : '—'} />
            <StatCard label="Source" value={result?.reasoning?.synthesisSource === 'memory' ? 'Memory' : result?.reasoning?.synthesisSource === 'internet' ? 'Internet' : result?.reasoning?.synthesisSource === 'mixed' ? 'Mixed' : 'None'} />
            <StatCard label="Iterations" value={o.iterationsUsed} />
            <StatCard label="Latency" value={`${(o.totalDurationMs / 1000).toFixed(1)}s`} />
            <StatCard label="Evidence" value={o.evidence.length} />
            <StatCard label="Entities" value={o.entities.length} />
            <StatCard label="Claims" value={o.claims.length} />
            <StatCard label="Contradictions" value={o.contradictions.length} />
            <StatCard label="Timeline" value={o.events.length} />
            <StatCard label="Confidence" value={`${(o.confidence.value * 100).toFixed(0)}%`} />
            <StatCard label="Phase" value={ls?.phase || '—'} />
            <StatCard label="Insights" value={ls?.insights?.length || 0} />
            <StatCard label="Tool Calls" value={ls?.toolExecutions?.length || 0} />
            <StatCard label="Mem Updates" value={ls?.memoryUpdates?.length || 0} />
          </div>
        </Panel>
      )}

      {/* Baseline Comparison */}
      {o && baselineStep && (
        <Panel title="Baseline vs Frontier Comparison" full>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div style={{
              padding: '12px', background: 'var(--bg-primary)',
              border: '1px solid var(--border-secondary)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{ fontSize: '12px', color: '#D1D5DB', marginBottom: '6px', textTransform: 'uppercase', fontWeight: 600 }}>
                Baseline (Memory API)
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Evidence: <strong style={{ color: 'var(--text-primary)' }}>{baselineStep.output?.evidenceCount ?? 0}</strong>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Confidence: <strong style={{ color: 'var(--text-primary)' }}>{((baselineStep.output?.confidence ?? 0) * 100).toFixed(0)}%</strong>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Answered: <strong style={{ color: baselineStep.output?.hasAnswer ? '#3fb950' : '#f85149' }}>
                  {baselineStep.output?.hasAnswer ? 'Yes' : 'Abstained'}
                </strong>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Latency: <strong style={{ color: 'var(--text-primary)' }}>{baselineStep.output?.elapsedMs ?? 0}ms</strong>
              </div>
            </div>
            <div style={{
              padding: '12px', background: 'var(--bg-primary)',
              border: '1px solid var(--border-secondary)',
              borderRadius: 'var(--radius-md)',
            }}>
              <div style={{ fontSize: '12px', color: 'var(--color-primary)', marginBottom: '6px', textTransform: 'uppercase', fontWeight: 600 }}>
                Frontier (Cognitive Loop)
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Evidence: <strong style={{ color: 'var(--text-primary)' }}>{o.evidence.length}</strong>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Confidence: <strong style={{ color: 'var(--text-primary)' }}>{(o.confidence.value * 100).toFixed(0)}%</strong>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Answered: <strong style={{ color: o.success ? '#3fb950' : '#f85149' }}>
                  {o.success ? 'Yes' : 'Abstained'}
                </strong>
              </div>
              <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                Latency: <strong style={{ color: 'var(--text-primary)' }}>{o.totalDurationMs}ms</strong>
              </div>
            </div>
          </div>
        </Panel>
      )}

      {/* Two-column panels */}
      {o && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)' }}>
          {/* Rewritten Queries */}
          <Panel title="Rewritten Queries">
            {queryVariants.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                {queryVariants.map((v: any, i: number) => (
                  <div key={i} style={{
                    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                    background: 'var(--bg-tertiary)', borderRadius: '4px',
                    padding: '4px 8px', fontSize: '12px',
                  }}>
                    <span style={{ color: 'var(--text-secondary)', flex: 1, marginRight: '8px' }}>
                      {typeof v === 'string' ? v : v.text}
                    </span>
                    {typeof v === 'object' && v.strategy && (
                      <span style={{
                        color: 'var(--color-primary)', fontSize: '10px',
                        background: 'var(--bg-primary)', borderRadius: '3px',
                        padding: '1px 5px', whiteSpace: 'nowrap',
                      }}>
                        {v.strategy}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ) : <Empty>No query variants</Empty>}

            {/* Adaptive rewrites */}
            {adaptiveSteps.length > 0 && (
              <div style={{ marginTop: '8px', borderTop: '1px solid var(--border-secondary)', paddingTop: '6px' }}>
                <div style={{ fontSize: '11px', color: '#D1D5DB', marginBottom: '4px' }}>
                  Adaptive rewrites (iteration recovery):
                </div>
                {adaptiveSteps.map((step, i) => (
                  <div key={i} style={{ fontSize: '12px', color: '#d29922', padding: '2px 0' }}>
                    {step.output?.variants?.map((v: any) => typeof v === 'string' ? v : v.text).join(' | ')}
                  </div>
                ))}
              </div>
            )}
          </Panel>

          {/* Research Plan — Enhanced with per-step execution data */}
          <Panel title={isPlanDriven ? 'Research Plan (Plan-Driven)' : 'Research Plan'}>
            {ls?.plan?.taskGraph?.length ? (
              ls.plan.taskGraph.map((t: PlanTask, idx: number) => {
                // Find matching trace step for this task
                const traceMatch = planStepTraces.find(s => s.input?.taskId === t.id);
                const stepQueries: Array<{ text: string; strategy: string }> = traceMatch?.input?.queries ?? [];
                const newEvidence = traceMatch?.output?.newEvidence ?? 0;
                const durationMs = traceMatch?.durationMs ?? 0;

                return (
                  <div key={t.id} style={{
                    background: 'var(--bg-primary)',
                    border: `1px solid ${t.status === 'completed' ? '#238636' : t.status === 'running' ? '#d29922' : 'var(--border-secondary)'}`,
                    borderRadius: 'var(--radius-md)',
                    padding: '8px 10px', marginBottom: '6px',
                  }}>
                    <div style={{
                      display: 'flex', gap: '6px', alignItems: 'center',
                      fontSize: '13px',
                      color: t.status === 'completed' ? 'var(--color-success)' : t.status === 'failed' ? '#f85149' : 'var(--text-secondary)',
                    }}>
                      <span style={{ fontSize: '14px' }}>
                        {t.status === 'completed' ? '\u2713' : t.status === 'running' ? '\u25cf' : t.status === 'failed' ? '\u2717' : '\u2022'}
                      </span>
                      <span style={{ flex: 1, fontWeight: 500 }}>{t.description || t.id}</span>
                      <span style={{
                        fontSize: '10px', background: t.type === 'retrieve' ? '#1c2333' : 'var(--bg-tertiary)',
                        borderRadius: '3px', padding: '1px 5px',
                        color: t.type === 'retrieve' ? '#79c0ff' : t.type === 'analyze' ? '#d29922' : t.type === 'synthesize' ? '#d2a8ff' : '#D1D5DB',
                      }}>
                        {t.type}
                      </span>
                      {durationMs > 0 && (
                        <span style={{ fontSize: '10px', color: '#D1D5DB' }}>
                          {(durationMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>

                    {/* Show query hints if present */}
                    {t.queryHints && t.queryHints.length > 0 && (
                      <div style={{ marginTop: '4px', fontSize: '11px' }}>
                        <span style={{ color: '#9AE6FF', fontWeight: 600 }}>Hints: </span>
                        <span style={{ color: 'var(--text-secondary)' }}>{t.queryHints.join(' | ')}</span>
                      </div>
                    )}

                    {/* Show queries executed (from trace) */}
                    {stepQueries.length > 0 && (
                      <div style={{ marginTop: '4px' }}>
                        {stepQueries.map((q, qi) => (
                          <div key={qi} style={{
                            display: 'flex', gap: '4px', alignItems: 'center',
                            fontSize: '11px', padding: '2px 0',
                          }}>
                            <span style={{ color: 'var(--text-tertiary)' }}>\u2192</span>
                            <span style={{
                              color: '#FFFFFF', fontWeight: 500, flex: 1,
                              background: 'rgba(255,255,255,0.04)', borderRadius: '3px',
                              padding: '1px 6px', fontFamily: "'Roboto Mono', monospace",
                            }}>
                              {q.text.substring(0, 80)}
                            </span>
                            <span style={{
                              fontSize: '9px', background: 'var(--bg-tertiary)',
                              borderRadius: '3px', padding: '0 4px', color: 'var(--color-primary)',
                            }}>
                              {q.strategy}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* Show evidence gathered */}
                    {t.status === 'completed' && newEvidence > 0 && (
                      <div style={{
                        marginTop: '4px', fontSize: '11px',
                        color: '#3fb950', fontWeight: 500,
                      }}>
                        +{newEvidence} evidence
                      </div>
                    )}
                  </div>
                );
              })
            ) : <Empty>No plan generated</Empty>}
          </Panel>
        </div>
      )}

      {/* Execution Trace — plan-driven or iteration-based */}
      {o && (isPlanDriven ? planStepTraces.length > 0 : retrieveSteps.length > 0) && (
        <Panel title={isPlanDriven ? 'Plan Step Execution Trace' : 'Retrieval Trace (per iteration)'} full>
          {isPlanDriven ? (
            planStepTraces.map((step, i) => {
              const stepType = step.action.replace('plan_step:', '');
              const queries: Array<{ text: string; strategy: string }> = step.input?.queries ?? [];
              return (
                <div key={i} style={{
                  background: 'var(--bg-primary)',
                  border: '1px solid var(--border-secondary)',
                  borderRadius: 'var(--radius-md)',
                  padding: '8px 12px', marginBottom: '6px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div>
                      <span style={{
                        fontSize: '11px', padding: '1px 6px', borderRadius: '3px', marginRight: '6px',
                        background: stepType === 'retrieve' ? '#1c2333' : stepType === 'analyze' ? '#332d1a' : '#2d1a33',
                        color: stepType === 'retrieve' ? '#79c0ff' : stepType === 'analyze' ? '#d29922' : '#d2a8ff',
                      }}>
                        {stepType}
                      </span>
                      <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                        {step.input?.description?.substring(0, 80) ?? `Step ${i + 1}`}
                      </span>
                    </div>
                    <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
                      {(step.output?.newEvidence ?? 0) > 0 && (
                        <span style={{ fontSize: '12px', color: '#3fb950', fontWeight: 600 }}>
                          +{step.output.newEvidence} evidence
                        </span>
                      )}
                      <span style={{ fontSize: '11px', color: '#D1D5DB' }}>
                        {(step.durationMs / 1000).toFixed(1)}s
                      </span>
                    </div>
                  </div>
                  {queries.length > 0 && (
                    <div style={{ marginTop: '6px' }}>
                      <div style={{ fontSize: '10px', color: '#9AE6FF', marginBottom: '3px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>Queries:</div>
                      {queries.map((q, qi) => (
                        <div key={qi} style={{
                          fontSize: '11px', color: '#FFFFFF', fontWeight: 500,
                          background: 'rgba(255,255,255,0.05)', borderRadius: '4px',
                          padding: '3px 8px', marginBottom: '2px',
                          fontFamily: "'Roboto Mono', monospace",
                        }}>
                          &quot;{q.text.substring(0, 50)}&quot;
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          ) : (
            retrieveSteps.map((step, i) => (
              <div key={i} style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-secondary)',
                borderRadius: 'var(--radius-md)',
                padding: '8px 12px', marginBottom: '6px',
                display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <div>
                  <span style={{ fontSize: '12px', color: '#D1D5DB' }}>Iteration {i + 1}: </span>
                  <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>
                    {step.output?.newEvidence ?? 0} new evidence ({step.output?.totalEvidence ?? 0} total)
                  </span>
                  {step.input?.variants && (
                    <div style={{ fontSize: '11px', marginTop: '4px' }}>
                      <span style={{ color: '#9AE6FF', fontWeight: 600 }}>Queries: </span>
                      <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>
                        {(step.input.variants as any[]).map(v => { const t = typeof v === 'string' ? v : v?.text ?? ''; return `"${t.substring(0, 50)}"`; }).join(', ')}
                      </span>
                    </div>
                  )}
                </div>
                <span style={{ fontSize: '11px', color: '#D1D5DB' }}>{step.durationMs}ms</span>
              </div>
            ))
          )}
        </Panel>
      )}

      {/* Evidence full-width */}
      {o && (
        <Panel title="Evidence Used" full>
          {o.evidence.length > 0 ? (
            o.evidence.map((e, i) => (
              <div key={i} style={{
                background: 'var(--bg-primary)',
                border: '1px solid var(--border-secondary)',
                borderRadius: 'var(--radius-md)',
                padding: '10px', marginBottom: '8px',
              }}>
                <div style={{ fontSize: '12px', color: 'var(--color-primary)', marginBottom: '4px' }}>
                  Document: {e.documentId}
                </div>
                <div style={{ fontSize: '13px', color: 'var(--text-secondary)', lineHeight: '1.4' }}>
                  {e.text?.substring(0, 300)}
                </div>
                <div style={{ fontSize: '11px', marginTop: '4px' }}>
                  <span style={{ color: '#A8E6FF' }}>Score: </span>
                  <span style={{ color: '#FFFFFF' }}>{e.score?.toFixed(3)}</span>
                  <span style={{ color: '#D1D5DB' }}> | </span>
                  <span style={{ color: '#B6FFB0' }}>Chunk: </span>
                  <span style={{ color: '#FFFFFF' }}>{e.chunkId}</span>
                </div>
              </div>
            ))
          ) : <Empty>No evidence retrieved</Empty>}
        </Panel>
      )}

      {/* World Model row */}
      {o && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)' }}>
          <Panel title="World Model — Entities">
            {o.entities.length > 0 ? (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                {o.entities.map((e, i) => (
                  <span key={i} style={{
                    display: 'inline-block', background: '#1c2333',
                    color: '#79c0ff', borderRadius: '12px',
                    padding: '3px 10px', fontSize: '12px',
                  }}>
                    {e.name} <small>({e.type})</small>
                  </span>
                ))}
              </div>
            ) : <Empty>No entities extracted</Empty>}
          </Panel>

          <Panel title="World Model — Claims">
            {o.claims.length > 0 ? (
              o.claims.slice(0, 15).map((c, i) => (
                <div key={i} style={{
                  fontSize: '13px', color: 'var(--text-secondary)',
                  padding: '4px 0', borderBottom: '1px solid var(--border-secondary)',
                }}>
                  <span style={{ color: '#79c0ff', fontWeight: 600, fontSize: '12px' }}>
                    {String(c.subject).substring(0, 30)}
                  </span>
                  {' '}
                  <span style={{ color: '#d29922', fontSize: '12px' }}>{c.predicate}</span>
                  {' '}
                  <span>{String(c.object).substring(0, 80)}</span>
                </div>
              ))
            ) : <Empty>No claims extracted</Empty>}
          </Panel>
        </div>
      )}

      {/* Contradictions + Timeline */}
      {o && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)' }}>
          <Panel title="Contradictions">
            {o.contradictions.length > 0 ? (
              o.contradictions.map((c, i) => (
                <div key={i} style={{
                  background: '#3d1f1f', border: '1px solid #f8514933',
                  borderRadius: 'var(--radius-md)',
                  padding: '8px', marginBottom: '6px', fontSize: '13px',
                }}>
                  <strong>{c.severity}:</strong> {c.description}
                </div>
              ))
            ) : <Empty>No contradictions detected</Empty>}
          </Panel>

          <Panel title={`Timeline (${o.events.length} events)`}>
            {o.events.length > 0 ? (
              o.events.map((e: any, i: number) => (
                <div key={i} style={{
                  fontSize: '13px', color: 'var(--text-secondary)',
                  padding: '4px 0 4px 10px',
                  borderLeft: `2px solid ${e.timestamp?.isoDate ? 'var(--color-primary)' : 'var(--border-primary)'}`,
                  marginBottom: '4px',
                }}>
                  <strong style={{ color: e.timestamp?.isoDate ? '#79c0ff' : '#D1D5DB' }}>
                    {e.timestamp?.isoDate || e.timestamp?.raw || e.timestamp?.display || '?'}
                  </strong>
                  {' '}<span style={{ color: '#d29922' }}>[{e.action}]</span>{' '}
                  {(e.description || '').substring(0, 120)}
                </div>
              ))
            ) : <Empty>No timeline events</Empty>}
          </Panel>
        </div>
      )}

      {/* Insights + Tools */}
      {o && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--spacing-md)' }}>
          <Panel title="Reflection Insights">
            {(ls?.insights?.length || 0) > 0 ? (
              ls!.insights.map((ins, i) => (
                <div key={i} style={{
                  background: '#1c2333', borderRadius: '4px',
                  padding: '6px 10px', marginBottom: '4px', fontSize: '13px',
                }}>
                  <strong style={{ color: 'var(--color-primary)' }}>{ins.type}:</strong>{' '}
                  <span style={{ color: 'var(--text-secondary)' }}>{ins.description}</span>
                </div>
              ))
            ) : <Empty>No reflection insights</Empty>}
          </Panel>

          <Panel title="Tool Executions">
            {(ls?.toolExecutions?.length || 0) > 0 ? (
              ls!.toolExecutions.map((t, i) => (
                <div key={i} style={{
                  background: 'var(--bg-primary)',
                  border: `1px solid ${t.success ? '#23863644' : '#f8514933'}`,
                  borderRadius: 'var(--radius-md)',
                  padding: '8px 10px', marginBottom: '6px',
                }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                      <span style={{ fontSize: '14px', color: t.success ? '#3fb950' : '#f85149' }}>
                        {t.success ? '\u2713' : '\u2717'}
                      </span>
                      <span style={{ fontSize: '13px', color: 'var(--text-primary)', fontWeight: 600 }}>
                        {t.toolName}
                      </span>
                      {t.provider && (
                        <span style={{
                          fontSize: '10px', padding: '1px 6px', borderRadius: '3px',
                          background: '#1c2333', color: '#79c0ff',
                        }}>
                          {t.provider}
                        </span>
                      )}
                    </div>
                    <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                      {typeof t.trustScore === 'number' && (
                        <span style={{
                          fontSize: '10px', padding: '1px 6px', borderRadius: '3px',
                          background: t.trustScore >= 0.8 ? '#1b3a2d' : t.trustScore >= 0.5 ? '#332d1a' : '#3d1f1f',
                          color: t.trustScore >= 0.8 ? '#3fb950' : t.trustScore >= 0.5 ? '#d29922' : '#f85149',
                          fontWeight: 600,
                        }}>
                          Trust: {(t.trustScore * 100).toFixed(0)}%
                        </span>
                      )}
                      {typeof t.latencyMs === 'number' && (
                        <span style={{ fontSize: '10px', color: '#D1D5DB' }}>
                          {(t.latencyMs / 1000).toFixed(1)}s
                        </span>
                      )}
                    </div>
                  </div>
                  {t.sourceUrl && (
                    <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '3px' }}>
                      {t.sourceUrl}
                    </div>
                  )}
                  {typeof t.evidenceCount === 'number' && t.evidenceCount > 0 && (
                    <div style={{ fontSize: '11px', color: '#3fb950', marginTop: '2px', fontWeight: 500 }}>
                      +{t.evidenceCount} evidence
                    </div>
                  )}
                  {t.result && (
                    <div style={{
                      fontSize: '11px', color: 'var(--text-secondary)', marginTop: '4px',
                      maxHeight: '40px', overflow: 'hidden', opacity: 0.7,
                    }}>
                      {t.result.substring(0, 200)}
                    </div>
                  )}
                </div>
              ))
            ) : <Empty>No tool calls made</Empty>}
          </Panel>
        </div>
      )}

      {/* Benchmark Section */}
      <div style={{
        marginTop: 'var(--spacing-xl)',
        borderTop: '2px solid var(--border-primary)',
        paddingTop: 'var(--spacing-lg)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: 'var(--spacing-md)' }}>
          <h2 style={{ margin: 0, fontSize: '18px', color: 'var(--text-primary)' }}>
            Frontier Benchmark
          </h2>
          <button
            onClick={runBenchmark}
            disabled={benchmarkRunning}
            style={{
              padding: '6px 18px', border: 'none', borderRadius: 'var(--radius-md)',
              fontSize: '13px', fontWeight: 600, cursor: benchmarkRunning ? 'wait' : 'pointer',
              background: benchmarkRunning ? '#1b3a2d' : '#8957e5', color: '#fff',
            }}
          >
            {benchmarkRunning ? 'Running Benchmark...' : 'Run 6-Query Benchmark'}
          </button>
          <span style={{ fontSize: '12px', color: '#D1D5DB' }}>
            Runs all 6 queries in deep mode, compares baseline vs frontier
          </span>
        </div>

        {benchmarkResults.length > 0 && (
          <Panel title="Benchmark Results — Baseline vs Frontier" full>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '12px' }}>
                <thead>
                  <tr style={{ borderBottom: '2px solid var(--border-primary)' }}>
                    <th style={{ padding: '6px 8px', textAlign: 'left', color: '#D1D5DB' }}>Query</th>
                    <th style={{ padding: '6px 8px', textAlign: 'left', color: '#D1D5DB' }}>Category</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Baseline</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Frontier</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Entities</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Claims</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Contradictions</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Events</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Iters</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Latency</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Advantage</th>
                    <th style={{ padding: '6px 8px', textAlign: 'center', color: '#D1D5DB' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {benchmarkResults.map((row, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid var(--border-secondary)' }}>
                      <td style={{ padding: '6px 8px', color: 'var(--text-secondary)', maxWidth: '200px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {row.query.substring(0, 60)}...
                      </td>
                      <td style={{ padding: '6px 8px' }}>
                        <span style={{
                          padding: '1px 6px', borderRadius: '3px', fontSize: '10px',
                          background: row.category.includes('Frontier') || row.category.includes('Timeline') || row.category.includes('Contradiction') || row.category.includes('Causal')
                            ? '#8957e533' : '#23863633',
                          color: row.category.includes('Frontier') || row.category.includes('Timeline') || row.category.includes('Contradiction') || row.category.includes('Causal')
                            ? '#d2a8ff' : '#56d364',
                        }}>
                          {row.category}
                        </span>
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                        {(row.baselineConfidence * 100).toFixed(0)}%
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--color-primary)', fontWeight: 600 }}>
                        {(row.frontierConfidence * 100).toFixed(0)}%
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', color: row.entities > 0 ? '#79c0ff' : '#D1D5DB' }}>
                        {row.entities}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', color: row.claims > 0 ? '#79c0ff' : '#D1D5DB' }}>
                        {row.claims}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', color: row.contradictions > 0 ? '#f85149' : '#D1D5DB' }}>
                        {row.contradictions}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', color: row.events > 0 ? '#d29922' : '#D1D5DB' }}>
                        {row.events}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                        {row.iterations}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'center', color: 'var(--text-secondary)' }}>
                        {(row.latencyMs / 1000).toFixed(1)}s
                      </td>
                      <td style={{
                        padding: '6px 8px', textAlign: 'center', fontWeight: 700,
                        color: row.advantage > 0.1 ? '#3fb950' : row.advantage > 0 ? '#d29922' : '#D1D5DB',
                      }}>
                        {row.advantage > 0 ? '+' : ''}{row.advantage.toFixed(2)}
                      </td>
                      <td style={{ padding: '6px 8px', textAlign: 'center' }}>
                        {row.status === 'done' ? (
                          <span style={{ color: '#3fb950' }}>{'\u2713'}</span>
                        ) : row.status === 'running' ? (
                          <span style={{ color: '#d29922' }}>{'\u25cf'}</span>
                        ) : row.status === 'error' ? (
                          <span style={{ color: '#f85149' }}>{'\u2717'}</span>
                        ) : (
                          <span style={{ color: '#D1D5DB' }}>{'\u2022'}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Summary row */}
            {benchmarkResults.every(r => r.status === 'done' || r.status === 'error') && benchmarkResults.some(r => r.status === 'done') && (
              <div style={{
                marginTop: '12px', padding: '10px',
                background: 'var(--bg-primary)', borderRadius: 'var(--radius-md)',
                display: 'flex', gap: '24px', fontSize: '13px',
              }}>
                <div>
                  <span style={{ color: '#D1D5DB' }}>Avg Baseline: </span>
                  <strong style={{ color: 'var(--text-primary)' }}>
                    {(benchmarkResults.filter(r => r.status === 'done').reduce((s, r) => s + r.baselineConfidence, 0) / benchmarkResults.filter(r => r.status === 'done').length * 100).toFixed(0)}%
                  </strong>
                </div>
                <div>
                  <span style={{ color: '#D1D5DB' }}>Avg Frontier: </span>
                  <strong style={{ color: 'var(--color-primary)' }}>
                    {(benchmarkResults.filter(r => r.status === 'done').reduce((s, r) => s + r.frontierConfidence, 0) / benchmarkResults.filter(r => r.status === 'done').length * 100).toFixed(0)}%
                  </strong>
                </div>
                <div>
                  <span style={{ color: '#D1D5DB' }}>Total Advantage: </span>
                  <strong style={{ color: '#3fb950' }}>
                    +{benchmarkResults.filter(r => r.status === 'done').reduce((s, r) => s + r.advantage, 0).toFixed(2)}
                  </strong>
                </div>
                <div>
                  <span style={{ color: '#D1D5DB' }}>Total Entities: </span>
                  <strong style={{ color: '#79c0ff' }}>
                    {benchmarkResults.filter(r => r.status === 'done').reduce((s, r) => s + r.entities, 0)}
                  </strong>
                </div>
                <div>
                  <span style={{ color: '#D1D5DB' }}>Total Events: </span>
                  <strong style={{ color: '#d29922' }}>
                    {benchmarkResults.filter(r => r.status === 'done').reduce((s, r) => s + r.events, 0)}
                  </strong>
                </div>
              </div>
            )}
          </Panel>
        )}

        {/* ─── Agent Orchestration Trace ────────────────────────────── */}
        <AgentTracePanel />

        {/* ─── Autonomous App Builder ────────────────────────────────── */}
        <BuilderPanel />

        {/* ─── Controlled Self-Improvement ─────────────────────────────── */}
        <SelfImprovementPanel />
      </div>
    </div>
  );
}

// ─── Agent Trace Panel ────────────────────────────────────────────────────

interface AgentTraceEvent {
  type: string;
  payload: {
    agentRole?: string;
    taskId?: string;
    timestamp?: number;
    reason?: string;
    toAgent?: string;
    goal?: string;
    success?: boolean;
    [key: string]: unknown;
  };
  timestamp: number;
}

function AgentTracePanel() {
  const [events, setEvents] = React.useState<AgentTraceEvent[]>([]);
  const [loading, setLoading] = React.useState(false);

  const fetchTrace = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/agents/trace?limit=50');
      if (res.ok) {
        const data = await res.json();
        setEvents(data.events ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { fetchTrace(); }, [fetchTrace]);

  const eventLabel = (type: string) => type.replace('agent.orchestrator.', '');

  const eventColor = (type: string) => {
    if (type.includes('rejected')) return '#f85149';
    if (type.includes('approved')) return '#3fb950';
    if (type.includes('started')) return '#58a6ff';
    if (type.includes('completed')) return '#d29922';
    return '#8b949e';
  };

  return (
    <Panel title="Agent Orchestration Trace">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          {events.length} events
        </span>
        <button
          onClick={fetchTrace}
          disabled={loading}
          style={{
            fontSize: '11px', padding: '2px 8px', cursor: 'pointer',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
            borderRadius: '4px', color: 'var(--text-primary)',
          }}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      {events.length === 0 ? (
        <Empty>No orchestration events yet. Enable multi-agent mode to see agent trace.</Empty>
      ) : (
        <div style={{ maxHeight: '300px', overflow: 'auto' }}>
          {events.map((event, i) => (
            <div key={i} style={{
              display: 'flex', gap: '8px', alignItems: 'baseline',
              padding: '4px 0', borderBottom: '1px solid var(--border-secondary)',
              fontSize: '12px',
            }}>
              <span style={{
                color: eventColor(event.type),
                fontWeight: 600, minWidth: '120px',
              }}>
                {eventLabel(event.type)}
              </span>
              <span style={{ color: '#d2a8ff', minWidth: '80px' }}>
                {event.payload?.agentRole ?? '—'}
              </span>
              <span style={{ color: 'var(--text-secondary)', flex: 1 }}>
                {event.payload?.taskId ?? ''}
                {event.payload?.reason ? ` — ${event.payload.reason}` : ''}
                {event.payload?.goal ? ` — ${String(event.payload.goal).substring(0, 60)}` : ''}
              </span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: '11px' }}>
                {new Date(event.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ─── Builder Panel ────────────────────────────────────────────────────────

interface BuilderRun {
  type: string;
  payload: {
    buildId?: string;
    goalId?: string;
    success?: boolean;
    attempts?: number;
    artifactCount?: number;
    [key: string]: unknown;
  };
  timestamp: number;
}

function BuilderPanel() {
  const [runs, setRuns] = React.useState<BuilderRun[]>([]);
  const [loading, setLoading] = React.useState(false);

  const fetchRuns = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/builder/runs?limit=20');
      if (res.ok) {
        const data = await res.json();
        setRuns(data.runs ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { fetchRuns(); }, [fetchRuns]);

  return (
    <Panel title="Autonomous App Builder">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          {runs.length} build run(s)
        </span>
        <button
          onClick={fetchRuns}
          disabled={loading}
          style={{
            fontSize: '11px', padding: '2px 8px', cursor: 'pointer',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
            borderRadius: '4px', color: 'var(--text-primary)',
          }}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      {runs.length === 0 ? (
        <Empty>No build runs yet. Use the API or CLI to trigger a build.</Empty>
      ) : (
        <div style={{ maxHeight: '250px', overflow: 'auto' }}>
          {runs.map((run, i) => (
            <div key={i} style={{
              display: 'flex', gap: '8px', alignItems: 'baseline',
              padding: '6px 0', borderBottom: '1px solid var(--border-secondary)',
              fontSize: '12px',
            }}>
              <span style={{
                color: run.payload?.success ? '#3fb950' : '#f85149',
                fontWeight: 600, minWidth: '20px',
              }}>
                {run.payload?.success ? '\u2705' : '\u274C'}
              </span>
              <span style={{ color: '#d2a8ff', minWidth: '160px', fontFamily: 'monospace', fontSize: '11px' }}>
                {run.payload?.buildId ?? '—'}
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>
                {run.payload?.attempts ?? 0} attempt(s)
              </span>
              <span style={{ color: '#79c0ff' }}>
                {run.payload?.artifactCount ?? 0} artifact(s)
              </span>
              <span style={{ color: 'var(--text-tertiary)', fontSize: '11px', marginLeft: 'auto' }}>
                {new Date(run.timestamp).toLocaleTimeString()}
              </span>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

// ─── Self-Improvement Panel ──────────────────────────────────────────────

interface StagedPatchView {
  id: string;
  targetFile: string;
  reason: string;
  createdAt: number;
  validationResult?: {
    passed: boolean;
    baselineScore: number;
    candidateScore: number;
    improvement: number;
    regressions: string[];
  };
}

function SelfImprovementPanel() {
  const [patches, setPatches] = React.useState<StagedPatchView[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [actionResult, setActionResult] = React.useState<string | null>(null);

  const fetchPatches = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/validation/patches');
      if (res.ok) {
        const data = await res.json();
        setPatches(data.patches ?? []);
      }
    } catch {
      // ignore
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => { fetchPatches(); }, [fetchPatches]);

  const applyPatch = async (patchId: string) => {
    try {
      const res = await fetch('/api/validation/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patchId }),
      });
      const data = await res.json();
      if (data.applied) {
        setActionResult(`Patch ${patchId} applied successfully`);
      } else {
        setActionResult(`Patch ${patchId} rejected: ${data.reason ?? 'unknown'}`);
      }
      fetchPatches();
    } catch {
      setActionResult(`Failed to apply patch ${patchId}`);
    }
  };

  const rollbackFile = async (filePath: string) => {
    try {
      const res = await fetch('/api/validation/rollback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filePath }),
      });
      const data = await res.json();
      setActionResult(data.success ? `Rolled back: ${filePath}` : `Rollback failed: ${filePath}`);
      fetchPatches();
    } catch {
      setActionResult(`Rollback error for ${filePath}`);
    }
  };

  const validationBadge = (patch: StagedPatchView) => {
    if (!patch.validationResult) return { label: 'pending', color: '#d29922' };
    return patch.validationResult.passed
      ? { label: 'passed', color: '#3fb950' }
      : { label: 'failed', color: '#f85149' };
  };

  return (
    <Panel title="Controlled Self-Improvement">
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
          {patches.length} staged patch(es)
        </span>
        <button
          onClick={fetchPatches}
          disabled={loading}
          style={{
            fontSize: '11px', padding: '2px 8px', cursor: 'pointer',
            background: 'var(--bg-tertiary)', border: '1px solid var(--border-primary)',
            borderRadius: '4px', color: 'var(--text-primary)',
          }}
        >
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>
      {actionResult && (
        <div style={{
          padding: '6px 10px', marginBottom: '8px', fontSize: '12px',
          background: 'var(--bg-primary)', borderRadius: '4px',
          color: '#79c0ff', border: '1px solid var(--border-secondary)',
        }}>
          {actionResult}
        </div>
      )}
      {patches.length === 0 ? (
        <Empty>No staged patches. The self-improvement engine stages patches here for review.</Empty>
      ) : (
        <div style={{ maxHeight: '300px', overflow: 'auto' }}>
          {patches.map((patch) => {
            const badge = validationBadge(patch);
            return (
              <div key={patch.id} style={{
                padding: '8px 0', borderBottom: '1px solid var(--border-secondary)',
                fontSize: '12px',
              }}>
                <div style={{ display: 'flex', gap: '8px', alignItems: 'center', marginBottom: '4px' }}>
                  <span style={{
                    fontFamily: 'monospace', fontSize: '11px',
                    color: '#d2a8ff', fontWeight: 600,
                  }}>
                    {patch.id}
                  </span>
                  <span style={{
                    padding: '1px 6px', borderRadius: '8px', fontSize: '10px',
                    fontWeight: 700, background: badge.color + '22', color: badge.color,
                  }}>
                    {badge.label}
                  </span>
                </div>
                <div style={{ color: 'var(--text-secondary)', marginBottom: '2px' }}>
                  Target: <span style={{ color: 'var(--text-primary)' }}>{patch.targetFile}</span>
                </div>
                <div style={{ color: 'var(--text-secondary)', marginBottom: '4px' }}>
                  Reason: {patch.reason}
                </div>
                {patch.validationResult && (
                  <div style={{ color: 'var(--text-tertiary)', fontSize: '11px', marginBottom: '4px' }}>
                    Baseline: {patch.validationResult.baselineScore.toFixed(3)} |
                    Candidate: {patch.validationResult.candidateScore.toFixed(3)} |
                    Improvement: {patch.validationResult.improvement.toFixed(3)}
                    {patch.validationResult.regressions.length > 0 && (
                      <span style={{ color: '#f85149' }}>
                        {' | '}Regressions: {patch.validationResult.regressions.join(', ')}
                      </span>
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: '6px', marginTop: '4px' }}>
                  <button
                    onClick={() => applyPatch(patch.id)}
                    style={{
                      fontSize: '11px', padding: '2px 10px', cursor: 'pointer',
                      background: '#238636', border: 'none', borderRadius: '4px',
                      color: '#fff', fontWeight: 600,
                    }}
                  >
                    Apply
                  </button>
                  <button
                    onClick={() => rollbackFile(patch.targetFile)}
                    style={{
                      fontSize: '11px', padding: '2px 10px', cursor: 'pointer',
                      background: '#da3633', border: 'none', borderRadius: '4px',
                      color: '#fff', fontWeight: 600,
                    }}
                  >
                    Rollback
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Panel>
  );
}

// ─── Shared sub-components ────────────────────────────────────────────────

function Panel({ title, children, full }: { title: string; children: React.ReactNode; full?: boolean }) {
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

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{
      background: 'var(--bg-primary)',
      borderRadius: 'var(--radius-md)',
      padding: '10px', textAlign: 'center',
    }}>
      <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--color-primary)' }}>
        {value}
      </div>
      <div style={{ fontSize: '11px', color: 'var(--text-secondary)', marginTop: '2px' }}>
        {label}
      </div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <span style={{ color: '#F5F7FF', fontStyle: 'italic', fontSize: '13px', fontWeight: 500, opacity: 1 }}>
      {children}
    </span>
  );
}
