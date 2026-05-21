/**
 * /api/telemetry/recent — Batch 5 verification.
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import { TelemetryStore } from '@agentx/core';

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

describe('GET /api/telemetry/recent', () => {
  it('returns recent + rollup from the agent store', async () => {
    const store = TelemetryStore.__createForTest();
    for (let i = 1; i <= 5; i++) {
      store.record({ kind: 'llm.stream', label: 'qwen', latencyMs: i * 10, outputTokens: 100, success: true });
    }
    const router = createApiRouter(baseAgent({ getTelemetryStore: () => store }) as never);
    const r = await call(router, 'GET', '/api/telemetry/recent?limit=10');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(true);
    expect(r.body['size']).toBe(5);
    const recent = r.body['recent'] as Array<{ kind: string }>;
    expect(recent).toHaveLength(5);
    expect(recent[0]?.kind).toBe('llm.stream');
    const rollup = r.body['rollup'] as Array<{ kind: string; totalCalls: number }>;
    expect(rollup[0]?.totalCalls).toBe(5);
  });

  it('filters by kind via query param', async () => {
    const store = TelemetryStore.__createForTest();
    store.record({ kind: 'llm.stream', label: 'a', latencyMs: 1 });
    store.record({ kind: 'ocr.extract', label: 'b', latencyMs: 1 });
    const router = createApiRouter(baseAgent({ getTelemetryStore: () => store }) as never);
    const r = await call(router, 'GET', '/api/telemetry/recent?kind=ocr.extract');
    const recent = r.body['recent'] as Array<{ kind: string }>;
    expect(recent).toHaveLength(1);
    expect(recent[0]?.kind).toBe('ocr.extract');
  });

  it('returns available:false when accessor missing', async () => {
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/telemetry/recent');
    expect(r.body['available']).toBe(false);
    expect(r.body['recent']).toEqual([]);
  });
});
