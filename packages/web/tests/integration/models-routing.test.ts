/**
 * Tier 3 Models/Routing Batch — GET/POST /api/models/routing
 *
 * Strategy 3: route reads/writes `~/.agentx/routing.json` directly via the
 * Strategy-3 helpers in core. Tests set DATA_DIR to a tmpdir so they don't
 * touch the real user config. The Ollama probe is exercised against a
 * deliberately-unreachable host so we get `{reachable: false, models: []}`
 * without depending on a live Ollama install.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApiRouter } from '../../src/server/routes/api.js';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function call(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
  jsonBody?: unknown,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    const headers: Record<string, string> = {};
    if (jsonBody !== undefined) headers['content-type'] = 'application/json';
    Object.assign(req, { method, url, headers });
    process.nextTick(() => {
      if (jsonBody !== undefined) {
        (req as unknown as { emit(e: string, c?: Buffer): void }).emit(
          'data',
          Buffer.from(JSON.stringify(jsonBody)),
        );
      }
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

function fakeAgent(): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
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
}

describe('Tier 3 Models/Routing — GET/POST /api/models/routing', () => {
  let tmpDir: string;
  let origDataDir: string | undefined;
  let origOllamaHost: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-routing-'));
    origDataDir = process.env['DATA_DIR'];
    origOllamaHost = process.env['OLLAMA_HOST'];
    process.env['DATA_DIR'] = tmpDir;
    // Point Ollama probe at a deliberately-closed port. Probe returns
    // {reachable:false, models:[]} so the route doesn't depend on a live
    // Ollama install. (Port 1 is in the reserved range — connection refused.)
    process.env['OLLAMA_HOST'] = 'http://127.0.0.1:1';
  });

  afterEach(() => {
    if (origDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = origDataDir;
    if (origOllamaHost === undefined) delete process.env['OLLAMA_HOST'];
    else process.env['OLLAMA_HOST'] = origOllamaHost;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  describe('GET /api/models/routing', () => {
    it('returns default policy when routing.json is absent', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'GET', '/api/models/routing');
      expect(r.status).toBe(200);
      expect(r.body['policy']).toMatchObject({ mode: 'LOCAL_ONLY' });
      expect(Array.isArray(r.body['availableModels'])).toBe(true);
      expect(r.body['availableModels']).toEqual([]);
      const ollama = r.body['ollama'] as Record<string, unknown>;
      expect(ollama['reachable']).toBe(false);
      expect(typeof ollama['host']).toBe('string');
      // Not a shim envelope
      expect(r.body['available']).toBeUndefined();
    });

    it('reflects persisted routing.json contents', async () => {
      fs.writeFileSync(
        path.join(tmpDir, 'routing.json'),
        JSON.stringify({
          mode: 'COMBINATION',
          capabilityPins: { code: 'qwen3-coder:30b' },
          forceModel: null,
          contextOverflowTokens: 24000,
        }),
        'utf-8',
      );
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'GET', '/api/models/routing');
      expect(r.status).toBe(200);
      const policy = r.body['policy'] as Record<string, unknown>;
      expect(policy['mode']).toBe('COMBINATION');
      expect(policy['contextOverflowTokens']).toBe(24000);
      expect(policy['capabilityPins']).toEqual({ code: 'qwen3-coder:30b' });
    });
  });

  describe('POST /api/models/routing', () => {
    it('persists a valid routing config and round-trips via GET', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'POST', '/api/models/routing', {
        mode: 'COMBINATION',
        capabilityPins: { code: 'qwen3-coder:30b', reasoning: 'llama3.1:70b-32k' },
        contextOverflowTokens: 20000,
        maxLocalFailuresBeforeCloud: 5,
      });
      expect(r.status).toBe(200);
      expect(r.body['ok']).toBe(true);
      const policy = r.body['policy'] as Record<string, unknown>;
      expect(policy['mode']).toBe('COMBINATION');
      expect(policy['contextOverflowTokens']).toBe(20000);

      // File is on disk
      const onDisk = JSON.parse(fs.readFileSync(path.join(tmpDir, 'routing.json'), 'utf-8'));
      expect(onDisk.mode).toBe('COMBINATION');
      expect(onDisk.maxLocalFailuresBeforeCloud).toBe(5);

      // GET reflects it
      const g = await call(router, 'GET', '/api/models/routing');
      expect(g.status).toBe(200);
      const gpolicy = g.body['policy'] as Record<string, unknown>;
      expect(gpolicy['mode']).toBe('COMBINATION');
      expect(gpolicy['capabilityPins']).toMatchObject({ code: 'qwen3-coder:30b' });
    });

    it('rejects invalid mode with 400 and a details array', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'POST', '/api/models/routing', { mode: 'BOGUS' });
      expect(r.status).toBe(400);
      expect(r.body['error']).toBe('invalid routing config');
      expect(Array.isArray(r.body['details'])).toBe(true);
      expect((r.body['details'] as string[]).join(' ')).toMatch(/mode must be one of/);
      // No file should be written
      expect(fs.existsSync(path.join(tmpDir, 'routing.json'))).toBe(false);
    });

    it('rejects non-JSON content-type with 400', async () => {
      const router = createApiRouter(fakeAgent() as never);
      // Build a request without the application/json content-type header
      const r = await new Promise<CallResult>((resolve, reject) => {
        const req = new http.IncomingMessage(null as unknown as never);
        Object.assign(req, { method: 'POST', url: '/api/models/routing', headers: {} });
        process.nextTick(() => {
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
        router.handle('POST', '/api/models/routing', req, res as http.ServerResponse).catch(reject);
      });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toMatch(/content-type/i);
    });

    it('clamps out-of-range numeric fields rather than rejecting', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'POST', '/api/models/routing', {
        mode: 'LOCAL_ONLY',
        contextOverflowTokens: 99_999_999, // way above max
      });
      expect(r.status).toBe(200);
      const policy = r.body['policy'] as Record<string, unknown>;
      // Validator clamps to max=1_000_000
      expect(policy['contextOverflowTokens']).toBe(1_000_000);
    });
  });

  describe('Regression', () => {
    it('GET no longer returns the 501 shim envelope', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'GET', '/api/models/routing');
      expect(r.status).toBe(200);
      expect(r.body['reason']).not.toBe('not implemented on this build');
      expect(r.body['available']).toBeUndefined();
    });
  });
});
