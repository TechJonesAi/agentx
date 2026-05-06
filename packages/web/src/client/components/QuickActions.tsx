/**
 * Quick Actions Component
 * Fast access to common dashboard actions
 */

import React from 'react';
import './QuickActions.css';

export interface QuickAction {
  id: string;
  label: string;
  description: string;
  icon: string;
  action: () => void;
  color?: 'cyan' | 'magenta' | 'purple' | 'default';
  badge?: string;  // e.g., "3" for 3 pending items
}

interface QuickActionsProps {
  actions: QuickAction[];
  columns?: number;  // 2, 3, or 4
}

export function QuickActions({ actions, columns = 3 }: QuickActionsProps) {
  if (actions.length === 0) return null;

  return (
    <div className={`quick-actions quick-actions-${columns}col`}>
      {actions.map(action => (
        <button
          key={action.id}
          className={`quick-action-button quick-action-${action.color || 'default'}`}
          onClick={action.action}
          title={action.description}
        >
          <div className="quick-action-icon">{action.icon}</div>
          <div className="quick-action-label">{action.label}</div>
          {action.badge && (
            <div className="quick-action-badge">{action.badge}</div>
          )}
        </button>
      ))}
    </div>
  );
}

/**
 * Quick Action Row - for inserting above panels
 */
export function QuickActionsRow({ actions }: { actions: QuickAction[] }) {
  return (
    <div className="quick-actions-row">
      <QuickActions actions={actions} columns={2} />
    </div>
  );
}
