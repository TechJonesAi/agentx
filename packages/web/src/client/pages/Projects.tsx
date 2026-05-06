import React, { useState, useEffect } from 'react';
import '../styles/Pages.css';
import { AgentLoopsPanel } from './AgentLoops';

interface ExecutionTask {
  id: string;
  title: string;
  prompt: string;
  status: string;
  stepCount: number;
  startedAt: number | null;
  finishedAt: number | null;
  error: string | null;
  createdAt: number;
  sessionId: string | null;
}

interface ExecutionStep {
  id: string;
  step_number: number;
  tool_name: string;
  args_json: string;
  result: string;
  status: string;
  duration_ms: number;
  created_at: number;
}

interface ProjectData {
  activeProjects: number;
  completedProjects: number;
  totalProjects: number;
  failedProjects?: number;
  tasks: ExecutionTask[];
  connected: boolean;
}

interface WorkflowStats {
  totalWorkflows: number;
  activeWorkflows: number;
  completedWorkflows: number;
  failedWorkflows: number;
  averageExecutionTime: number;
  successRate: number;
}

type Tab = 'tasks' | 'loops' | 'statistics';

export function Projects() {
  const [tab, setTab] = useState<Tab>('tasks');
  const [data, setData] = useState<ProjectData | null>(null);
  const [loading, setLoading] = useState(true);
  const [expandedTask, setExpandedTask] = useState<string | null>(null);
  const [steps, setSteps] = useState<ExecutionStep[]>([]);
  const [stepsLoading, setStepsLoading] = useState(false);

  // Statistics tab state
  const [stats, setStats] = useState<WorkflowStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [statsError, setStatsError] = useState<string | null>(null);

  const fetchData = async () => {
    try {
      const response = await fetch('/api/projects');
      if (response.ok) {
        setData(await response.json());
      }
    } catch { /* */ }
    setLoading(false);
  };

  useEffect(() => { fetchData(); }, []);

  // Auto-refresh every 10s if there are active tasks
  useEffect(() => {
    if (!data?.activeProjects) return;
    const timer = setInterval(fetchData, 10000);
    return () => clearInterval(timer);
  }, [data?.activeProjects]);

  // Load Statistics only when tab is opened (and refresh on tab switch)
  const fetchStats = async () => {
    setStatsLoading(true);
    try {
      const response = await fetch('/api/workflows');
      if (!response.ok) {
        throw new Error(`Failed to load workflows: ${response.statusText}`);
      }
      const d = await response.json();
      setStats(d);
      setStatsError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load workflow data';
      setStatsError(message);
      setStats({
        totalWorkflows: 0,
        activeWorkflows: 0,
        completedWorkflows: 0,
        failedWorkflows: 0,
        averageExecutionTime: 0,
        successRate: 0,
      });
    } finally {
      setStatsLoading(false);
    }
  };

  useEffect(() => {
    if (tab === 'statistics') fetchStats();
  }, [tab]);

  const loadSteps = async (taskId: string) => {
    if (expandedTask === taskId) {
      setExpandedTask(null);
      return;
    }
    setExpandedTask(taskId);
    setStepsLoading(true);
    try {
      const res = await fetch(`/api/projects/${taskId}/steps`);
      if (res.ok) {
        const d = await res.json();
        setSteps(d.steps ?? []);
      }
    } catch { /* */ }
    setStepsLoading(false);
  };

  const statusColor = (status: string) => {
    switch (status) {
      case 'completed': return '#10b981';
      case 'running': case 'pending': return '#f97316';
      case 'failed': return '#ef4444';
      default: return 'var(--text-secondary)';
    }
  };

  const formatTime = (ts: number | null) => {
    if (!ts) return '-';
    return new Date(ts).toLocaleString();
  };

  const formatDuration = (ms: number) => {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${(ms / 1000).toFixed(1)}s`;
  };

  if (loading) {
    return (
      <div className="page-container">
        <div className="page-header"><h1>Projects</h1><p>Execution tasks and build workflows</p></div>
        <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)' }}>Loading...</div>
      </div>
    );
  }

  const tasks = data?.tasks ?? [];

  const tabButton = (id: Tab, label: string) => (
    <button
      onClick={() => setTab(id)}
      style={{
        padding: '8px 18px',
        fontSize: '13px',
        fontWeight: 500,
        background: tab === id ? 'var(--color-primary)' : 'transparent',
        color: tab === id ? '#fff' : 'var(--text-secondary)',
        border: `1px solid ${tab === id ? 'var(--color-primary)' : 'var(--border-primary)'}`,
        borderRadius: '6px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Projects</h1>
        <p>Execution tasks, agent loops, and workflow statistics</p>
      </div>

      <div style={{ maxWidth: '900px', margin: '0 auto', padding: 'var(--spacing-lg)' }}>
        {/* Tab bar */}
        <div style={{ display: 'flex', gap: '8px', marginBottom: 'var(--spacing-lg)' }}>
          {tabButton('tasks', 'Tasks')}
          {tabButton('loops', 'Agent Loops')}
          {tabButton('statistics', 'Statistics')}
        </div>

        {tab === 'tasks' && (
          <>
            {/* Clear All button */}
            {tasks.length > 0 && (
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--spacing-md)' }}>
                <button
                  onClick={async () => {
                    if (confirm('Delete all projects? This cannot be undone.')) {
                      await fetch('/api/projects', { method: 'DELETE' });
                      fetchData();
                    }
                  }}
                  style={{
                    padding: '6px 14px', fontSize: '12px', fontWeight: 500,
                    background: 'transparent', color: '#ef4444', border: '1px solid #ef444444',
                    borderRadius: '6px', cursor: 'pointer',
                  }}
                >
                  Clear All Projects
                </button>
              </div>
            )}

            {/* Stats */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--spacing-md)', marginBottom: 'var(--spacing-xl)' }}>
              {[
                { label: 'Total', value: data?.totalProjects ?? 0, color: 'var(--color-primary)' },
                { label: 'Active', value: data?.activeProjects ?? 0, color: '#f97316' },
                { label: 'Completed', value: data?.completedProjects ?? 0, color: '#10b981' },
                { label: 'Failed', value: data?.failedProjects ?? 0, color: '#ef4444' },
              ].map(s => (
                <div key={s.label} style={{ padding: 'var(--spacing-md)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)', textAlign: 'center' }}>
                  <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>{s.label}</div>
                  <div style={{ fontSize: '28px', fontWeight: '600', color: s.color }}>{s.value}</div>
                </div>
              ))}
            </div>

            {/* Task List */}
            {tasks.length === 0 ? (
              <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)', background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)' }}>
                <div style={{ fontSize: '24px', marginBottom: '8px' }}>No execution tasks yet</div>
                <div style={{ fontSize: '14px' }}>Tasks will appear here when you submit build/execution prompts in Chat.</div>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-md)' }}>
                {tasks.map(task => (
                  <div key={task.id} style={{ background: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '1px solid var(--border-primary)', overflow: 'hidden' }}>
                    {/* Task header */}
                    <div
                      onClick={() => loadSteps(task.id)}
                      style={{ padding: 'var(--spacing-md)', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                          <span style={{ display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: statusColor(task.status) }} />
                          <span style={{ fontWeight: '500', fontSize: '14px' }}>{task.title}</span>
                        </div>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                          {task.stepCount} step{task.stepCount !== 1 ? 's' : ''} | {formatTime(task.createdAt)}
                          {task.status === 'failed' && task.error && <span style={{ color: '#ef4444', marginLeft: '8px' }}>{task.error.slice(0, 60)}</span>}
                        </div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <div style={{ padding: '3px 10px', fontSize: '11px', borderRadius: '12px', background: statusColor(task.status) + '22', color: statusColor(task.status), border: `1px solid ${statusColor(task.status)}44`, textTransform: 'uppercase', fontWeight: '600' }}>
                          {task.status}
                        </div>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            // Try to extract workspace path from prompt
                            // Extract path from prompt — tilde expanded server-side
                            const pathMatch = task.prompt.match(/(?:in|to|at)\s+([\w/.~-]+\/[\w/.~-]+)/i) || task.prompt.match(/(~\/\.agentx\/workspace\/[\w-]+)/i);
                            const p = pathMatch ? pathMatch[1] : '~/.agentx/workspace';
                            fetch(`/api/projects/${task.id}/open`, {
                              method: 'POST',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ path: p }),
                            });
                          }}
                          title="Open in Finder"
                          style={{ padding: '4px 10px', fontSize: '12px', background: 'transparent', border: '1px solid var(--border-primary)', borderRadius: '4px', cursor: 'pointer', color: 'var(--text-secondary)' }}
                        >
                          Open
                        </button>
                        <button
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (confirm('Delete this project?')) {
                              await fetch(`/api/projects/${task.id}`, { method: 'DELETE' });
                              fetchData();
                            }
                          }}
                          title="Delete project"
                          style={{ padding: '4px 10px', fontSize: '12px', background: 'transparent', border: '1px solid #ef444444', borderRadius: '4px', cursor: 'pointer', color: '#ef4444' }}
                        >
                          Delete
                        </button>
                      </div>
                    </div>

                    {/* Expanded step log */}
                    {expandedTask === task.id && (
                      <div style={{ borderTop: '1px solid var(--border-primary)', padding: 'var(--spacing-md)', background: 'var(--bg-primary)' }}>
                        <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                          Prompt: <span style={{ color: 'var(--text-primary)' }}>{task.prompt.slice(0, 200)}{task.prompt.length > 200 ? '...' : ''}</span>
                        </div>
                        {stepsLoading ? (
                          <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>Loading steps...</div>
                        ) : steps.length === 0 ? (
                          <div style={{ color: 'var(--text-secondary)', fontSize: '13px' }}>No steps recorded.</div>
                        ) : (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                            {steps.map(step => (
                              <div key={step.id} style={{ fontSize: '12px', fontFamily: 'monospace', padding: '6px 8px', background: 'var(--bg-secondary)', borderRadius: '4px', border: '1px solid var(--border-primary)' }}>
                                <span style={{ color: step.status === 'completed' ? '#10b981' : '#ef4444', marginRight: '6px' }}>
                                  {step.status === 'completed' ? '+' : '-'}
                                </span>
                                <span style={{ color: 'var(--color-primary)', marginRight: '8px' }}>{step.tool_name}</span>
                                <span style={{ color: 'var(--text-secondary)' }}>{step.duration_ms}ms</span>
                                <div style={{ color: 'var(--text-secondary)', marginTop: '2px', wordBreak: 'break-all' }}>
                                  {step.result?.slice(0, 120)}{(step.result?.length ?? 0) > 120 ? '...' : ''}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {tab === 'loops' && (
          <AgentLoopsPanel />
        )}

        {tab === 'statistics' && (
          <>
            {statsError && (
              <div
                style={{
                  marginBottom: 'var(--spacing-lg)',
                  padding: 'var(--spacing-md)',
                  background: '#f8544422',
                  border: '1px solid #f85444',
                  borderRadius: 'var(--radius-md)',
                  color: '#f85444',
                  fontSize: 'var(--text-sm)',
                }}
              >
                ⚠️ {statsError}
              </div>
            )}

            {statsLoading ? (
              <div style={{ padding: 'var(--spacing-xl)', textAlign: 'center', color: 'var(--text-secondary)' }}>
                Loading statistics...
              </div>
            ) : (
              <>
                {/* Stats Grid */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
                    gap: 'var(--spacing-lg)',
                    marginBottom: 'var(--spacing-xl)',
                  }}
                >
                  {[
                    { label: 'Total Workflows', value: stats?.totalWorkflows ?? 0, color: 'var(--color-primary)', big: true },
                    { label: 'Active Now', value: stats?.activeWorkflows ?? 0, color: '#10b981', big: true },
                    { label: 'Completed', value: stats?.completedWorkflows ?? 0, color: '#8b5cf6', big: true },
                    { label: 'Failed', value: stats?.failedWorkflows ?? 0, color: '#ef4444', big: true },
                    { label: 'Success Rate', value: `${stats?.successRate ?? 0}%`, color: 'var(--color-primary)', big: true },
                    { label: 'Avg Exec Time', value: formatDuration(stats?.averageExecutionTime ?? 0), color: 'var(--color-primary)', big: false },
                  ].map(s => (
                    <div
                      key={s.label}
                      style={{
                        padding: 'var(--spacing-lg)',
                        background: 'var(--bg-secondary)',
                        borderRadius: 'var(--radius-md)',
                        border: '1px solid var(--border-primary)',
                        textAlign: 'center',
                      }}
                    >
                      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', marginBottom: 'var(--spacing-sm)' }}>
                        {s.label}
                      </div>
                      <div style={{ fontSize: s.big ? '32px' : '24px', fontWeight: '600', color: s.color }}>
                        {s.value}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Information Section */}
                <div
                  style={{
                    padding: 'var(--spacing-lg)',
                    background: 'var(--bg-secondary)',
                    borderRadius: 'var(--radius-md)',
                    border: '1px solid var(--border-primary)',
                  }}
                >
                  <h3 style={{ marginBottom: 'var(--spacing-md)' }}>About Workflow Statistics</h3>
                  <p style={{ lineHeight: '1.6', color: 'var(--text-secondary)', marginBottom: 'var(--spacing-md)' }}>
                    Aggregate metrics across all workflow / automation runs. Workflows automate complex task sequences and enable policy-based execution; the numbers above roll up every run tracked in the automation log.
                  </p>
                  <h4 style={{ marginBottom: 'var(--spacing-md)', color: 'var(--color-primary)' }}>Data source</h4>
                  <ul
                    style={{
                      marginLeft: 'var(--spacing-lg)',
                      lineHeight: '1.8',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    <li>📊 Backed by the same <code>automation_runs</code> table as the Tasks tab</li>
                    <li>🔄 Tasks tab shows individual runs; Statistics rolls up counts and timing</li>
                    <li>⏱️ Avg Exec Time is computed across completed runs only</li>
                    <li>📈 Success Rate = completed / (completed + failed)</li>
                  </ul>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
