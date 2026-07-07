import React, { useState, useEffect, useRef } from 'react';
import { Moon, Sun } from './Icons';
import './Header.css';

interface HeaderProps {
  systemHealth: 'healthy' | 'degraded' | 'offline';
  isDark: boolean;
  onThemeToggle: () => void;
}

/**
 * How often the header re-polls /api/status. At 30s the badge felt stale —
 * a chat call that swaps models wouldn't be reflected until the next tick.
 * Dropped to 5s so routing changes (capability pins, auto-escalation to a
 * stronger model, etc.) surface visibly. /api/status is a cheap read.
 */
const HEADER_POLL_MS = 5000;

export function Header({ systemHealth, isDark, onThemeToggle }: HeaderProps) {
  const [currentModel, setCurrentModel] = useState('—');
  const [activeSessions, setActiveSessions] = useState(0);
  // Becomes true for 800ms whenever the model value changes, driving a
  // subtle CSS animation so the user can see "something just swapped".
  const [modelFlash, setModelFlash] = useState(false);
  const previousModelRef = useRef<string>('');
  // True when the model is locked by Settings → Default Model (not the
  // router's dynamic choice). Drives a small "FORCED" tag next to the
  // badge so it's obvious WHY the badge isn't moving after chats.
  const [isForced, setIsForced] = useState(false);
  // Last ROUTED model/provider (what actually served the most recent
  // request) — the configured default alone was misleading whenever the
  // task router picked a different model or the oMLX fast lane.
  const [routedModel, setRoutedModel] = useState<string | null>(null);
  const [routedProvider, setRoutedProvider] = useState<string | null>(null);
  const [routedTask, setRoutedTask] = useState<string | null>(null);
  // oMLX fast-lane status light: 'up' | 'down' | 'unknown'.
  const [omlxState, setOmlxState] = useState<'up' | 'down' | 'unknown'>('unknown');

  useEffect(() => {
    let cancelled = false;

    const fetchStatus = async () => {
      try {
        const res = await fetch('/api/status');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const nextModel = data.model || data.configuredModel || '—';
        setIsForced(data.modelSource === 'user_override');
        setCurrentModel(prev => {
          if (prev && prev !== nextModel && previousModelRef.current !== nextModel) {
            // Fire the flash animation on real transitions only (skip the
            // initial placeholder → first value hydration).
            if (prev !== '—') {
              setModelFlash(true);
              setTimeout(() => setModelFlash(false), 800);
            }
            previousModelRef.current = nextModel;
          }
          return nextModel;
        });
        setActiveSessions(data.activeSessions || 0);
      } catch { /* transient — keep showing last good value */ }

      // Live routing truth: which model/provider served the last request.
      try {
        const r = await fetch('/api/models/routing/history?limit=1');
        if (r.ok) {
          const d = await r.json();
          const cur = d?.current;
          if (!cancelled && cur?.model) {
            setRoutedModel(cur.model);
            setRoutedProvider(cur.provider ?? null);
            setRoutedTask(cur.taskType ?? null);
          }
        }
      } catch { /* keep last good value */ }

      // oMLX fast-lane availability.
      try {
        const r = await fetch('/api/providers/omlx/status');
        if (r.ok) {
          const d = await r.json();
          if (!cancelled) setOmlxState(d?.available ? 'up' : 'down');
        } else if (!cancelled) setOmlxState('down');
      } catch { if (!cancelled) setOmlxState('down'); }
    };

    // Refresh immediately on mount, then poll.
    fetchStatus();
    const interval = setInterval(fetchStatus, HEADER_POLL_MS);

    // Also refresh right after any completed chat turn — the chat page can
    // emit this event so the header feels instant when you send a message.
    const onChatDone = () => { fetchStatus(); };
    window.addEventListener('agentx:chat-complete', onChatDone);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener('agentx:chat-complete', onChatDone);
    };
  }, []);

  const getHealthColor = () => {
    switch (systemHealth) {
      case 'healthy':
        return '#10b981';
      case 'degraded':
        return '#f97316';
      default:
        return '#ef4444';
    }
  };

  const getHealthLabel = () => {
    switch (systemHealth) {
      case 'healthy':
        return 'Healthy';
      case 'degraded':
        return 'Degraded';
      default:
        return 'Offline';
    }
  };

  return (
    <header className="header">
      <div className="header-left">
        <div className="logo">
          <span className="logo-text">AGENTX</span>
          <span className="logo-subtitle">CONTROL</span>
        </div>
      </div>

      <div className="header-center">
        <div className="status-badge">
          <div className="status-dot" style={{ background: getHealthColor() }} />
          <span className="status-text">{getHealthLabel()}</span>
        </div>
      </div>

      <div className="header-right">
        <div
          className={`model-badge${modelFlash ? ' model-badge-flash' : ''}${isForced ? ' model-badge-forced' : ''}`}
          title={
            isForced
              ? `${currentModel} (pinned from Settings → Default Model)`
              : routedModel
                ? `Last request: ${routedModel} via ${routedProvider ?? 'ollama'}${routedTask ? ` (task: ${routedTask})` : ''} — default: ${currentModel}`
                : `Configured default: ${currentModel} — routing picks per task`
          }
        >
          <span className="model-label">Model</span>
          <code className="model-value">{routedModel ?? currentModel}</code>
          {routedProvider === 'omlx' && (
            <span className="model-forced-tag" style={{ background: '#238636', color: '#fff' }} title="Served by the oMLX (Apple MLX) fast lane">
              ⚡ oMLX
            </span>
          )}
          {isForced && <span className="model-forced-tag" title="User override is active">FORCED</span>}
        </div>

        <div
          className="sessions-badge"
          title={
            omlxState === 'up'
              ? 'oMLX fast lane (Apple MLX, :8080) is running — light tasks are served 4-6× faster. Engaged automatically when benchmarks favour it.'
              : omlxState === 'down'
                ? 'oMLX fast lane is NOT running — all requests go through Ollama. The watchdog will restart it if installed.'
                : 'Checking oMLX fast lane…'
          }
        >
          <span
            className="status-dot"
            style={{
              background: omlxState === 'up' ? '#3fb950' : omlxState === 'down' ? '#f85149' : '#6e7681',
              width: 8, height: 8, borderRadius: '50%', display: 'inline-block',
            }}
          />
          <span className="sessions-label">oMLX</span>
        </div>

        <div className="sessions-badge">
          <span className="sessions-label">Sessions</span>
          <span className="sessions-value">{activeSessions}</span>
        </div>

        <button
          className="theme-toggle"
          onClick={onThemeToggle}
          title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun /> : <Moon />}
        </button>
      </div>
    </header>
  );
}
