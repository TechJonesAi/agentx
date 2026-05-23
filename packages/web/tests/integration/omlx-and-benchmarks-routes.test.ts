/**
 * /api/providers/omlx/status + /api/providers/benchmarks(*) + /comparison
 * Batch 9 verification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import Database from 'better-sqlite3';
import { createApiRouter } from '../../src/server/routes/api.js';
import { ProviderBenchmarkStore } from '@agentx/core';

const SLOW_IO = 60_000;

interface CallResult { status: number; body: Record<string, unknown>; }

function call(router: ReturnType<typeof createApiRouter>, method: string, url: string, body?: unknown): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : '';
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method, url, headers: data ? { 'content-type': 'application/json' } : {} });
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
        try { resolve({ status, body: raw ? JSON.parse(raw) : {} }); } catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

function baseAgent(store?: ProviderBenchmarkStore): unknown {
  return {
    async chat() { return ''; },
    async chatStream() { /* */ },
    getConfig() { return { agent: { name: 'X', defaultProvider: 'ollama', model: 'm' }, providers: { ollama: { model: 'm' } } }; },
    getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
    getToolRegistry() { return { getDefinitions() { return []; } }; },
    ...(store ? { getProviderBenchmarkStore: () => store } : {}),
  };
}

describe('GET /api/providers/omlx/status', () => {
  let prevEnv: string | undefined;
  beforeEach(() => { prevEnv = process.env['AGENTX_OMLX_ENDPOINT']; delete process.env['AGENTX_OMLX_ENDPOINT']; });
  afterEach(() => { if (prevEnv === undefined) delete process.env['AGENTX_OMLX_ENDPOINT']; else process.env['AGENTX_OMLX_ENDPOINT'] = prevEnv; });

  it('no env → degraded with recovery hint, Ollama remains default', async () => {
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/providers/omlx/status');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(false);
    expect(r.body['endpoint']).toBeNull();
    expect(String(r.body['reason'])).toContain('opt-in');
    expect(String(r.body['recovery'])).toContain('AGENTX_OMLX_ENDPOINT');
  });

  it('non-localhost endpoint → BLOCKED (privacy guarantee)', async () => {
    process.env['AGENTX_OMLX_ENDPOINT'] = 'http://example.com:8080';
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/providers/omlx/status');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(false);
    expect(r.body['blocked']).toBe(true);
    expect(String(r.body['reason'])).toContain('non-local host');
  });

  it('localhost endpoint unreachable → honest reason (no cloud fallback)', async () => {
    // Pick a port nothing should be listening on
    process.env['AGENTX_OMLX_ENDPOINT'] = 'http://127.0.0.1:1';
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/providers/omlx/status');
    expect(r.body['available']).toBe(false);
    expect(String(r.body['reason'])).toContain('unreachable');
  }, SLOW_IO);
});

describe('GET/POST /api/providers/benchmarks', () => {
  let tmpDir: string;
  let db: Database.Database;
  let store: ProviderBenchmarkStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-bench-route-'));
    db = new Database(path.join(tmpDir, 'b.db'));
    const sql = fs.readFileSync(path.join(__dirname, '../../../core/src/db/migrations/009_provider_benchmarks.sql'), 'utf-8');
    db.exec(sql);
    store = ProviderBenchmarkStore.__createForTest(db);
  }, SLOW_IO);

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  }, SLOW_IO);

  it('GET returns empty when no benchmarks recorded', async () => {
    const router = createApiRouter(baseAgent(store) as never);
    const r = await call(router, 'GET', '/api/providers/benchmarks');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(true);
    expect(r.body['size']).toBe(0);
    expect(r.body['benchmarks']).toEqual([]);
    expect(r.body['taskCategories']).toEqual([]);
  }, SLOW_IO);

  it('POST records a benchmark and GET returns it', async () => {
    const router = createApiRouter(baseAgent(store) as never);
    const post = await call(router, 'POST', '/api/providers/benchmarks', {
      taskCategory: 'coding', provider: 'ollama', model: 'qwen', score: 0.85, totalLatencyMs: 200,
    });
    expect(post.status).toBe(200);
    expect(post.body['ok']).toBe(true);
    const get = await call(router, 'GET', '/api/providers/benchmarks');
    const list = get.body['benchmarks'] as Array<{ provider: string }>;
    expect(list).toHaveLength(1);
    expect(list[0]?.provider).toBe('ollama');
  }, SLOW_IO);

  it('POST rejects payloads missing required fields', async () => {
    const router = createApiRouter(baseAgent(store) as never);
    const r = await call(router, 'POST', '/api/providers/benchmarks', { taskCategory: 'coding' });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toContain('required');
  }, SLOW_IO);
});

describe('GET /api/providers/comparison/:taskCategory', () => {
  let tmpDir: string;
  let db: Database.Database;
  let store: ProviderBenchmarkStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-cmp-'));
    db = new Database(path.join(tmpDir, 'b.db'));
    const sql = fs.readFileSync(path.join(__dirname, '../../../core/src/db/migrations/009_provider_benchmarks.sql'), 'utf-8');
    db.exec(sql);
    store = ProviderBenchmarkStore.__createForTest(db);
  }, SLOW_IO);

  afterEach(() => {
    try { db.close(); } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  }, SLOW_IO);

  it('returns winner with reasons after enough samples', async () => {
    for (const s of [0.3, 0.4, 0.5]) store.record({ taskCategory: 'tool-calling', provider: 'ollama', model: 'a', score: s });
    for (const s of [0.8, 0.85, 0.9]) store.record({ taskCategory: 'tool-calling', provider: 'omlx', model: 'b', score: s });

    const router = createApiRouter(baseAgent(store) as never);
    const r = await call(router, 'GET', '/api/providers/comparison/tool-calling?minSamples=3');
    expect(r.status).toBe(200);
    const c = r.body['comparison'] as { winner: string; reasons: string[]; perProvider: unknown[] };
    expect(c.winner).toBe('omlx');
    expect(c.reasons.some(s => s.includes('omlx highest avg score'))).toBe(true);
    expect(c.perProvider).toHaveLength(2);
  }, SLOW_IO);

  it('returns no-winner when below minSamples', async () => {
    store.record({ taskCategory: 'reasoning', provider: 'ollama', model: 'a', score: 0.5 });
    const router = createApiRouter(baseAgent(store) as never);
    const r = await call(router, 'GET', '/api/providers/comparison/reasoning?minSamples=3');
    const c = r.body['comparison'] as { winner: string | null; reasons: string[] };
    expect(c.winner).toBeNull();
    expect(c.reasons[0]).toContain('no provider has');
  }, SLOW_IO);
});
