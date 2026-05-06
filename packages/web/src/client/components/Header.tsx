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
          title={isForced ? `${currentModel} (pinned from Settings → Default Model)` : currentModel}
        >
          <span className="model-label">Model</span>
          <code className="model-value">{currentModel}</code>
          {isForced && <span className="model-forced-tag" title="User override is active">FORCED</span>}
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
