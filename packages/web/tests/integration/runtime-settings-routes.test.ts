/**
 * Runtime settings + retrieval-learning routes — Batch 2 verification.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import { RuntimeSettingsStore, RetrievalOutcomeStore } from '@agentx/core';

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

describe('Runtime settings — GET/POST/DELETE /api/settings/runtime', () => {
  let tmpDir: string;
  let store: RuntimeSettingsStore;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-rs-route-'));
    store = RuntimeSettingsStore.__createForTest(path.join(tmpDir, 'rs.json'));
  });
  afterEach(() => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ } });

  it('GET returns current settings', async () => {
    store.update({ localOnly: true, retrievalEnabled: false });
    const router = createApiRouter(baseAgent({ getRuntimeSettings: () => store }) as never);
    const r = await call(router, 'GET', '/api/settings/runtime');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(true);
    const s = r.body['settings'] as Record<string, unknown>;
    expect(s.localOnly).toBe(true);
    expect(s.retrievalEnabled).toBe(false);
  });

  it('GET returns available:false when getter missing', async () => {
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/settings/runtime');
    expect(r.body['available']).toBe(false);
  });

  it('POST persists changes and reports no restart needed for live toggles', async () => {
    const router = createApiRouter(baseAgent({ getRuntimeSettings: () => store }) as never);
    const r = await call(router, 'POST', '/api/settings/runtime', { localOnly: true, retrievalEnabled: false });
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(r.body['restartRequired']).toEqual([]);
    expect(store.getKey('localOnly')).toBe(true);
    expect(store.getKey('retrievalEnabled')).toBe(false);
  });

  it('POST flags restart-required keys honestly', async () => {
    const router = createApiRouter(baseAgent({ getRuntimeSettings: () => store }) as never);
    const r = await call(router, 'POST', '/api/settings/runtime', { builderV2Enabled: true });
    expect(r.body['restartRequired']).toEqual(['builderV2Enabled']);
    expect(r.body['note']).toBeTruthy();
  });

  it('DELETE resets to defaults', async () => {
    store.update({ localOnly: true });
    const router = createApiRouter(baseAgent({ getRuntimeSettings: () => store }) as never);
    const r = await call(router, 'DELETE', '/api/settings/runtime');
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(store.getKey('localOnly')).toBe(false);
  });
});

describe('Retrieval-learning route — GET/DELETE /api/learning/retrieval-outcomes', () => {
  it('returns rollups + topSources + recent', async () => {
    const store = RetrievalOutcomeStore.__createForTest();
    store.record({ query: 'q', success: true, matchCount: 3, sufficient: true, fallbackUsed: false, latencyMs: 10, sourceTypes: ['fts'], groundedAnswer: null });
    store.record({ query: 'q', success: false, matchCount: 0, sufficient: false, fallbackUsed: true, latencyMs: 5, sourceTypes: [], groundedAnswer: null, failureReason: 'empty' });

    const router = createApiRouter(baseAgent({ getRetrievalOutcomeStore: () => store }) as never);
    const r = await call(router, 'GET', '/api/learning/retrieval-outcomes');
    expect(r.body['available']).toBe(true);
    expect(r.body['size']).toBe(2);
    const rel = r.body['reliability'] as Record<string, unknown>;
    expect(rel.totalCalls).toBe(2);
    expect(rel.successCount).toBe(1);
    const top = r.body['topSources'] as Array<{ source: string; count: number }>;
    expect(top[0]).toEqual({ source: 'fts', count: 1 });
  });

  it('DELETE clears the store', async () => {
    const store = RetrievalOutcomeStore.__createForTest();
    store.record({ query: 'q', success: true, matchCount: 1, sufficient: true, fallbackUsed: false, latencyMs: 1, sourceTypes: ['fts'], groundedAnswer: null });
    const router = createApiRouter(baseAgent({ getRetrievalOutcomeStore: () => store }) as never);
    const r = await call(router, 'DELETE', '/api/learning/retrieval-outcomes');
    expect(r.body['ok']).toBe(true);
    expect(store.size()).toBe(0);
  });
});
