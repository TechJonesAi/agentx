import React, { useState, useEffect } from 'react';
import { SkeletonCard } from '../Skeleton';

interface ToolsPanelProps {
  isLoading: boolean;
}

interface Tool {
  name: string;
  enabled: boolean;
  category: string;
  description?: string;
}

export function ToolsPanel({ isLoading }: ToolsPanelProps) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(isLoading);

  useEffect(() => {
    const fetchTools = async () => {
      try {
        const res = await fetch('/api/tools');
        const data = await res.json();
        setTools(data);
      } catch {
        // No fake fallback — tools stays empty, skeleton shown
      } finally {
        setLoading(false);
      }
    };

    fetchTools();
    const interval = setInterval(fetchTools, 120000); // Poll every 2 minutes
    return () => clearInterval(interval);
  }, []);

  if (loading || tools.length === 0) {
    return <SkeletonCard />;
  }

  const enabledCount = tools.filter((t) => t.enabled).length;

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="panel-title">Tools</h3>
        <span className="panel-badge">
          {enabledCount}/{tools.length}
        </span>
      </div>
      <div className="card-body">
        <div className="item-list">
          {tools.map((tool) => (
            <div key={tool.name} className="item">
              <div className="item-label">
                <div className="item-name">{tool.name}</div>
                <div className="item-description">{tool.category}</div>
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--spacing-sm)',
                }}
              >
                <div
                  style={{
                    width: '8px',
                    height: '8px',
                    borderRadius: '50%',
                    background: tool.enabled ? '#10b981' : '#606060',
                    boxShadow: tool.enabled ? '0 0 8px #10b981' : 'none',
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
