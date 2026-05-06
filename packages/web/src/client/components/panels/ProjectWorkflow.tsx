import React, { useState, useEffect } from 'react';
import { SkeletonCard } from '../Skeleton';

interface ProjectWorkflowProps {
  isLoading: boolean;
}

interface ProjectStats {
  activeProjects: number;
  completedProjects: number;
  totalProjects: number;
  pendingTasks: number;
  openIssues: number;
  averageHealth: number;
}

export function ProjectWorkflow({ isLoading }: ProjectWorkflowProps) {
  const [stats, setStats] = useState<ProjectStats | null>(null);
  const [loading, setLoading] = useState(isLoading);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/projects');
        const data = await res.json();
        setStats(data);
      } catch {
        // No fake fallback — stats stays null, skeleton shown
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 45000); // Poll every 45 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading || !stats) {
    return <SkeletonCard />;
  }

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="panel-title">Project Workflow</h3>
        <span className="panel-badge">{stats.activeProjects} Active</span>
      </div>
      <div className="card-body">
        <div className="stat-grid">
          <div className="stat-item">
            <div className="stat-label">Active Projects</div>
            <div className="stat-value">{stats.activeProjects}</div>
            <div className="stat-sub">ongoing work</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Completed</div>
            <div className="stat-value" style={{ color: '#10b981' }}>
              {stats.completedProjects}
            </div>
            <div className="stat-sub">finished projects</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Pending Tasks</div>
            <div className="stat-value" style={{ color: '#f97316' }}>
              {stats.pendingTasks}
            </div>
            <div className="stat-sub">awaiting action</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Health Score</div>
            <div className="stat-value" style={{ color: '#00d9ff' }}>
              {stats.averageHealth}%
            </div>
            <div className="stat-sub">overall</div>
          </div>
        </div>

        <div style={{ marginTop: 'var(--spacing-lg)' }}>
          <div style={{ marginBottom: 'var(--spacing-sm)' }}>
            <small style={{ color: 'var(--text-secondary)', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Project Health
            </small>
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${stats.averageHealth}%` }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--spacing-sm)', fontSize: 'var(--text-xs)' }}>
            <span>Quality metrics</span>
            <span style={{ color: '#10b981' }}>{stats.openIssues} issues</span>
          </div>
        </div>
      </div>
    </div>
  );
}
