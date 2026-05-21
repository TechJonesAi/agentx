/**
 * /api/services/degraded — Batch 4 operator-trust route.
 *
 * Confirms the route assembles its list from HealthMonitor + known feature
 * flags and returns the required per-service truth fields.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import { HealthMonitor } from '@agentx/core';

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

describe('GET /api/services/degraded', () => {
  let prevFlag: string | undefined;
  beforeEach(() => { prevFlag = process.env['AGENTX_ENABLE_AGENT_LOOPS']; delete process.env['AGENTX_ENABLE_AGENT_LOOPS']; });
  afterEach(() => { if (prevFlag === undefined) delete process.env['AGENTX_ENABLE_AGENT_LOOPS']; else process.env['AGENTX_ENABLE_AGENT_LOOPS'] = prevFlag; });

  it('returns 200 + a list with required fields', async () => {
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/services/degraded');
    expect(r.status).toBe(200);
    const services = r.body['services'] as Array<Record<string, string>>;
    expect(Array.isArray(services)).toBe(true);
    for (const s of services) {
      expect(typeof s.name).toBe('string');
      expect(['unavailable', 'degraded', 'ok']).toContain(s.state as string);
      expect(typeof s.why).toBe('string');
      expect(typeof s.impact).toBe('string');
      expect(typeof s.nextAction).toBe('string');
      expect(typeof s.recoveryPath).toBe('string');
    }
  });

  it('reports Agent Loops as unavailable when env flag is not set', async () => {
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/services/degraded');
    const services = r.body['services'] as Array<{ name: string; state: string }>;
    const loops = services.find((s) => s.name === 'Agent Loops');
    expect(loops?.state).toBe('unavailable');
  });

  it('includes failed HealthMonitor subsystems', async () => {
    const mon = HealthMonitor.__createForTest();
    mon.registerProbe({ name: 'Synthetic-Broken', run: async () => ({ status: 'failed', detail: 'simulated outage' }) });
    await mon.runAll();
    const router = createApiRouter(baseAgent({ getHealthMonitor: () => mon }) as never);
    const r = await call(router, 'GET', '/api/services/degraded');
    const services = r.body['services'] as Array<{ name: string; state: string; why: string }>;
    const broken = services.find((s) => s.name === 'Synthetic-Broken');
    expect(broken?.state).toBe('unavailable');
    expect(broken?.why).toContain('simulated outage');
  });
});
