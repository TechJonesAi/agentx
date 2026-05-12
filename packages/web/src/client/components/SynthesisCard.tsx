/**
 * SynthesisCard — pure presentational component lifted from Silly Johnson Chat.tsx.
 *
 * Renders a structured "synthesis answer" with confidence badge, source chips,
 * supporting points and an optional recommendation. The chat backend does NOT
 * emit synthesis metadata today, so this card is only rendered when an
 * assistant message carries the optional `synthesis` field — i.e. it stays
 * dormant until the synthesis pipeline is restored. No fetches.
 */
import React, { useState } from 'react';

export interface SynthesisData {
  answer: string;
  supportingPoints: string[];
  confidence: 'high' | 'medium' | 'low';
  sources: Array<{ type: string; label: string }>;
  recommendation: string | null;
  hasStepDetails?: boolean;
  stepCount?: number;
}

const CONFIDENCE_STYLES: Record<SynthesisData['confidence'], { bg: string; color: string; label: string }> = {
  high: { bg: '#1b3a2d', color: '#3fb950', label: 'High confidence' },
  medium: { bg: '#332d1a', color: '#d29922', label: 'Medium confidence' },
  low: { bg: '#3d1f1f', color: '#f85149', label: 'Low confidence' },
};

const SOURCE_ICONS: Record<string, string> = {
  memory: '📝',
  document: '📄',
  tool: '🔧',
  general_knowledge: '💡',
};

export function SynthesisCard({
  synthesis,
  rawContent,
  renderRaw,
}: {
  synthesis: SynthesisData;
  rawContent?: string;
  /** optional renderer for the raw expanded block (e.g. code-block aware). */
  renderRaw?: (content: string) => React.ReactNode;
}): React.JSX.Element {
  const [showDetails, setShowDetails] = useState(false);
  const conf = CONFIDENCE_STYLES[synthesis.confidence] ?? CONFIDENCE_STYLES.medium;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <div
        style={{
          background: '#161b22',
          border: '1px solid #30363d',
          borderRadius: '8px',
          padding: '14px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '10px', flexWrap: 'wrap' }}>
          <span
            style={{
              background: conf.bg,
              color: conf.color,
              padding: '2px 8px',
              borderRadius: '4px',
              fontSize: '11px',
              fontWeight: 600,
            }}
          >
            {conf.label}
          </span>
          {synthesis.sources.map((s, i) => (
            <span
              key={i}
              style={{
                background: '#0d1117',
                color: '#8b949e',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '11px',
              }}
            >
              {SOURCE_ICONS[s.type] ?? ''} {s.label}
            </span>
          ))}
        </div>

        <div style={{ color: '#e6edf3', whiteSpace: 'pre-wrap', lineHeight: 1.5 }}>{synthesis.answer}</div>

        {synthesis.supportingPoints.length > 0 && (
          <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid #21262d' }}>
            {synthesis.supportingPoints.map((p, i) => (
              <div
                key={i}
                style={{
                  color: '#8b949e',
                  fontSize: '13px',
                  padding: '2px 0 2px 12px',
                  borderLeft: '2px solid #30363d',
                  marginBottom: '4px',
                }}
              >
                {p}
              </div>
            ))}
          </div>
        )}

        {synthesis.recommendation && (
          <div
            style={{
              marginTop: '10px',
              padding: '8px 12px',
              background: '#0d1117',
              borderRadius: '6px',
              borderLeft: '3px solid #58a6ff',
              color: '#c9d1d9',
              fontSize: '13px',
            }}
          >
            <strong style={{ color: '#58a6ff' }}>Recommendation:</strong> {synthesis.recommendation}
          </div>
        )}
      </div>

      {rawContent && rawContent !== synthesis.answer && (
        <div>
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: '#8b949e',
              cursor: 'pointer',
              fontSize: '12px',
              padding: '4px 0',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}
          >
            <span
              style={{
                transform: showDetails ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.2s',
                display: 'inline-block',
              }}
            >
              ▶
            </span>
            {synthesis.stepCount && synthesis.stepCount > 0
              ? `${synthesis.stepCount} step${synthesis.stepCount === 1 ? '' : 's'} — show full response`
              : 'Show full response'}
          </button>
          {showDetails && (
            <div style={{ marginTop: '6px', padding: '10px', background: '#0d1117', borderRadius: '6px', border: '1px solid #21262d' }}>
              {renderRaw ? renderRaw(rawContent) : <pre style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{rawContent}</pre>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
