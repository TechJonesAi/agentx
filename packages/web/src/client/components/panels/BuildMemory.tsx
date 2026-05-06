import React, { useState, useEffect } from 'react';
import { SkeletonCard } from '../Skeleton';

interface BuildMemoryProps {
  isLoading: boolean;
}

interface MemoryStats {
  recordedBuilds: number;
  successfulPatterns: number;
  failedPatterns: number;
  enabled: boolean;
  connected: boolean;
}

export function BuildMemory({ isLoading }: BuildMemoryProps) {
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState(isLoading);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/build-memory/stats');
        const data = await res.json();
        setStats(data);
      } catch {
        // No fake fallback — stats stays null, skeleton shown
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 60000); // Poll every 60 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading || !stats) {
    return <SkeletonCard />;
  }

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="panel-title">Build Memory</h3>
        <span className="panel-badge">Learning</span>
      </div>
      <div className="card-body">
        <div className="stat-grid">
          <div className="stat-item">
            <div className="stat-label">Recorded</div>
            <div className="stat-value">{stats.recordedBuilds}</div>
            <div className="stat-sub">builds</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Good Patterns</div>
            <div className="stat-value" style={{ color: '#10b981' }}>
              {stats.successfulPatterns}
            </div>
            <div className="stat-sub">reusable</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Warnings</div>
            <div className="stat-value" style={{ color: '#f97316' }}>
              {stats.failedPatterns}
            </div>
            <div className="stat-sub">patterns</div>
          </div>
        </div>

        <div style={{ marginTop: 'var(--spacing-lg)' }}>
          <div style={{ marginBottom: 'var(--spacing-sm)' }}>
            <small style={{ color: 'var(--text-secondary)', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Status
            </small>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--spacing-sm)' }}>
            <div
              style={{
                width: '8px',
                height: '8px',
                borderRadius: '50%',
                background: stats.enabled ? '#10b981' : '#888',
                boxShadow: stats.enabled ? '0 0 8px #10b981' : 'none',
              }}
            />
            <span style={{ color: stats.enabled ? '#10b981' : '#888' }}>
              {stats.enabled && stats.connected ? 'Learning Active' :
               stats.enabled ? 'Learning Enabled (connecting...)' :
               'Learning Disabled'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
