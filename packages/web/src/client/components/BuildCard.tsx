/**
 * BuildCard — pure presentational component lifted from Silly Johnson Chat.tsx.
 *
 * Renders a single in-progress / completed build with worker breakdown and a
 * progress bar. Backend wiring for live builds is NOT in this commit — the
 * card is rendered only when a `build` prop is provided, so callers pass
 * `null` until the build-progress backend is restored.
 *
 * Pure visual component: no fetch, no useEffect, no polling.
 */
import React from 'react';

export interface BuildWorker {
  role: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  durationMs?: number;
}

export interface BuildProgress {
  goalId: string;
  appName: string;
  workspace: string;
  status: 'planning' | 'running' | 'completed' | 'failed' | 'cancelled';
  workers: BuildWorker[];
}

const STATUS_ICON: Record<BuildProgress['status'], string> = {
  planning: '⏳',
  running: '🔄',
  completed: '✅',
  failed: '❌',
  cancelled: '⏹',
};

const STATUS_COLOR: Record<BuildProgress['status'], string> = {
  planning: 'var(--color-info, #58a6ff)',
  running: 'var(--color-info, #58a6ff)',
  completed: 'var(--color-success, #3fb950)',
  failed: 'var(--color-danger, #f85149)',
  cancelled: 'var(--color-warning, #d29922)',
};

function workerIcon(s: BuildWorker['status']): string {
  return ({ pending: '⏳', running: '🔄', completed: '✅', failed: '❌' } as Record<string, string>)[s] ?? '⬜';
}

export function BuildCard({ build }: { build: BuildProgress }): React.JSX.Element {
  const color = STATUS_COLOR[build.status];
  const completed = build.workers.filter((w) => w.status === 'completed').length;
  const total = build.workers.length;
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <div
      className="build-card"
      style={{
        background: 'var(--bg-secondary, #161b22)',
        border: `1px solid ${color}`,
        borderLeft: `4px solid ${color}`,
        borderRadius: '12px',
        padding: '14px',
        margin: '8px 0',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 600 }}>
            {STATUS_ICON[build.status]} Building: {build.appName}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--text-secondary, #8b949e)', marginTop: '2px' }}>
            {build.workspace}
          </div>
        </div>
        <div style={{ fontSize: '11px', color, fontWeight: 600, textTransform: 'uppercase' }}>
          {build.status}
        </div>
      </div>

      <div style={{ background: 'var(--bg-primary, #0d1117)', borderRadius: '4px', height: '6px', marginBottom: '10px', overflow: 'hidden' }}>
        <div style={{ background: color, height: '100%', width: `${pct}%`, transition: 'width 0.3s ease' }} />
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
        {build.workers.map((w, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px' }}>
            <span>{workerIcon(w.status)}</span>
            <span style={{ textTransform: 'capitalize' }}>{w.role}</span>
            {w.durationMs && (
              <span style={{ color: 'var(--text-tertiary, #6e7681)', fontSize: '10px' }}>
                {(w.durationMs / 1000).toFixed(1)}s
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Empty/unavailable state — shown when no build is active or the backend isn't wired. */
export function BuildCardEmpty(): React.JSX.Element {
  return (
    <div
      className="build-card build-card--empty"
      style={{
        background: 'var(--bg-secondary, #161b22)',
        border: '1px dashed var(--border, #30363d)',
        borderRadius: '12px',
        padding: '14px',
        margin: '8px 0',
        textAlign: 'center',
        color: 'var(--text-tertiary, #6e7681)',
        fontSize: '12px',
      }}
    >
      No active build. Builder runtime is not wired on this build.
    </div>
  );
}
