/**
 * Step 3 — live regression for the SPA's two main outbound flows:
 *
 *  1. POST /api/chat/feedback persists the SPA payload (R11) — the body
 *     produced by `feedback-payload.ts` round-trips into the agent's
 *     recordFeedback() function and 200s.
 *
 *  2. POST /api/chat/stream emits the `retrieval` event BEFORE any
 *     `token` events (R3/R7 ordering), and finishes with `done`.
 *
 *  3. /api/providers — provider/model badge data is well-formed.
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import { buildFeedbackPayload } from '../../src/client/feedback-payload.js';

interface RecordFeedbackCall {
  payload: unknown;
}

function fakeAgentWithFeedback(opts: {
  recordFeedback?: (p: unknown) => unknown;
  retrievalMeta?: unknown;
  streamScript?: (cbs: StreamCallbacks) => Promise<void>;
}): { agent: unknown; calls: RecordFeedbackCall[] } {
  const calls: RecordFeedbackCall[] = [];
  const agent = {
    async chat() { return 'ok'; },
    async chatStream(_msg: string, cbs: StreamCallbacks) {
      if (opts.streamScript) await opts.streamScript(cbs);
    },
    getLastRetrievalMetadata() { return opts.retrievalMeta ?? null; },
    getConfig() {
      return {
        agent: { name: 'X', defaultProvider: 'anthropic', model: 'claude-sonnet-4' },
        providers: {
          anthropic: { model: 'claude-sonnet-4', maxTokens: 4096 },
          openai: { model: 'gpt-4o', maxTokens: 4096 },
          ollama: { model: 'llama3', baseUrl: 'http://localhost:11434' },
        },
      };
    },
    getSessionStore() { return null; },
    getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
    getToolRegistry() { return { getDefinitions() { return []; } }; },
    recordFeedback(payload: unknown) {
      calls.push({ payload });
      if (opts.recordFeedback) return opts.recordFeedback(payload);
      return { id: 1, ...(payload as Record<string, unknown>) };
    },
  };
  return { agent, calls };
}

interface StreamCallbacks {
  onRetrieval?: (m: unknown) => void;
  onToken?: (t: string) => void;
  onComplete?: (r: { content: string }) => void;
  onError?: (e: Error) => void;
  onToolCall?: (t: { id: string; name: string; arguments: Record<string, unknown> }) => void;
}

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function call(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
  body?: unknown,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : '';
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, {
      method,
      url,
      headers: data ? { 'content-type': 'application/json' } : {},
    });
    process.nextTick(() => {
      if (data) (req as unknown as { emit(e: string, ...a: unknown[]): void }).emit('data', Buffer.from(data, 'utf-8'));
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = [];
    let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(code: number) { status = code; return this as http.ServerResponse; },
      setHeader() { return this as http.ServerResponse; },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status, body: raw ? JSON.parse(raw) : {}, raw }); }
        catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

/** Capture an SSE response stream as the ordered list of parsed events. */
function callStream(
  router: ReturnType<typeof createApiRouter>,
  body: unknown,
): Promise<{ status: number; events: Array<Record<string, unknown>>; raw: string }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, {
      method: 'POST',
      url: '/api/chat/stream',
      headers: { 'content-type': 'application/json' },
    });
    process.nextTick(() => {
      (req as unknown as { emit(e: string, ...a: unknown[]): void }).emit('data', Buffer.from(data, 'utf-8'));
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    let status = 0;
    const chunks: Buffer[] = [];
    const res: Partial<http.ServerResponse> = {
      writeHead(code: number) { status = code; return this as http.ServerResponse; },
      setHeader() { return this as http.ServerResponse; },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const raw = Buffer.concat(chunks).toString('utf-8');
        const events: Array<Record<string, unknown>> = [];
        for (const block of raw.split('\n\n')) {
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          try { events.push(JSON.parse(line.slice(6)) as Record<string, unknown>); }
          catch { /* skip */ }
        }
        resolve({ status, events, raw });
      },
    };
    router.handle('POST', '/api/chat/stream', req, res as http.ServerResponse).catch(reject);
  });
}

describe('POST /api/chat/feedback — SPA payload round-trip (R11)', () => {
  it('persists a thumbs-up with the SPA-built payload', async () => {
    const { agent, calls } = fakeAgentWithFeedback({});
    const router = createApiRouter(agent as never);
    const payload = buildFeedbackPayload(
      {
        messageId: 'a-1',
        userQuery: 'how many docs?',
        assistantResponse: 'You have 17 documents.',
        sessionId: 's-42',
        retrieval: {
          retrievalIntent: 'COUNT',
          retrievalSource: 'sql',
          retrievalMatchCount: 17,
          retrievalDocuments: [],
        },
      },
      'up',
    );
    const r = await call(router, 'POST', '/api/chat/feedback', payload);
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(calls).toHaveLength(1);
    const stored = calls[0].payload as Record<string, unknown>;
    expect(stored['messageId']).toBe('a-1');
    expect(stored['rating']).toBe('up');
    expect(stored['sessionId']).toBe('s-42');
    expect(stored['retrievalIntent']).toBe('COUNT');
    expect(stored['retrievalSource']).toBe('sql');
    expect(stored['retrievalMatchCount']).toBe(17);
    // raw documents (with snippet text) must NOT have leaked through
    expect('retrievalDocuments' in stored).toBe(false);
  });

  it('persists a thumbs-down with retrievalDocumentIds projection', async () => {
    const { agent, calls } = fakeAgentWithFeedback({});
    const router = createApiRouter(agent as never);
    const payload = buildFeedbackPayload(
      {
        messageId: 'a-2',
        userQuery: 'find HR docs',
        assistantResponse: 'Found 2.',
        retrieval: {
          retrievalIntent: 'EXACT_SEARCH',
          retrievalSource: 'mixed',
          retrievalMatchCount: 2,
          retrievalDocuments: [
            { document_id: 'd1', file_name: 'a.pdf' },
            { document_id: 'd2', file_name: 'b.eml' },
          ],
        },
      },
      'down',
    );
    const r = await call(router, 'POST', '/api/chat/feedback', payload);
    expect(r.status).toBe(200);
    const stored = calls[0].payload as Record<string, unknown>;
    expect(stored['rating']).toBe('down');
    expect(stored['retrievalDocumentIds']).toEqual(['d1', 'd2']);
  });

  it('returns 400 when validate() throws (e.g. missing required field)', async () => {
    const { agent } = fakeAgentWithFeedback({
      recordFeedback: () => {
        throw new Error('feedback.userQuery is required');
      },
    });
    const router = createApiRouter(agent as never);
    const r = await call(router, 'POST', '/api/chat/feedback', { messageId: 'x' });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toMatch(/userQuery is required/);
  });

  it('returns 501 when the agent build does not support feedback', async () => {
    // agent without recordFeedback
    const noFb = {
      async chat() { return 'ok'; },
      getLastRetrievalMetadata() { return null; },
      getConfig() {
        return {
          agent: { name: 'X', defaultProvider: 'anthropic', model: 'claude-sonnet-4' },
          providers: {
            anthropic: { model: 'claude-sonnet-4', maxTokens: 4096 },
            openai: { model: 'gpt-4o', maxTokens: 4096 },
            ollama: { model: 'llama3', baseUrl: 'http://localhost:11434' },
          },
        };
      },
      getSessionStore() { return null; },
      getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
      getToolRegistry() { return { getDefinitions() { return []; } }; },
    };
    const router = createApiRouter(noFb as never);
    const r = await call(router, 'POST', '/api/chat/feedback', {});
    expect(r.status).toBe(501);
  });
});

describe('POST /api/chat/stream — SSE retrieval-before-tokens (R3/R7)', () => {
  it('emits retrieval event BEFORE any token, then done', async () => {
    const { agent } = fakeAgentWithFeedback({
      streamScript: async (cbs) => {
        cbs.onRetrieval?.({
          retrievalIntent: 'EXACT_SEARCH',
          retrievalSource: 'mixed',
          retrievalMatchCount: 2,
          retrievalDocuments: [{ document_id: 'd1', file_name: 'a.pdf' }],
        });
        cbs.onToken?.('Hel');
        cbs.onToken?.('lo');
        cbs.onComplete?.({ content: 'Hello' });
      },
    });
    const router = createApiRouter(agent as never);
    const r = await callStream(router, { message: 'hi', sessionId: 's-1' });
    expect(r.status).toBe(200);
    const types = r.events.map((e) => e['type']);
    expect(types[0]).toBe('retrieval');
    expect(types).toContain('token');
    // every token comes AFTER the retrieval event
    const firstToken = types.indexOf('token');
    expect(firstToken).toBeGreaterThan(types.indexOf('retrieval'));
    expect(types[types.length - 1]).toBe('done');
    // sessionId echoed on done
    const done = r.events.find((e) => e['type'] === 'done');
    expect(done?.['sessionId']).toBe('s-1');
  });

  it('emits no retrieval event when the agent does not call onRetrieval (flag off)', async () => {
    const { agent } = fakeAgentWithFeedback({
      streamScript: async (cbs) => {
        cbs.onToken?.('hi');
        cbs.onComplete?.({ content: 'hi' });
      },
    });
    const router = createApiRouter(agent as never);
    const r = await callStream(router, { message: 'hi' });
    const types = r.events.map((e) => e['type']);
    expect(types).not.toContain('retrieval');
    expect(types).toContain('token');
    expect(types[types.length - 1]).toBe('done');
  });

  it('emits a categorised error event when chatStream throws', async () => {
    const { agent } = fakeAgentWithFeedback({
      streamScript: async () => {
        throw new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set.');
      },
    });
    const router = createApiRouter(agent as never);
    const r = await callStream(router, { message: 'hi' });
    const err = r.events.find((e) => e['type'] === 'error');
    expect(err).toBeDefined();
    expect(err?.['code']).toBe('PROVIDER_AUTH_MISSING');
    // raw SDK string MUST NOT leak
    expect(r.raw).not.toContain('X-Api-Key');
    expect(r.raw).not.toContain('apiKey or authToken');
  });
});

describe('GET /api/providers — provider/model badge data', () => {
  it('still returns active provider + per-provider state', async () => {
    const { agent } = fakeAgentWithFeedback({});
    const router = createApiRouter(agent as never);
    const r = await call(router, 'GET', '/api/providers');
    expect(r.status).toBe(200);
    expect(r.body['active']).toBe('anthropic');
    expect(Array.isArray(r.body['providers'])).toBe(true);
    const providers = r.body['providers'] as Array<{ id: string; configured: boolean }>;
    expect(providers.map((p) => p.id).sort()).toEqual(['anthropic', 'ollama', 'openai']);
  });
});
