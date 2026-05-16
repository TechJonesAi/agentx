/**
 * Health + Self-Healing route integration tests — Batch 1 verification.
 *
 * Exercises /api/health/status and /api/health/run through the real router
 * with a synthetic agent that exposes a HealthMonitor instance. Confirms:
 *   - GET /api/health/status returns probes + journal snapshot
 *   - POST /api/health/run executes a fresh probe cycle
 *   - missing getHealthMonitor() returns honest available:false
 *   - errors don't 500 the route
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import { HealthMonitor } from '@agentx/core';

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

describe('Self-Healing routes — GET /api/health/status', () => {
  it('returns snapshot from the agent HealthMonitor', async () => {
    const mon = HealthMonitor.__createForTest();
    mon.registerProbe({ name: 'A', run: async () => ({ status: 'ok' }) });
    mon.registerProbe({ name: 'B', run: async () => ({ status: 'failed', detail: 'down' }) });
    await mon.runAll();

    const router = createApiRouter(baseAgent({ getHealthMonitor: () => mon }) as never);
    const r = await call(router, 'GET', '/api/health/status');
    expect(r.status).toBe(200);
    expect(r.body['overall']).toBe('failed');
    const subs = r.body['subsystems'] as Array<{ name: string; lastStatus: string }>;
    expect(subs.map(s => s.name).sort()).toEqual(['A', 'B']);
    expect(Array.isArray(r.body['recentChecks'])).toBe(true);
    expect(Array.isArray(r.body['recentRepairs'])).toBe(true);
  });

  it('returns honest available:false when getHealthMonitor missing', async () => {
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/health/status');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(false);
  });
});

describe('Self-Healing routes — POST /api/health/run', () => {
  it('forces an immediate probe cycle and returns checks', async () => {
    const mon = HealthMonitor.__createForTest();
    let runs = 0;
    mon.registerProbe({ name: 'A', run: async () => { runs++; return { status: 'ok' }; } });
    const router = createApiRouter(baseAgent({ getHealthMonitor: () => mon }) as never);
    const r = await call(router, 'POST', '/api/health/run');
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(runs).toBe(1);
    const checks = r.body['checks'] as Array<{ subsystem: string; status: string }>;
    expect(checks).toHaveLength(1);
    expect(checks[0]?.status).toBe('ok');
  });

  it('does not 500 when probe throws — outcome captured as failed', async () => {
    const mon = HealthMonitor.__createForTest();
    mon.registerProbe({ name: 'A', run: async () => { throw new Error('boom'); } });
    const router = createApiRouter(baseAgent({ getHealthMonitor: () => mon }) as never);
    const r = await call(router, 'POST', '/api/health/run');
    expect(r.status).toBe(200);
    const checks = r.body['checks'] as Array<{ status: string; detail?: string }>;
    expect(checks[0]?.status).toBe('failed');
    expect(checks[0]?.detail).toContain('boom');
  });
});
