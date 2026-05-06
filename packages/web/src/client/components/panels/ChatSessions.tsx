import React, { useState, useEffect } from 'react';

interface ChatSessionsProps {
  isLoading: boolean;
}

interface Session {
  sessionKey: string;
  title: string;
  updatedAt: number;
  messageCount?: number;
}

export function ChatSessions({ isLoading }: ChatSessionsProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(isLoading);

  useEffect(() => {
    const fetchSessions = async () => {
      try {
        const res = await fetch('/api/sessions');
        const data = await res.json();
        setSessions(
          Array.isArray(data)
            ? data.slice(0, 5).map((s: any) => ({
                sessionKey: s.id || s.sessionKey || 'unknown',
                title: s.title || s.id?.substring(0, 12) || 'Untitled',
                updatedAt: typeof s.updatedAt === 'string' ? new Date(s.updatedAt).getTime() : (s.updatedAt || Date.now()),
                messageCount: s.messageCount || 0,
              }))
            : [],
        );
      } catch {
        setSessions([]);
      } finally {
        setLoading(false);
      }
    };

    fetchSessions();
    const interval = setInterval(fetchSessions, 15000);
    return () => clearInterval(interval);
  }, []);

  if (loading) {
    return (
      <div className="card loading">
        <div className="spinner" />
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="panel-title">Chat Sessions</h3>
        <span className="panel-badge">{sessions.length}</span>
      </div>
      <div className="card-body">
        {sessions.length > 0 ? (
          <div className="item-list">
            {sessions.map((session) => (
              <div key={session.sessionKey} className="item">
                <div className="item-label">
                  <div className="item-name">{session.title}</div>
                  <div className="item-description">
                    Updated {formatTime(session.updatedAt)}
                  </div>
                </div>
                <div className="item-value">
                  {session.messageCount || 0}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="placeholder">
            <svg
              className="placeholder-icon"
              fill="none"
              viewBox="0 0 24 24"
            >
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
            <div className="placeholder-text">No active sessions</div>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;
  const seconds = Math.floor(diff / 1000);

  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
