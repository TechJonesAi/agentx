/**
 * renderMessageContent — code-block + tool-call aware text renderer.
 *
 * Lifted from Silly Johnson Chat.tsx. Splits content on fenced code blocks
 * (```lang\n...\n```) and recognises leaked tool-call JSON, rendering each
 * appropriately. Pure transform — no fetches, no state.
 */
import React from 'react';

const TOOL_CALL_PATTERN = /\{"name"\s*:\s*"(\w+)"\s*,\s*"arguments"\s*:\s*\{/;

export function renderMessageContent(content: string): React.ReactNode {
  if (!content) return null;

  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts.map((part, i) => {
    // Fenced code block
    if (part.startsWith('```')) {
      const lines = part.slice(3, -3).split('\n');
      const lang = lines[0]?.trim() || '';
      const code = (lang ? lines.slice(1) : lines).join('\n');
      return (
        <pre
          key={i}
          style={{
            background: '#0d1117',
            padding: '12px',
            borderRadius: '6px',
            overflow: 'auto',
            fontSize: '12px',
            fontFamily: 'monospace',
            border: '1px solid #30363d',
            margin: '8px 0',
          }}
        >
          {lang && <div style={{ color: '#8b949e', fontSize: '11px', marginBottom: '6px' }}>{lang}</div>}
          <code>{code}</code>
        </pre>
      );
    }

    // Leaked tool-call JSON — render as a compact "executing…" card
    if (TOOL_CALL_PATTERN.test(part)) {
      const toolMatch = part.match(/"name"\s*:\s*"(\w+)"/);
      const cmdMatch = part.match(/"command"\s*:\s*"([^"]*(?:\\.[^"]*)*)"/);
      const toolName = toolMatch?.[1] ?? 'tool';
      const command = cmdMatch?.[1]?.replace(/\\n/g, '\n').replace(/\\"/g, '"').slice(0, 200) ?? '';
      return (
        <div
          key={i}
          style={{
            background: '#0d1117',
            border: '1px solid #30363d',
            borderRadius: '6px',
            padding: '10px',
            margin: '8px 0',
            fontFamily: 'monospace',
            fontSize: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px' }}>
            <span
              style={{
                background: '#1f6feb22',
                color: '#58a6ff',
                padding: '2px 8px',
                borderRadius: '4px',
                fontSize: '11px',
              }}
            >
              {toolName}
            </span>
            <span style={{ color: '#8b949e', fontSize: '11px' }}>executing…</span>
          </div>
          {command && (
            <div style={{ color: '#c9d1d9', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {command.slice(0, 200)}
              {command.length > 200 ? '…' : ''}
            </div>
          )}
        </div>
      );
    }

    return (
      <span key={i} style={{ whiteSpace: 'pre-wrap' }}>
        {part}
      </span>
    );
  });
}
