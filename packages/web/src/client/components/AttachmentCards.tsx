/**
 * AttachmentCards — renders the per-attachment summary returned by
 * POST /api/chat/multimodal. Pure visual component, no fetches.
 *
 * Each attachment is shown as a card with:
 *   - icon by kind (🖼 image / 📄 document / 📎 unknown)
 *   - filename + size + mimeType
 *   - available/unavailable badge
 *   - extracted/described preview text (collapsed by default — toggle to expand)
 *   - error reason with install/configure hint when unavailable
 */
import React, { useState } from 'react';

export interface AttachmentSummary {
  filename: string;
  kind: 'image' | 'document' | 'unknown';
  size: number;
  mimeType?: string;
  available: boolean;
  reason?: string;
  preview?: string;
  textLength?: number;
}

function iconFor(kind: AttachmentSummary['kind']): string {
  if (kind === 'image') return '🖼';
  if (kind === 'document') return '📄';
  return '📎';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function AttachmentCards({ attachments }: { attachments: AttachmentSummary[] }): React.JSX.Element | null {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div
      className="attachment-cards"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: '6px',
        margin: '8px 0',
      }}
    >
      {attachments.map((a, i) => <Card key={i} a={a} />)}
    </div>
  );
}

function Card({ a }: { a: AttachmentSummary }): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const badgeColor = a.available ? '#3fb950' : '#d29922';
  const badgeText = a.available ? 'extracted' : 'unavailable';
  const borderColor = a.available ? 'var(--border, #30363d)' : '#5a4a1a';
  return (
    <div
      style={{
        border: `1px solid ${borderColor}`,
        borderRadius: '8px',
        padding: '8px 10px',
        background: 'var(--bg-secondary, #161b22)',
        fontSize: '12px',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 }}>
          <span style={{ fontSize: '14px' }}>{iconFor(a.kind)}</span>
          <span style={{
            fontWeight: 600,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            maxWidth: '240px',
          }}>
            {a.filename}
          </span>
          <span style={{ color: 'var(--text-tertiary, #6e7681)' }}>
            · {a.kind} · {formatSize(a.size)}
          </span>
        </span>
        <span style={{ color: badgeColor, fontWeight: 600, whiteSpace: 'nowrap' }}>
          ● {badgeText}
        </span>
      </div>

      {a.available && a.preview && (
        <div style={{ marginTop: '6px' }}>
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary, #8b949e)',
              cursor: 'pointer',
              fontSize: '11px',
              padding: 0,
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
            }}
            aria-expanded={expanded}
          >
            <span
              style={{
                display: 'inline-block',
                transform: expanded ? 'rotate(90deg)' : 'none',
                transition: 'transform 0.2s',
              }}
            >▶</span>
            {expanded ? 'Hide' : 'Show'} {a.kind === 'image' ? 'description' : 'extracted text'}
            {a.textLength ? ` (${a.textLength.toLocaleString()} chars)` : ''}
          </button>
          {expanded && (
            <pre
              style={{
                margin: '6px 0 0',
                padding: '8px 10px',
                background: 'var(--bg-primary, #0d1117)',
                border: '1px solid var(--border, #30363d)',
                borderRadius: '6px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontSize: '11px',
                lineHeight: 1.5,
                color: 'var(--text-primary, #c9d1d9)',
              }}
            >
              {a.preview}
            </pre>
          )}
        </div>
      )}

      {!a.available && a.reason && (
        <div
          style={{
            marginTop: '6px',
            padding: '6px 8px',
            background: 'var(--bg-primary, #0d1117)',
            border: '1px dashed #5a4a1a',
            borderRadius: '6px',
            color: '#d29922',
            fontSize: '11px',
            lineHeight: 1.4,
          }}
        >
          {a.reason}
        </div>
      )}
    </div>
  );
}
