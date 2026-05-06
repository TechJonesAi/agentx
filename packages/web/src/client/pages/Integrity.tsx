import React, { useState, useEffect, useCallback } from 'react';
import '../styles/Pages.css';

// ---------------------------------------------------------------------------
// Types (mirrors core integrity types for the UI)
// ---------------------------------------------------------------------------

interface SubsystemStatus {
  name: string;
  state: 'healthy' | 'degraded' | 'unhealthy' | 'repairing';
  severity?: 'critical' | 'core' | 'optional';
  lastChecked: number;
  lastRepair?: number;
  consecutiveFailures: number;
  message?: string;
  requiresManualAction?: boolean;
  manualActionReason?: string;
}

interface DiagnosticCheck {
  name: string;
  subsystem: string;
  result: 'pass' | 'fail' | 'warn' | 'skip';
  message: string;
  durationMs: number;
}

interface DiagnosisReport {
  id: string;
  timestamp: number;
  overallState: string;
  checks: DiagnosticCheck[];
  failedSubsystems: string[];
  warnings: string[];
  recommendations: Array<{
    subsystem: string;
    severity: string;
    strategy: string;
    description: string;
    confidence: number;
  }>;
  durationMs: number;
}

interface RepairHistoryEntry {
  id: string;
  diagnosisId: string;
  subsystem: string;
  strategy: string;
  severity: string;
  description: string;
  success: boolean;
  error?: string;
  rollbackPerformed: boolean;
  validationPassed: boolean;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

interface IntegrityStatus {
  overallState: string;
  subsystems: SubsystemStatus[];
  lastDiagnosis?: DiagnosisReport;
  lastRepair?: { id: string; success: boolean; subsystem: string };
  totalRepairs: number;
  successfulRepairs: number;
  failedRepairs: number;
  uptime: number;
  startedAt: number;
  monitorActive?: boolean;
}

interface SupervisorServiceStatus {
  id: string;
  name: string;
  type: 'node' | 'python' | 'external' | 'manual';
  state: string;
  manageable: boolean;
  pid?: number;
  restartCount: number;
  lastHealthCheck?: number;
  lastHealthMessage?: string;
  startedAt?: number;
  lastError?: string;
  requiredFor?: string;
  description?: string;
}

interface SupervisorStatus {
  services: SupervisorServiceStatus[];
  managedCount: number;
  unmanagedCount: number;
  healthyCount: number;
  unhealthyCount: number;
}

type TabId = 'overview' | 'diagnostics' | 'repairs' | 'history' | 'services';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stateColor(state: string): string {
  switch (state) {
    case 'healthy': return 'var(--color-success, #22c55e)';
    case 'degraded': return 'var(--color-warning, #eab308)';
    case 'unhealthy': return 'var(--color-error, #ef4444)';
    case 'repairing': return 'var(--color-info, #3b82f6)';
    default: return 'var(--color-text-secondary)';
  }
}

function checkResultColor(result: string): string {
  switch (result) {
    case 'pass': return 'var(--color-success, #22c55e)';
    case 'fail': return 'var(--color-error, #ef4444)';
    case 'warn': return 'var(--color-warning, #eab308)';
    case 'skip': return 'var(--color-text-secondary)';
    default: return 'var(--color-text-secondary)';
  }
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatTimestamp(ts: number): string {
  return new Date(ts).toLocaleString();
}

// ---------------------------------------------------------------------------
// Integrity Page
// ---------------------------------------------------------------------------

export function Integrity() {
  const [activeTab, setActiveTab] = useState<TabId>('overview');
  const [status, setStatus] = useState<IntegrityStatus | null>(null);
  const [report, setReport] = useState<DiagnosisReport | null>(null);
  const [repairs, setRepairs] = useState<RepairHistoryEntry[]>([]);
  const [isRunning, setIsRunning] = useState(false);
  const [isRepairing, setIsRepairing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [supervisorStatus, setSupervisorStatus] = useState<SupervisorStatus | null>(null);

  // Fetch status on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [statusRes, repairsRes, supervisorRes] = await Promise.all([
          fetch('/api/integrity/status'),
          fetch('/api/integrity/repairs'),
          fetch('/api/supervisor/status'),
        ]);
        if (!cancelled) {
          if (statusRes.ok) {
            setStatus(await statusRes.json());
          }
          if (repairsRes.ok) {
            const data = await repairsRes.json();
            setRepairs(data.repairs ?? []);
          }
          if (supervisorRes.ok) {
            setSupervisorStatus(await supervisorRes.json());
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const handleRunDiagnostics = useCallback(async () => {
    setIsRunning(true);
    setError(null);
    try {
      const resp = await fetch('/api/integrity/run-diagnostics', { method: 'POST' });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      const data = await resp.json();
      setReport(data);
      setActiveTab('diagnostics');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  }, []);

  const handleRepair = useCallback(async (subsystem: string, strategy?: string) => {
    setIsRepairing(true);
    setError(null);
    try {
      const resp = await fetch('/api/integrity/repair', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ subsystem, strategy }),
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        throw new Error(err.error || `HTTP ${resp.status}`);
      }
      // Refresh repairs list
      const repairsRes = await fetch('/api/integrity/repairs');
      if (repairsRes.ok) {
        const data = await repairsRes.json();
        setRepairs(data.repairs ?? []);
      }
      setActiveTab('history');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRepairing(false);
    }
  }, []);

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Integrity Monitor</h1>
        <p>System health diagnostics, self-repair, and audit trail</p>
      </div>

      {/* Status Summary */}
      <div className="content-card" style={{ marginBottom: 'var(--spacing-lg)', padding: 'var(--spacing-md) var(--spacing-lg)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-lg)', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
            <span style={{
              display: 'inline-block', width: 12, height: 12, borderRadius: '50%',
              backgroundColor: stateColor(status?.overallState ?? 'healthy'),
            }} />
            <strong style={{ textTransform: 'capitalize' }}>{status?.overallState ?? 'Unknown'}</strong>
          </div>
          {status?.monitorActive !== undefined && (
            <span style={{
              fontSize: '0.75rem', padding: '2px 8px', borderRadius: 12,
              background: status.monitorActive ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)',
              color: status.monitorActive ? 'var(--color-success, #22c55e)' : 'var(--color-error, #ef4444)',
              fontWeight: 600,
            }}>
              Monitor {status.monitorActive ? 'ACTIVE' : 'STOPPED'}
            </span>
          )}
          <span style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
            Repairs: {status?.totalRepairs ?? 0} total &middot; {status?.successfulRepairs ?? 0} ok &middot; {status?.failedRepairs ?? 0} failed
            {status?.uptime ? ` · Uptime: ${formatMs(status.uptime)}` : ''}
          </span>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 'var(--spacing-sm)' }}>
            <button className="btn btn-primary" onClick={handleRunDiagnostics} disabled={isRunning}>
              {isRunning ? 'Running...' : 'Run Diagnostics'}
            </button>
          </div>
        </div>
      </div>

      {error && (
        <div className="content-card" style={{ marginBottom: 'var(--spacing-lg)', padding: 'var(--spacing-md)', borderLeft: '4px solid var(--color-error, #ef4444)' }}>
          <strong>Error:</strong> {error}
        </div>
      )}

      {/* Active Incidents */}
      {status?.subsystems && status.subsystems.filter(s => s.state === 'unhealthy' || (s.state === 'degraded' && s.consecutiveFailures > 0)).length > 0 && (
        <div className="content-card" style={{ marginBottom: 'var(--spacing-lg)', padding: 'var(--spacing-md) var(--spacing-lg)', borderLeft: '4px solid var(--color-error, #ef4444)' }}>
          <strong style={{ fontSize: '0.85rem', color: 'var(--color-error, #ef4444)' }}>Active Incidents</strong>
          <div style={{ marginTop: 'var(--spacing-sm)' }}>
            {status.subsystems.filter(s => s.state === 'unhealthy' || (s.state === 'degraded' && s.consecutiveFailures > 0)).map(s => (
              <div key={s.name} style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)', marginBottom: 4 }}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: stateColor(s.state), display: 'inline-block' }} />
                <strong style={{ fontSize: '0.85rem' }}>{s.name}</strong>
                <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                  {s.message ?? s.state} {s.consecutiveFailures > 0 && `(${s.consecutiveFailures} consecutive failures)`}
                </span>
                {s.requiresManualAction && (
                  <span style={{ fontSize: '0.7rem', padding: '1px 5px', borderRadius: 4, background: 'rgba(234,179,8,0.2)', color: 'var(--color-warning, #eab308)' }}>
                    MANUAL
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab Bar */}
      <div style={{ display: 'flex', gap: 'var(--spacing-sm)', marginBottom: 'var(--spacing-lg)' }}>
        {(['overview', 'diagnostics', 'repairs', 'history', 'services'] as TabId[]).map(tab => (
          <button
            key={tab}
            className={`btn ${activeTab === tab ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => setActiveTab(tab)}
            style={{ textTransform: 'capitalize' }}
          >
            {tab}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === 'overview' && (
        <div className="content-card" style={{ padding: 'var(--spacing-lg)' }}>
          <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Subsystem Status</h3>
          {status?.subsystems && status.subsystems.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <th style={{ textAlign: 'left', padding: '8px' }}>Subsystem</th>
                  <th style={{ textAlign: 'left', padding: '8px' }}>Severity</th>
                  <th style={{ textAlign: 'left', padding: '8px' }}>State</th>
                  <th style={{ textAlign: 'left', padding: '8px' }}>Failures</th>
                  <th style={{ textAlign: 'left', padding: '8px' }}>Last Checked</th>
                  <th style={{ textAlign: 'left', padding: '8px' }}>Message</th>
                  <th style={{ textAlign: 'right', padding: '8px' }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {status.subsystems.map(sub => (
                  <tr key={sub.name} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '8px', fontWeight: 600 }}>{sub.name}</td>
                    <td style={{ padding: '8px' }}>
                      {sub.severity && (
                        <span style={{
                          fontSize: '0.7rem', padding: '1px 6px', borderRadius: 4, fontWeight: 600,
                          background: sub.severity === 'critical' ? 'rgba(239,68,68,0.15)' :
                                     sub.severity === 'core' ? 'rgba(59,130,246,0.15)' : 'rgba(107,114,128,0.15)',
                          color: sub.severity === 'critical' ? '#ef4444' :
                                 sub.severity === 'core' ? '#3b82f6' : '#6b7280',
                        }}>
                          {sub.severity.toUpperCase()}
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '8px' }}>
                      <span style={{ color: stateColor(sub.state), fontWeight: 600, textTransform: 'capitalize' }}>
                        {sub.state}
                      </span>
                    </td>
                    <td style={{ padding: '8px' }}>{sub.consecutiveFailures}</td>
                    <td style={{ padding: '8px', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                      {sub.lastChecked ? formatTimestamp(sub.lastChecked) : '—'}
                    </td>
                    <td style={{ padding: '8px', fontSize: '0.85rem' }}>
                      {sub.message ?? '—'}
                      {sub.requiresManualAction && (
                        <div style={{
                          marginTop: 4, fontSize: '0.75rem', padding: '2px 6px',
                          background: 'rgba(234,179,8,0.15)', color: 'var(--color-warning, #eab308)',
                          borderRadius: 4, display: 'inline-block',
                        }}>
                          Manual action needed: {sub.manualActionReason ?? 'See details'}
                        </div>
                      )}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'right' }}>
                      {sub.state !== 'healthy' && !sub.requiresManualAction && (
                        <button
                          className="btn btn-secondary"
                          onClick={() => handleRepair(sub.name)}
                          disabled={isRepairing}
                          style={{ fontSize: '0.8rem', padding: '4px 8px' }}
                        >
                          Repair
                        </button>
                      )}
                      {sub.requiresManualAction && (
                        <span style={{ fontSize: '0.75rem', color: 'var(--color-warning, #eab308)', fontWeight: 600 }}>
                          MANUAL
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ color: 'var(--color-text-secondary)' }}>
              No subsystem data yet. Run diagnostics to populate.
            </p>
          )}
        </div>
      )}

      {activeTab === 'diagnostics' && report && (
        <div className="content-card" style={{ padding: 'var(--spacing-lg)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--spacing-md)' }}>
            <h3>Diagnosis Report</h3>
            <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
              {formatTimestamp(report.timestamp)} &middot; {formatMs(report.durationMs)}
            </span>
          </div>

          <div style={{ display: 'flex', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-lg)', flexWrap: 'wrap' }}>
            <span style={{ color: stateColor(report.overallState), fontWeight: 700, textTransform: 'capitalize' }}>
              {report.overallState}
            </span>
            <span>{report.checks.length} checks</span>
            <span style={{ color: 'var(--color-error, #ef4444)' }}>{report.failedSubsystems.length} failures</span>
            <span style={{ color: 'var(--color-warning, #eab308)' }}>{report.warnings.length} warnings</span>
          </div>

          <h4 style={{ marginBottom: 'var(--spacing-sm)' }}>Checks</h4>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 'var(--spacing-lg)' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                <th style={{ textAlign: 'left', padding: '6px' }}>Check</th>
                <th style={{ textAlign: 'left', padding: '6px' }}>Subsystem</th>
                <th style={{ textAlign: 'left', padding: '6px' }}>Result</th>
                <th style={{ textAlign: 'left', padding: '6px' }}>Message</th>
                <th style={{ textAlign: 'right', padding: '6px' }}>Duration</th>
              </tr>
            </thead>
            <tbody>
              {report.checks.map((c, i) => (
                <tr key={i} style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <td style={{ padding: '6px', fontFamily: 'monospace', fontSize: '0.85rem' }}>{c.name}</td>
                  <td style={{ padding: '6px' }}>{c.subsystem}</td>
                  <td style={{ padding: '6px' }}>
                    <span style={{ color: checkResultColor(c.result), fontWeight: 600, textTransform: 'uppercase', fontSize: '0.8rem' }}>
                      {c.result}
                    </span>
                  </td>
                  <td style={{ padding: '6px', fontSize: '0.85rem' }}>{c.message}</td>
                  <td style={{ padding: '6px', textAlign: 'right', fontSize: '0.85rem' }}>{formatMs(c.durationMs)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {report.recommendations.length > 0 && (
            <>
              <h4 style={{ marginBottom: 'var(--spacing-sm)' }}>Recommendations</h4>
              {report.recommendations.map((rec, i) => (
                <div key={i} className="content-card" style={{ padding: 'var(--spacing-sm) var(--spacing-md)', marginBottom: 'var(--spacing-sm)', display: 'flex', alignItems: 'center', gap: 'var(--spacing-md)' }}>
                  <span style={{ fontWeight: 600 }}>{rec.subsystem}</span>
                  <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>{rec.strategy}</span>
                  <span style={{ fontSize: '0.85rem', flex: 1 }}>{rec.description}</span>
                  <span style={{ fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                    {(rec.confidence * 100).toFixed(0)}% confidence
                  </span>
                  <button
                    className="btn btn-primary"
                    onClick={() => handleRepair(rec.subsystem, rec.strategy)}
                    disabled={isRepairing}
                    style={{ fontSize: '0.8rem', padding: '4px 10px' }}
                  >
                    Apply
                  </button>
                </div>
              ))}
            </>
          )}
        </div>
      )}

      {activeTab === 'diagnostics' && !report && (
        <div className="content-card" style={{ padding: 'var(--spacing-lg)' }}>
          <p style={{ color: 'var(--color-text-secondary)' }}>
            No diagnostics report yet. Click &quot;Run Diagnostics&quot; to start.
          </p>
        </div>
      )}

      {activeTab === 'repairs' && report?.recommendations && (
        <div className="content-card" style={{ padding: 'var(--spacing-lg)' }}>
          <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Available Repairs</h3>
          {report.recommendations.length > 0 ? (
            report.recommendations.map((rec, i) => (
              <div key={i} className="content-card" style={{ padding: 'var(--spacing-md)', marginBottom: 'var(--spacing-sm)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <strong>{rec.subsystem}</strong>
                    <span style={{ marginLeft: 'var(--spacing-sm)', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                      {rec.severity} &middot; {rec.strategy}
                    </span>
                    <p style={{ margin: '4px 0 0', fontSize: '0.85rem' }}>{rec.description}</p>
                  </div>
                  <button
                    className="btn btn-primary"
                    onClick={() => handleRepair(rec.subsystem, rec.strategy)}
                    disabled={isRepairing}
                  >
                    {isRepairing ? 'Repairing...' : 'Execute'}
                  </button>
                </div>
              </div>
            ))
          ) : (
            <p style={{ color: 'var(--color-text-secondary)' }}>No repairs recommended. System is healthy.</p>
          )}
        </div>
      )}

      {activeTab === 'history' && (
        <div className="content-card" style={{ padding: 'var(--spacing-lg)' }}>
          <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Repair History</h3>
          {repairs.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Time</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Subsystem</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Strategy</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Result</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Duration</th>
                  <th style={{ textAlign: 'left', padding: '6px' }}>Notes</th>
                </tr>
              </thead>
              <tbody>
                {repairs.map(r => (
                  <tr key={r.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <td style={{ padding: '6px', fontSize: '0.85rem' }}>{formatTimestamp(r.startedAt)}</td>
                    <td style={{ padding: '6px', fontWeight: 600 }}>{r.subsystem}</td>
                    <td style={{ padding: '6px', fontSize: '0.85rem', fontFamily: 'monospace' }}>{r.strategy}</td>
                    <td style={{ padding: '6px' }}>
                      <span style={{ color: r.success ? 'var(--color-success, #22c55e)' : 'var(--color-error, #ef4444)', fontWeight: 600 }}>
                        {r.success ? 'OK' : 'FAILED'}
                      </span>
                      {r.rollbackPerformed && (
                        <span style={{ marginLeft: 4, fontSize: '0.75rem', color: 'var(--color-warning, #eab308)' }}>
                          (rolled back)
                        </span>
                      )}
                    </td>
                    <td style={{ padding: '6px', fontSize: '0.85rem' }}>{formatMs(r.durationMs)}</td>
                    <td style={{ padding: '6px', fontSize: '0.8rem', color: 'var(--color-text-secondary)' }}>
                      {r.error ?? r.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p style={{ color: 'var(--color-text-secondary)' }}>No repairs recorded yet.</p>
          )}
        </div>
      )}

      {activeTab === 'services' && (
        <div className="content-card" style={{ padding: 'var(--spacing-lg)' }}>
          <h3 style={{ marginBottom: 'var(--spacing-md)' }}>Runtime Services</h3>
          {supervisorStatus && supervisorStatus.services.length > 0 ? (
            <>
              <div style={{ display: 'flex', gap: 'var(--spacing-lg)', marginBottom: 'var(--spacing-lg)', fontSize: '0.85rem' }}>
                <span>Total: {supervisorStatus.services.length}</span>
                <span>Managed: {supervisorStatus.managedCount}</span>
                <span>Unmanaged: {supervisorStatus.unmanagedCount}</span>
                <span style={{ color: 'var(--color-success, #22c55e)' }}>Healthy: {supervisorStatus.healthyCount}</span>
                <span style={{ color: 'var(--color-error, #ef4444)' }}>Unhealthy: {supervisorStatus.unhealthyCount}</span>
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--color-border)' }}>
                    <th style={{ textAlign: 'left', padding: '8px' }}>Service</th>
                    <th style={{ textAlign: 'left', padding: '8px' }}>Type</th>
                    <th style={{ textAlign: 'left', padding: '8px' }}>State</th>
                    <th style={{ textAlign: 'left', padding: '8px' }}>Classification</th>
                    <th style={{ textAlign: 'left', padding: '8px' }}>Restarts</th>
                    <th style={{ textAlign: 'left', padding: '8px' }}>Details</th>
                  </tr>
                </thead>
                <tbody>
                  {supervisorStatus.services.map(svc => (
                    <tr key={svc.id} style={{ borderBottom: '1px solid var(--color-border)' }}>
                      <td style={{ padding: '8px' }}>
                        <div style={{ fontWeight: 600 }}>{svc.name}</div>
                        <div style={{ fontSize: '0.75rem', color: 'var(--color-text-secondary)', fontFamily: 'monospace' }}>{svc.id}</div>
                      </td>
                      <td style={{ padding: '8px' }}>
                        <span style={{
                          fontSize: '0.75rem', padding: '2px 6px', borderRadius: 4,
                          background: svc.type === 'external' ? 'rgba(234,179,8,0.15)' : 'rgba(59,130,246,0.15)',
                          color: svc.type === 'external' ? '#eab308' : '#3b82f6',
                        }}>
                          {svc.type}
                        </span>
                      </td>
                      <td style={{ padding: '8px' }}>
                        <span style={{ color: stateColor(svc.state === 'healthy' ? 'healthy' : svc.state === 'stopped' ? 'degraded' : 'unhealthy'), fontWeight: 600, textTransform: 'capitalize' }}>
                          {svc.state}
                        </span>
                      </td>
                      <td style={{ padding: '8px' }}>
                        <span style={{
                          fontSize: '0.75rem', padding: '2px 6px', borderRadius: 4,
                          background: svc.manageable ? 'rgba(34,197,94,0.15)' : 'rgba(107,114,128,0.15)',
                          color: svc.manageable ? '#22c55e' : '#6b7280',
                          fontWeight: 600,
                        }}>
                          {svc.manageable ? 'MANAGED' : 'UNMANAGED'}
                        </span>
                      </td>
                      <td style={{ padding: '8px' }}>{svc.restartCount}</td>
                      <td style={{ padding: '8px', fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>
                        {svc.lastHealthMessage ?? svc.description ?? '—'}
                        {svc.lastError && (
                          <div style={{ color: 'var(--color-error, #ef4444)', fontSize: '0.8rem', marginTop: 2 }}>
                            {svc.lastError}
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p style={{ color: 'var(--color-text-secondary)' }}>No services registered in supervisor.</p>
          )}
        </div>
      )}
    </div>
  );
}
