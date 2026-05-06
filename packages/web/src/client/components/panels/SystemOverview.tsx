import React, { useState, useEffect } from 'react';
import { Skeleton, SkeletonCard } from '../Skeleton';

interface SystemOverviewProps {
  isLoading: boolean;
}

interface SystemStatus {
  agentName: string;
  activeSessions: number;
  uptime: number;
  model: string;
  integrations: string[];
  health: 'healthy' | 'degraded' | 'offline';
}

export function SystemOverview({ isLoading }: SystemOverviewProps) {
  const [status, setStatus] = useState<SystemStatus | null>(null);
  const [loading, setLoading] = useState(isLoading);

  useEffect(() => {
    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/status');
        const data = await res.json();
        setStatus({
          agentName: data.agentName || 'AgentX',
          activeSessions: data.activeSessions || 0,
          uptime: data.uptime || 0,
          model: data.model || 'unknown',
          integrations: data.integrations || [],
          health: res.ok ? 'healthy' : 'degraded',
        });
      } catch {
        // No fake fallback — status stays null, honest unavailable state shown
      } finally {
        setLoading(false);
      }
    };

    fetchStatus();
    const interval = setInterval(fetchStatus, 30000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return <SkeletonCard />;
  }

  if (!status) {
    return (
      <div className="card placeholder">
        <svg className="placeholder-icon" fill="none" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6m0 0h6" />
        </svg>
        <div className="placeholder-text">Unable to load system status</div>
      </div>
    );
  }

  const getHealthColor = () => {
    switch (status.health) {
      case 'healthy':
        return '#10b981';
      case 'degraded':
        return '#f97316';
      default:
        return '#ef4444';
    }
  };

  const formatUptime = (ms: number) => {
    const seconds = Math.floor(ms / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return `${days}d`;
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="panel-title">System Overview</h3>
        <div
          className="status-dot"
          style={{ background: getHealthColor() }}
        />
      </div>
      <div className="card-body">
        <div className="stat-grid">
          <div className="stat-item">
            <div className="stat-label">Status</div>
            <div className="stat-value" style={{ color: getHealthColor() }}>
              {status.health.toUpperCase()}
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Sessions</div>
            <div className="stat-value">{status.activeSessions}</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Uptime</div>
            <div className="stat-value">{formatUptime(status.uptime)}</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Model</div>
            <div className="stat-value" style={{ fontSize: 'var(--text-sm)' }}>
              {status.model.split('-').slice(0, 2).join('-')}
            </div>
          </div>
        </div>

        <div style={{ marginTop: 'var(--spacing-lg)' }}>
          <div style={{ marginBottom: 'var(--spacing-sm)' }}>
            <small style={{ color: 'var(--text-secondary)', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Integrations
            </small>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--spacing-sm)' }}>
            {status.integrations.length > 0 ? (
              status.integrations.map((integration) => (
                <span key={integration} className="badge-info">
                  {integration}
                </span>
              ))
            ) : (
              <span style={{ color: 'var(--text-tertiary)', fontSize: 'var(--text-sm)' }}>
                No integrations configured
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
