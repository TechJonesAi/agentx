import React, { useState, useEffect, useCallback } from 'react';
import { SkeletonCard } from '../Skeleton';
import { useEvent, useEvents } from '../../hooks/useEventBus';
import { eventBus, type EventType, type EventPayload } from '../../utils/event-bus';

interface ActivityFeedProps {
  isLoading: boolean;
}

interface Activity {
  id: string;
  type: 'build' | 'project' | 'task' | 'error' | 'warn' | 'info';
  message: string;
  timestamp: number;
  level?: string;
}

export function ActivityFeed({ isLoading }: ActivityFeedProps) {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(isLoading);

  // Load initial history from event bus
  useEffect(() => {
    const history = eventBus.getHistory(undefined, 50);
    const mapped = history.map((event, idx) => {
      let type: Activity['type'] = 'info';
      let message = '';

      if (event.type.startsWith('build.')) {
        type = 'build';
        const payload = event.payload as any;
        if (event.type === 'build.completed') {
          message = `Build completed: ${payload.appName} (${payload.duration}ms)`;
        } else if (event.type === 'build.failed') {
          message = `Build failed: ${payload.error}`;
          type = 'error';
        } else if (event.type === 'build.started') {
          message = `Build started: ${payload.appName} (${payload.platform})`;
        }
      } else if (event.type.startsWith('workflow.')) {
        type = 'project';
        const payload = event.payload as any;
        if (event.type === 'workflow.completed') {
          message = `Workflow completed: ${payload.workflowId}`;
        } else if (event.type === 'workflow.stage_changed') {
          message = `Workflow stage changed to: ${payload.stage}`;
        }
      } else if (event.type === 'system.error') {
        type = 'error';
        const payload = event.payload as any;
        message = payload.message;
      } else if (event.type === 'system.warning') {
        type = 'warn';
        const payload = event.payload as any;
        message = payload.message;
      } else if (event.type === 'memory.updated') {
        type = 'info';
        const payload = event.payload as any;
        message = `Memory updated: ${payload.summary}`;
      } else if (event.type === 'tool.executed') {
        type = 'task';
        const payload = event.payload as any;
        message = `Tool executed: ${payload.toolName} (${payload.duration}ms)`;
      }

      return {
        id: `${event.type}-${idx}`,
        type,
        message: message || event.type,
        timestamp: event.timestamp,
      };
    });

    setActivities(mapped);
    setLoading(false);
  }, []);

  // Subscribe to new events and prepend to activities
  const handleEvent = useCallback((eventType: EventType, payload: EventPayload) => {
    let type: Activity['type'] = 'info';
    let message = '';

    if (eventType.startsWith('build.')) {
      type = 'build';
      const p = payload as any;
      if (eventType === 'build.completed') {
        message = `Build completed: ${p.appName} (${p.duration}ms)`;
      } else if (eventType === 'build.failed') {
        message = `Build failed: ${p.error}`;
        type = 'error';
      } else if (eventType === 'build.started') {
        message = `Build started: ${p.appName}`;
      }
    } else if (eventType.startsWith('workflow.')) {
      type = 'project';
      const p = payload as any;
      if (eventType === 'workflow.completed') {
        message = `Workflow completed: ${p.workflowId}`;
      } else if (eventType === 'workflow.stage_changed') {
        message = `Workflow stage: ${p.stage}`;
      }
    } else if (eventType === 'system.error') {
      type = 'error';
      const p = payload as any;
      message = p.message;
    } else if (eventType === 'system.warning') {
      type = 'warn';
      const p = payload as any;
      message = p.message;
    } else if (eventType === 'memory.updated') {
      type = 'info';
      const p = payload as any;
      message = `Memory: ${p.summary}`;
    } else if (eventType === 'tool.executed') {
      type = 'task';
      const p = payload as any;
      message = `Tool: ${p.toolName} (${p.duration}ms)`;
    }

    setActivities(prev => [
      {
        id: `${eventType}-${Date.now()}`,
        type,
        message: message || eventType,
        timestamp: Date.now(),
      },
      ...prev.slice(0, 49), // Keep last 50 activities
    ]);
  }, []);

  // Subscribe to all event types
  useEvents(
    ['build.started', 'build.completed', 'build.failed', 'workflow.started', 'workflow.completed', 'workflow.stage_changed', 'memory.updated', 'tool.executed', 'system.error', 'system.warning'] as EventType[],
    handleEvent
  );

  if (loading || activities.length === 0) {
    return <SkeletonCard />;
  }

  const getActivityColor = (type: Activity['type']) => {
    switch (type) {
      case 'build':
        return '#00d9ff';
      case 'project':
        return '#d946ef';
      case 'task':
        return '#10b981';
      case 'error':
        return '#ef4444';
      case 'warn':
        return '#f97316';
      default:
        return '#a0a0a0';
    }
  };

  const getActivityLabel = (type: Activity['type']) => {
    switch (type) {
      case 'build':
        return 'BUILD';
      case 'project':
        return 'PROJECT';
      case 'task':
        return 'TASK';
      case 'error':
        return 'ERROR';
      case 'warn':
        return 'WARN';
      default:
        return 'INFO';
    }
  };

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="panel-title">Activity Feed</h3>
        <span className="panel-badge">Recent</span>
      </div>
      <div className="card-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-sm)' }}>
          {activities.map((activity) => (
            <div
              key={activity.id}
              style={{
                display: 'flex',
                gap: 'var(--spacing-md)',
                padding: 'var(--spacing-md)',
                background: 'var(--bg-tertiary)',
                border: `1px solid ${getActivityColor(activity.type)}40`,
                borderLeft: `4px solid ${getActivityColor(activity.type)}`,
                borderRadius: 'var(--radius-md)',
                transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = getActivityColor(activity.type);
                (e.currentTarget as HTMLDivElement).style.boxShadow = `0 0 10px ${getActivityColor(activity.type)}20`;
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLDivElement).style.borderColor = `${getActivityColor(activity.type)}40`;
                (e.currentTarget as HTMLDivElement).style.boxShadow = 'none';
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: '32px',
                  height: '32px',
                  flexShrink: 0,
                  borderRadius: 'var(--radius-md)',
                  background: `${getActivityColor(activity.type)}15`,
                  color: getActivityColor(activity.type),
                  fontSize: 'var(--text-xs)',
                  fontWeight: 'bold',
                }}
              >
                {getActivityLabel(activity.type)[0]}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ color: 'var(--text-primary)', fontWeight: 'bold', marginBottom: 'var(--spacing-xs)' }}>
                  {activity.message}
                </div>
                <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-xs)' }}>
                  {formatTime(activity.timestamp)}
                </div>
              </div>
            </div>
          ))}
        </div>
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
