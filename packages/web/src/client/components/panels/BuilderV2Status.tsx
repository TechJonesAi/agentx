import React, { useState, useEffect } from 'react';
import { SkeletonCard } from '../Skeleton';
import { getCache, setCache } from '../../utils/db-cache';

interface BuilderV2StatusProps {
  isLoading: boolean;
}

interface BuilderStats {
  totalBuilds: number;
  successfulBuilds: number;
  successRate: number;
  lastBuildTime: number;
  platformBreakdown: {
    ios: { total: number; successful: number };
    web: { total: number; successful: number };
  };
}

export function BuilderV2Status({ isLoading }: BuilderV2StatusProps) {
  const [stats, setStats] = useState<BuilderStats | null>(null);
  const [loading, setLoading] = useState(isLoading);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        const res = await fetch('/api/builder/stats');
        const data = await res.json() as BuilderStats;
        setStats(data);
        setLoading(false);

        // Cache the data for offline access
        await setCache('/api/builder/stats', data, 60000); // 60s TTL
      } catch (error) {
        setLoading(false);

        // Try to get from cache
        const cached = await getCache('/api/builder/stats');
        if (cached) {
          setStats(cached as BuilderStats);
          console.log('[BuilderV2Status] Using cached data');
        }
        // No fake fallback — stats stays null, skeleton shown
      }
    };

    fetchStats();
    const interval = setInterval(fetchStats, 60000); // Poll every 60 seconds
    return () => clearInterval(interval);
  }, []);

  if (loading || !stats) {
    return <SkeletonCard />;
  }

  // Null-safe platform breakdown — API may return {} when no build system is connected
  const ios = stats.platformBreakdown?.ios ?? { total: 0, successful: 0 };
  const web = stats.platformBreakdown?.web ?? { total: 0, successful: 0 };

  const platformPct = (p: { total: number; successful: number }) =>
    p.total > 0 ? `${Math.round((p.successful / p.total) * 100)}% success` : 'No runs yet';

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="panel-title">Builder V2 Status</h3>
        <span className="panel-badge">{stats.totalBuilds > 0 ? 'Active' : 'No builds'}</span>
      </div>
      <div className="card-body">
        <div className="stat-grid">
          <div className="stat-item">
            <div className="stat-label">Success Rate</div>
            <div className="stat-value" style={{ color: '#10b981' }}>
              {stats.successRate}%
            </div>
            <div className="stat-sub">
              {stats.successfulBuilds}/{stats.totalBuilds} builds
            </div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Last Build</div>
            <div className="stat-value">{stats.lastBuildTime > 0 ? `${Math.round(stats.lastBuildTime / 100) / 10}s` : '—'}</div>
            <div className="stat-sub">App generation</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">iOS Status</div>
            <div className="stat-value" style={{ color: '#00d9ff' }}>
              {ios.successful}/{ios.total}
            </div>
            <div className="stat-sub">{platformPct(ios)}</div>
          </div>
          <div className="stat-item">
            <div className="stat-label">Web Status</div>
            <div className="stat-value" style={{ color: '#00d9ff' }}>
              {web.successful}/{web.total}
            </div>
            <div className="stat-sub">{platformPct(web)}</div>
          </div>
        </div>

        <div style={{ marginTop: 'var(--spacing-lg)' }}>
          <div style={{ marginBottom: 'var(--spacing-sm)' }}>
            <small style={{ color: 'var(--text-secondary)', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Benchmark Results
            </small>
          </div>
          <div className="progress-bar">
            <div
              className="progress-fill"
              style={{ width: `${stats.successRate}%` }}
            />
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 'var(--spacing-sm)', fontSize: 'var(--text-xs)' }}>
            <span>{stats.totalBuilds} apps tested</span>
            <span style={{ color: '#10b981' }}>{stats.successfulBuilds}/{stats.totalBuilds} passed</span>
          </div>
        </div>
      </div>
    </div>
  );
}
