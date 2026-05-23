/**
 * /api/tts/status — Batch 8A operator-trust surface.
 * Honest report across every code path:
 *   - no backend env var → unavailable with recovery hint
 *   - unknown backend value → unavailable with corrective hint
 *   - configured but binary not on PATH → unavailable with binary detail
 * Never falls back to hosted TTS silently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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

describe('GET /api/tts/status', () => {
  let prevBackend: string | undefined;
  let prevPiperBin: string | undefined;
  let prevKokoroBin: string | undefined;

  beforeEach(() => {
    prevBackend = process.env['AGENTX_TTS_LOCAL_BACKEND'];
    prevPiperBin = process.env['AGENTX_TTS_PIPER_BIN'];
    prevKokoroBin = process.env['AGENTX_TTS_KOKORO_BIN'];
    delete process.env['AGENTX_TTS_LOCAL_BACKEND'];
    delete process.env['AGENTX_TTS_PIPER_BIN'];
    delete process.env['AGENTX_TTS_KOKORO_BIN'];
  });

  afterEach(() => {
    if (prevBackend === undefined) delete process.env['AGENTX_TTS_LOCAL_BACKEND']; else process.env['AGENTX_TTS_LOCAL_BACKEND'] = prevBackend;
    if (prevPiperBin === undefined) delete process.env['AGENTX_TTS_PIPER_BIN']; else process.env['AGENTX_TTS_PIPER_BIN'] = prevPiperBin;
    if (prevKokoroBin === undefined) delete process.env['AGENTX_TTS_KOKORO_BIN']; else process.env['AGENTX_TTS_KOKORO_BIN'] = prevKokoroBin;
  });

  it('no backend env → unavailable with recovery instructions', async () => {
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/tts/status');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(false);
    expect(r.body['backend']).toBeNull();
    expect(r.body['reason']).toContain('No local TTS backend');
    expect(String(r.body['recovery'])).toContain('AGENTX_TTS_LOCAL_BACKEND');
  });

  it('reports localOnly state in the no-backend branch', async () => {
    const router = createApiRouter(baseAgent({
      getRuntimeSettings: () => ({ getKey: (k: string) => (k === 'localOnly' ? true : undefined) }),
    }) as never);
    const r = await call(router, 'GET', '/api/tts/status');
    expect(r.body['localOnly']).toBe(true);
    expect(String(r.body['note'])).toContain('localOnly is ON');
  });

  it('rejects unrecognised backend values honestly', async () => {
    process.env['AGENTX_TTS_LOCAL_BACKEND'] = 'mary-tts';
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/tts/status');
    expect(r.body['available']).toBe(false);
    expect(r.body['backend']).toBe('mary-tts');
    expect(String(r.body['reason'])).toContain('not a recognized');
  });

  it('reports binary-missing honestly when piper is configured but absent', async () => {
    process.env['AGENTX_TTS_LOCAL_BACKEND'] = 'piper';
    process.env['AGENTX_TTS_PIPER_BIN'] = '/nonexistent/piper-binary-xyz';
    const router = createApiRouter(baseAgent() as never);
    const r = await call(router, 'GET', '/api/tts/status');
    expect(r.body['available']).toBe(false);
    expect(r.body['backend']).toBe('piper');
    expect(String(r.body['reason'])).toContain('not reachable');
    expect(String(r.body['recovery'])).toContain('AGENTX_TTS_PIPER_BIN');
  });
});
