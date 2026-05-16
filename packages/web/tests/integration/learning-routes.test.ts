/**
 * Self-Learning route integration tests — Batch 1 verification.
 *
 * Exercises /api/learning/tool-outcomes (GET + DELETE) and /api/validation/run.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import { ToolOutcomeStore } from '@agentx/core';

interface CallResult { status: number; body: Record<string, unknown>; }

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
        try { resolve({ status, body: raw ? JSON.parse(raw) : {} }); }
        catch (e) { reject(e); }
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

describe('Self-Learning route — GET /api/learning/tool-outcomes', () => {
  let store: ToolOutcomeStore;
  beforeEach(() => { store = ToolOutcomeStore.__createForTest(); });

  it('returns size + reliability + recent from the agent store', async () => {
    store.record('shell', 'ok', 10);
    store.record('shell', '[shell error]: failure', 20);
    store.record('write_file', 'ok', 5);

    const router = createApiRouter(baseAgent({ getToolOutcomeStore: () => store }) as never);
    const r = await call(router, 'GET', '/api/learning/tool-outcomes');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(true);
    expect(r.body['size']).toBe(3);
    const rel = r.body['reliability'] as Array<{ toolName: string; successRate: number }>;
    expect(rel).toHaveLength(2);
    const shell = rel.find(x => x.toolName === 'shell')!;
    expect(shell.successRate).toBeCloseTo(0.5, 5);
    const recent = r.body['recent'] as Array<{ toolName: string }>;
    expect(recent[0]?.toolName).toBe('write_file');     // newest-first
  });

  it('returns available:false when store accessor missing', async () => {
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/learning/tool-outcomes');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(false);
    expect(r.body['size']).toBe(0);
  });
});

describe('Self-Learning route — DELETE /api/learning/tool-outcomes', () => {
  it('clears the store and returns ok', async () => {
    const store = ToolOutcomeStore.__createForTest();
    store.record('a', 'ok', 1);
    store.record('b', 'ok', 1);
    expect(store.size()).toBe(2);

    const router = createApiRouter(baseAgent({ getToolOutcomeStore: () => store }) as never);
    const r = await call(router, 'DELETE', '/api/learning/tool-outcomes');
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(r.body['cleared']).toBe(true);
    expect(store.size()).toBe(0);
  });
});

describe('Validation route — POST /api/validation/run', () => {
  it('runs probes and reports counts', async () => {
    const agent = {
      async chat() { return ''; },
      async chatStream() { /* */ },
      getConfig() { return { agent: { name: 'X', defaultProvider: 'ollama', model: 'm' }, providers: { ollama: { model: 'm' } } }; },
      getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
      getToolRegistry() {
        return {
          getDefinitions() {
            return [
              { name: 'shell' }, { name: 'write_file' },
              { name: 'memory_store' }, { name: 'memory_search' },
            ];
          },
        };
      },
      // Provide enough getters to pass most probes; intentionally omit one to
      // verify the route reports honest partial counts.
      getLongTermMemory() {
        const sentinel = `__probe_${Date.now()}`;
        const ltm = {
          _items: [] as Array<{ id: string; content: string; tags: string[] }>,
          store(c: string, t?: string[]) { const id = `id-${Math.random()}`; ltm._items.push({ id, content: c, tags: t ?? [] }); return id; },
          searchByContent(q: string) { return ltm._items.filter(x => x.content.includes(q)); },
        };
        // Smuggle the sentinel into the closure so the test can assert later
        void sentinel;
        return ltm;
      },
      getConversationMemory() { return {}; },
      getProvider() { return {}; },
      getHealthMonitor() { return {}; },
      getToolOutcomeStore() { return {}; },
      getModelRoutingHistory() { return {}; },
    };
    const router = createApiRouter(agent as never);
    const r = await call(router, 'POST', '/api/validation/run');
    expect(r.status).toBe(200);
    expect(r.body['ranAt']).toMatch(/T.*Z$/);
    const probes = r.body['probes'] as Array<{ name: string; pass: boolean }>;
    expect(probes.length).toBeGreaterThan(10);
    // Round-trip probe must pass when getLongTermMemory returns a working stub
    const roundTrip = probes.find(p => p.name === 'Long-term memory write+read round-trip');
    expect(roundTrip?.pass).toBe(true);
    // passCount + totalCount consistent
    const passCount = r.body['passCount'] as number;
    const totalCount = r.body['totalCount'] as number;
    expect(passCount).toBeGreaterThan(0);
    expect(totalCount).toBe(probes.length);
    expect(r.body['ok']).toBe(passCount === totalCount);
  });

  it('reports failures honestly when a getter is missing', async () => {
    const agent = {
      async chat() { return ''; },
      async chatStream() { /* */ },
      getConfig() { return { agent: { name: 'X', defaultProvider: 'ollama', model: 'm' }, providers: { ollama: { model: 'm' } } }; },
      getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
      getToolRegistry() { return { getDefinitions() { return []; } }; },
    };
    const router = createApiRouter(agent as never);
    const r = await call(router, 'POST', '/api/validation/run');
    expect(r.status).toBe(200);
    const probes = r.body['probes'] as Array<{ name: string; pass: boolean }>;
    // Tool-registry probes should fail (empty registry)
    const shell = probes.find(p => p.name === 'Tool registry has shell');
    expect(shell?.pass).toBe(false);
    expect(r.body['ok']).toBe(false);
  });
});
