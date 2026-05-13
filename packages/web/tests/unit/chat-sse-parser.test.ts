/**
 * Unit tests — SSE-over-fetch chat stream parser.
 *
 * Verifies the contract between /api/chat/stream and the React Chat page:
 *  - retrieval event is delivered before any token (R3/R7 ordering)
 *  - partial chunks (split mid-event) are buffered and stitched
 *  - malformed JSON lines are skipped without crashing
 *  - token / done / error / tool events all parse to the right shape
 */
import { describe, it, expect } from 'vitest';
import { consumeSseChunk } from '../../src/client/chat-sse-parser.js';

function frame(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe('consumeSseChunk', () => {
  it('parses a single complete event', () => {
    const r = consumeSseChunk('', frame({ type: 'token', content: 'hi' }));
    expect(r.buffer).toBe('');
    expect(r.events).toEqual([{ type: 'token', content: 'hi' }]);
  });

  it('preserves retrieval-before-token ordering across one chunk', () => {
    const meta = { retrievalIntent: 'EXACT_SEARCH', retrievalSource: 'fts', retrievalMatchCount: 3, retrievalDocuments: [] };
    const r = consumeSseChunk(
      '',
      frame({ type: 'retrieval', retrieval: meta }) +
        frame({ type: 'token', content: 'hello' }) +
        frame({ type: 'done', content: 'hello', sessionId: 's-1' }),
    );
    expect(r.events.map((e) => e.type)).toEqual(['retrieval', 'token', 'done']);
    expect(r.events[0]).toMatchObject({ type: 'retrieval', retrieval: meta });
    expect(r.events[2]).toMatchObject({ type: 'done', content: 'hello', sessionId: 's-1' });
  });

  it('buffers a partial trailing event and emits it when the rest arrives', () => {
    const partial = 'data: {"type":"token","content":"par';
    const a = consumeSseChunk('', partial);
    expect(a.events).toEqual([]);
    expect(a.buffer).toBe(partial);

    const b = consumeSseChunk(a.buffer, 'tial"}\n\n');
    expect(b.buffer).toBe('');
    expect(b.events).toEqual([{ type: 'token', content: 'partial' }]);
  });

  it('handles two events split across a chunk boundary', () => {
    const ev1 = frame({ type: 'token', content: 'a' });
    const ev2 = frame({ type: 'token', content: 'b' });
    const wholeBefore = ev1 + ev2;
    // split at an arbitrary mid-point inside ev2
    const cut = ev1.length + 5;
    const a = consumeSseChunk('', wholeBefore.slice(0, cut));
    const b = consumeSseChunk(a.buffer, wholeBefore.slice(cut));
    expect([...a.events, ...b.events]).toEqual([
      { type: 'token', content: 'a' },
      { type: 'token', content: 'b' },
    ]);
  });

  it('skips malformed JSON without throwing', () => {
    const bad = 'data: {not json}\n\n';
    const good = frame({ type: 'token', content: 'ok' });
    const r = consumeSseChunk('', bad + good);
    expect(r.events).toEqual([{ type: 'token', content: 'ok' }]);
  });

  it('parses error events with optional code', () => {
    const r = consumeSseChunk('', frame({ type: 'error', code: 'PROVIDER_AUTH_MISSING', message: 'not authenticated' }));
    expect(r.events).toEqual([
      { type: 'error', code: 'PROVIDER_AUTH_MISSING', message: 'not authenticated' },
    ]);
  });

  it('parses tool events into name + args', () => {
    const r = consumeSseChunk(
      '',
      frame({ type: 'tool', tool: 'shell', args: { command: 'ls' } }),
    );
    expect(r.events).toEqual([
      { type: 'tool', tool: 'shell', args: { command: 'ls' } },
    ]);
  });

  it('treats unknown event types as { type: "unknown", raw }', () => {
    const r = consumeSseChunk('', frame({ type: 'mystery', x: 1 }));
    expect(r.events).toEqual([{ type: 'unknown', raw: { type: 'mystery', x: 1 } }]);
  });

  it('ignores frames without a data: line', () => {
    const r = consumeSseChunk('', 'event: ping\n\n' + frame({ type: 'token', content: 'x' }));
    expect(r.events).toEqual([{ type: 'token', content: 'x' }]);
  });
});
