import React, { useState, useEffect } from 'react';
import { SkeletonCard } from '../Skeleton';

interface ModelsProps {
  isLoading: boolean;
}

interface Model {
  provider: string;
  name: string;
  active: boolean;
}

export function ModelsPanel({ isLoading }: ModelsProps) {
  const [models, setModels] = useState<Model[]>([]);
  const [activeModelName, setActiveModelName] = useState('claude-3-5-sonnet');
  const [loading, setLoading] = useState(isLoading);

  useEffect(() => {
    const fetchModels = async () => {
      try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error('Failed to fetch config');

        const data = await res.json();

        // Get current active model
        const activeModel = data.agent?.model || 'Unknown';
        setActiveModelName(activeModel);

        // Build model list from providers using actual model names
        const providers = data.providers || [];
        const providerModels = data.providerModels || {};
        const modelList: Model[] = [];

        for (const provider of providers) {
          const providerCfg = providerModels[provider];
          if (providerCfg) {
            const modelName = providerCfg.model || provider;
            const displayProvider = provider.charAt(0).toUpperCase() + provider.slice(1);
            modelList.push({
              provider: displayProvider,
              name: modelName,
              active: activeModel === modelName,
            });
          }
        }

        // Use real models if found; otherwise leave empty
        setModels(modelList);
      } catch (err) {
        // No fake fallback — models stays empty, skeleton shown
      } finally {
        setLoading(false);
      }
    };

    fetchModels();
    const interval = setInterval(fetchModels, 120000); // Poll every 2 minutes
    return () => clearInterval(interval);
  }, []);

  if (loading || models.length === 0) {
    return <SkeletonCard />;
  }

  const activeModel = models.find((m) => m.active);

  return (
    <div className="card">
      <div className="card-header">
        <h3 className="panel-title">Models</h3>
        <span className="panel-badge">{models.length}</span>
      </div>
      <div className="card-body">
        {activeModel && (
          <div
            style={{
              padding: 'var(--spacing-md)',
              background: 'var(--bg-tertiary)',
              border: '2px solid var(--color-primary)',
              borderRadius: 'var(--radius-md)',
              marginBottom: 'var(--spacing-lg)',
            }}
          >
            <small style={{ color: 'var(--text-secondary)', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Active Model
            </small>
            <div
              style={{
                marginTop: 'var(--spacing-sm)',
                fontSize: 'var(--text-lg)',
                fontWeight: 'bold',
                color: 'var(--color-primary)',
              }}
            >
              {activeModel.name}
            </div>
            <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', marginTop: 'var(--spacing-xs)' }}>
              {activeModel.provider}
            </div>
          </div>
        )}

        <div style={{ marginBottom: 'var(--spacing-sm)' }}>
          <small style={{ color: 'var(--text-secondary)', fontWeight: 'bold', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
            Available Models
          </small>
        </div>
        <div className="item-list">
          {models.map((model) => (
            <div key={model.name} className="item">
              <div className="item-label">
                <div className="item-name">{model.name}</div>
                <div className="item-description">{model.provider}</div>
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
                    background: model.active ? '#10b981' : '#606060',
                    boxShadow: model.active ? '0 0 8px #10b981' : 'none',
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
