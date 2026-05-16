import React, { useState, useEffect } from 'react';
import { ChatSessions } from '../components/panels/ChatSessions';
import { ProjectWorkflow } from '../components/panels/ProjectWorkflow';
import { ActivityFeed } from '../components/panels/ActivityFeed';
import { ActiveLLMRouting } from '../components/panels/ActiveLLMRouting';
import { SelfHealing } from '../components/panels/SelfHealing';
import { SelfLearning } from '../components/panels/SelfLearning';
import { RuntimeSettings } from '../components/panels/RuntimeSettings';
import { QuickActions, type QuickAction } from '../components/QuickActions';
import '../styles/Dashboard.css';

/**
 * Dashboard — user-facing landing page.
 *
 * Operational controls (system health, build control, model routing,
 * memory management, intelligence, self-improvement) live exclusively
 * in the Command Center (/api/command-center).
 *
 * This page surfaces user-facing navigation and activity only.
 */
export function Dashboard() {
  const [isLoading, setIsLoading] = useState(true);
  const [projectCount, setProjectCount] = useState<number | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setIsLoading(false), 500);
    return () => clearTimeout(timer);
  }, []);

  // Fetch real project/task count for the "View Projects" badge.
  // No hardcoded numbers — if the endpoint fails or returns 0, no badge shown.
  useEffect(() => {
    let cancelled = false;
    fetch('/api/automation/runs')
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((data) => {
        if (cancelled) return;
        const runs = Array.isArray(data?.runs) ? data.runs : Array.isArray(data) ? data : [];
        setProjectCount(runs.length);
      })
      .catch(() => { if (!cancelled) setProjectCount(0); });
    return () => { cancelled = true; };
  }, []);

  const quickActions: QuickAction[] = [
    {
      id: 'new-build',
      label: 'New Build',
      description: 'Start a new app generation',
      icon: '🔨',
      color: 'cyan',
      action: () => {
        window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'chat' } }));
      }
    },
    {
      id: 'check-projects',
      label: 'View Projects',
      description: 'Check active projects',
      icon: '📁',
      color: 'magenta',
      ...(projectCount && projectCount > 0 ? { badge: String(projectCount) } : {}),
      action: () => {
        window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'projects' } }));
      }
    },
    {
      id: 'view-workflow-stats',
      label: 'Workflow Stats',
      description: 'Aggregate automation-run metrics',
      icon: '⚙️',
      color: 'purple',
      action: () => {
        window.dispatchEvent(new CustomEvent('navigate', { detail: { page: 'projects' } }));
      }
    },
  ];

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>AgentX Dashboard</h1>
        <p className="dashboard-subtitle">Chat, build, and manage your projects</p>
      </div>

      <QuickActions actions={quickActions} columns={4} />

      <div className="dashboard-grid">
        <div className="grid grid-cols-2">
          <ChatSessions isLoading={isLoading} />
          <ProjectWorkflow isLoading={isLoading} />
        </div>

        <div className="grid grid-cols-2">
          <ActivityFeed isLoading={isLoading} />
          <ActiveLLMRouting />
        </div>

        <div className="grid grid-cols-2">
          <SelfHealing />
          <SelfLearning />
        </div>

        <div className="grid grid-cols-1">
          <RuntimeSettings />
        </div>
      </div>
    </div>
  );
}
