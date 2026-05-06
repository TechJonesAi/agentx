/**
 * Pure SSE-over-fetch event parser for the chat stream.
 *
 * The server emits one `data: <json>\n\n` block per event (see
 * `packages/web/src/server/routes/api.ts`, /api/chat/stream branch). This
 * helper buffers partial chunks and yields parsed events as they complete.
 *
 * Pulled out of `pages/Chat.tsx` so it can be unit-tested without a DOM.
 */

export type ChatStreamEvent =
  | { type: 'retrieval'; retrieval: unknown }
  | { type: 'token'; content: string }
  | { type: 'tool'; tool: string; args: Record<string, unknown> }
  | { type: 'done'; content: string; sessionId?: string }
  | { type: 'error'; code?: string; message: string }
  | { type: 'unknown'; raw: Record<string, unknown> };

/**
 * Append `chunk` to `buffer` and extract any complete events.
 * Returns the remaining (unconsumed) buffer plus the events parsed.
 */
export function consumeSseChunk(
  buffer: string,
  chunk: string,
): { buffer: string; events: ChatStreamEvent[] } {
  let buf = buffer + chunk;
  const events: ChatStreamEvent[] = [];
  let idx: number;
  while ((idx = buf.indexOf('\n\n')) !== -1) {
    const raw = buf.slice(0, idx);
    buf = buf.slice(idx + 2);
    const dataLine = raw.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(dataLine.slice(6)) as Record<string, unknown>;
    } catch {
      continue; // skip malformed event
    }
    events.push(toEvent(parsed));
  }
  return { buffer: buf, events };
}

function toEvent(raw: Record<string, unknown>): ChatStreamEvent {
  const type = raw['type'];
  switch (type) {
    case 'retrieval':
      return { type: 'retrieval', retrieval: raw['retrieval'] ?? null };
    case 'token':
      return { type: 'token', content: String(raw['content'] ?? '') };
    case 'tool':
      return {
        type: 'tool',
        tool: String(raw['tool'] ?? ''),
        args: (raw['args'] as Record<string, unknown>) ?? {},
      };
    case 'done':
      return {
        type: 'done',
        content: String(raw['content'] ?? ''),
        sessionId:
          typeof raw['sessionId'] === 'string'
            ? (raw['sessionId'] as string)
            : undefined,
      };
    case 'error':
      return {
        type: 'error',
        code:
          typeof raw['code'] === 'string' ? (raw['code'] as string) : undefined,
        message: String(raw['message'] ?? 'Unknown error'),
      };
    default:
      return { type: 'unknown', raw };
  }
}
