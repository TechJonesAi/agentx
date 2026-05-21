/**
 * /api/decision-trace/last — Batch 4 observability route.
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';

interface CallResult { status: number; body: Record<string, unknown>; }

function call(router: ReturnType<typeof createApiRouter>, method: string, url: string): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method, url, headers: {} });
    process.nextTick(() => { (req as unknown as { emit(e: string): void }).emit('end'); });
    const chunks: Buffer[] = [];
    let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(code: number) { status = code; return this as http.ServerResponse; },
      setHeader() { return this as http.ServerResponse; },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status, body: raw ? JSON.parse(raw) : {} }); } catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

function baseAgent(overrides: Record<string, unknown> = {}): unknown {
  return {
    async chat() { return ''; },
    async chatStream() { /* */ },
    getConfig() { return { agent: { name: 'X', defaultProvider: 'ollama', model: 'm' }, providers: { ollama: { model: 'm' } } }; },
    getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
    getToolRegistry() { return { getDefinitions() { return []; } }; },
    ...overrides,
  };
}

describe('GET /api/decision-trace/last', () => {
  it('returns events from agent.getLastDecisionTrace()', async () => {
    const events = [
      { event: 'retrieval_started', query: 'q', ts: 1 },
      { event: 'tool_fallback_blocked', tool: 'web_search', reason: 'local_only', ts: 2 },
    ];
    const router = createApiRouter(baseAgent({ getLastDecisionTrace: () => events }) as never);
    const r = await call(router, 'GET', '/api/decision-trace/last');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(true);
    expect(r.body['count']).toBe(2);
    const out = r.body['events'] as Array<{ event: string }>;
    expect(out[0]?.event).toBe('retrieval_started');
    expect(out[1]?.event).toBe('tool_fallback_blocked');
  });

  it('returns empty list (not 500) when accessor missing', async () => {
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/decision-trace/last');
    expect(r.status).toBe(200);
    expect(r.body['count']).toBe(0);
    expect(r.body['events']).toEqual([]);
  });

  it('does not 500 when accessor throws', async () => {
    const router = createApiRouter(baseAgent({ getLastDecisionTrace: () => { throw new Error('boom'); } }) as never);
    const r = await call(router, 'GET', '/api/decision-trace/last');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(false);
    expect(String(r.body['error'])).toContain('boom');
  });
});
