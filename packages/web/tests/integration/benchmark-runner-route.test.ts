/**
 * POST /api/models/benchmark-local-providers — Batch 10.
 *
 * Stands up TWO real localhost HTTP servers (one mimicking Ollama's
 * /api/chat, one mimicking oMLX's /v1/chat/completions) and runs the
 * benchmark route end-to-end. Confirms:
 *   - both providers receive prompts for each requested category
 *   - scores are recorded into the ProviderBenchmarkStore
 *   - omlx unreachable / not configured → ollama-only sample (no fake)
 *   - non-localhost AGENTX_OMLX_ENDPOINT is blocked
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
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

interface MockProvider { server: http.Server; baseUrl: string; calls: Array<{ method: string; url: string; body: Record<string, unknown> }>; close(): Promise<void>; }

function startMockOllama(jsonReply: Record<string, unknown>): Promise<MockProvider> {
  return new Promise((resolve) => {
    const calls: MockProvider['calls'] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        calls.push({ method: req.method!, url: req.url!, body: parsed });
        if (req.url === '/api/chat') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ message: { content: JSON.stringify(jsonReply) }, done: true }));
          return;
        }
        res.writeHead(404); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function startMockOmlx(reply: string): Promise<MockProvider> {
  return new Promise((resolve) => {
    const calls: MockProvider['calls'] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        calls.push({ method: req.method!, url: req.url!, body: parsed });
        if (req.url === '/v1/chat/completions') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            choices: [{ message: { content: reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 3 },
          }));
          return;
        }
        res.writeHead(404); res.end();
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        calls,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

let tmpDir: string;
let db: Database.Database;
let store: ProviderBenchmarkStore;
let prevOllamaHost: string | undefined;
let prevOmlxEndpoint: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-bench-run-'));
  db = new Database(path.join(tmpDir, 'b.db'));
  const sql = fs.readFileSync(path.join(__dirname, '../../../core/src/db/migrations/009_provider_benchmarks.sql'), 'utf-8');
  db.exec(sql);
  store = ProviderBenchmarkStore.__createForTest(db);
  prevOllamaHost = process.env['OLLAMA_HOST'];
  prevOmlxEndpoint = process.env['AGENTX_OMLX_ENDPOINT'];
}, SLOW_IO);

afterEach(() => {
  if (prevOllamaHost === undefined) delete process.env['OLLAMA_HOST']; else process.env['OLLAMA_HOST'] = prevOllamaHost;
  if (prevOmlxEndpoint === undefined) delete process.env['AGENTX_OMLX_ENDPOINT']; else process.env['AGENTX_OMLX_ENDPOINT'] = prevOmlxEndpoint;
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
}, SLOW_IO);

function baseAgent(s: ProviderBenchmarkStore): unknown {
  return {
    async chat() { return ''; },
    async chatStream() { /* */ },
    getConfig() { return { agent: { name: 'X', defaultProvider: 'ollama', model: 'm' }, providers: { ollama: { model: 'm' } } }; },
    getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
    getToolRegistry() { return { getDefinitions() { return []; } }; },
    getProviderBenchmarkStore: () => s,
  };
}

describe('POST /api/models/benchmark-local-providers', () => {
  it('runs both providers and records samples for each category', async () => {
    const mockOllama = await startMockOllama({ ok: true, n: 42 });
    const mockOmlx = await startMockOmlx('{"ok":true,"n":42}');
    process.env['OLLAMA_HOST'] = mockOllama.baseUrl;
    process.env['AGENTX_OMLX_ENDPOINT'] = mockOmlx.baseUrl;

    try {
      const router = createApiRouter(baseAgent(store) as never);
      const r = await call(router, 'POST', '/api/models/benchmark-local-providers', {
        categories: ['json-formatting'],
        maxSamplesPerProvider: 1,
      });
      expect(r.status).toBe(200);
      expect(r.body['ok']).toBe(true);
      const results = r.body['results'] as Array<{ taskCategory: string; samples: Array<{ provider: string; score: number }> }>;
      expect(results).toHaveLength(1);
      const sample = results[0]!;
      expect(sample.taskCategory).toBe('json-formatting');
      const providers = sample.samples.map((s) => s.provider).sort();
      expect(providers).toEqual(['ollama', 'omlx']);
      // Both should score ~1 (json {"ok":true,"n":42} matches the scoreFn)
      for (const s of sample.samples) expect(s.score).toBeGreaterThanOrEqual(0.9);

      // Both servers were actually called
      expect(mockOllama.calls.length).toBeGreaterThan(0);
      expect(mockOmlx.calls.length).toBeGreaterThan(0);

      // ProviderBenchmarkStore recorded them
      expect(store.size()).toBe(2);
      const comparison = store.compare('json-formatting', { minSamples: 1 });
      expect(comparison.winner).not.toBeNull();
    } finally {
      await mockOllama.close();
      await mockOmlx.close();
    }
  }, SLOW_IO);

  it('omitting AGENTX_OMLX_ENDPOINT runs ollama-only (no fake oMLX sample)', async () => {
    const mockOllama = await startMockOllama({ ok: true, n: 42 });
    process.env['OLLAMA_HOST'] = mockOllama.baseUrl;
    delete process.env['AGENTX_OMLX_ENDPOINT'];

    try {
      const router = createApiRouter(baseAgent(store) as never);
      const r = await call(router, 'POST', '/api/models/benchmark-local-providers', {
        categories: ['json-formatting'], maxSamplesPerProvider: 1,
      });
      expect(r.status).toBe(200);
      const results = r.body['results'] as Array<{ samples: Array<{ provider: string }> }>;
      const providers = results[0]!.samples.map((s) => s.provider);
      expect(providers).toEqual(['ollama']);   // ONLY ollama recorded
      expect(store.size()).toBe(1);
    } finally {
      await mockOllama.close();
    }
  }, SLOW_IO);

  it('non-localhost AGENTX_OMLX_ENDPOINT is blocked (records failure note)', async () => {
    const mockOllama = await startMockOllama({ ok: true, n: 42 });
    process.env['OLLAMA_HOST'] = mockOllama.baseUrl;
    process.env['AGENTX_OMLX_ENDPOINT'] = 'http://example.com:8088';

    try {
      const router = createApiRouter(baseAgent(store) as never);
      const r = await call(router, 'POST', '/api/models/benchmark-local-providers', {
        categories: ['json-formatting'], maxSamplesPerProvider: 1,
      });
      const results = r.body['results'] as Array<{ samples: Array<{ provider: string; failure?: string }> }>;
      const omlxSample = results[0]!.samples.find((s) => s.provider === 'omlx');
      expect(omlxSample).toBeDefined();
      expect(omlxSample?.failure).toContain('blocked');
    } finally {
      await mockOllama.close();
    }
  }, SLOW_IO);

  it('rejects unknown category names with 400', async () => {
    const router = createApiRouter(baseAgent(store) as never);
    const r = await call(router, 'POST', '/api/models/benchmark-local-providers', {
      categories: ['no-such-category'],
    });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toContain('No valid categories');
  }, SLOW_IO);
});
