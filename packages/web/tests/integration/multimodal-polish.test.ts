/**
 * Multimodal UX polish — attachment preview + categorised errors + provider status.
 *
 * Covers:
 *   - attachment response includes `preview` (capped to 300 chars) and `textLength`
 *   - image with unavailable vision yields a `reason` with the install hint
 *   - chat execution failure returns categorised code + friendly message + 502
 *   - GET /api/agent/provider/status returns provider/model/ready/reason/hint
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import {
  setVisionProviderForTesting,
  clearVisionProviderForTesting,
  type VisionProvider,
} from '@agentx/core';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function callMultipart(
  router: ReturnType<typeof createApiRouter>, url: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const boundary = '----p' + Math.random().toString(16).slice(2);
    const chunks: Buffer[] = [];
    for (const p of parts) {
      let h = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
      if (p.filename) h += `; filename="${p.filename}"`;
      h += '\r\n';
      if (p.contentType) h += `Content-Type: ${p.contentType}\r\n`;
      h += '\r\n';
      chunks.push(Buffer.from(h, 'utf-8')); chunks.push(p.data); chunks.push(Buffer.from('\r\n', 'utf-8'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
    const body = Buffer.concat(chunks);
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method: 'POST', url,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    process.nextTick(() => {
      (req as unknown as { emit(e: string, c?: Buffer): void }).emit('data', body);
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const out: Buffer[] = []; let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(c: number) { status = c; return this as http.ServerResponse; },
      setHeader() { return this as http.ServerResponse; },
      write(c: string | Buffer) { out.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) out.push(Buffer.from(c));
        const raw = Buffer.concat(out).toString('utf-8');
        try { resolve({ status, body: raw ? JSON.parse(raw) : {}, raw }); }
        catch (e) { reject(e); }
      },
    };
    router.handle('POST', url, req, res as http.ServerResponse).catch(reject);
  });
}

function callGet(
  router: ReturnType<typeof createApiRouter>, url: string,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method: 'GET', url, headers: {} });
    process.nextTick(() => {
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = []; let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(c: number) { status = c; return this as http.ServerResponse; },
      setHeader() { return this as http.ServerResponse; },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status, body: raw ? JSON.parse(raw) : {}, raw }); }
        catch (e) { reject(e); }
      },
    };
    router.handle('GET', url, req, res as http.ServerResponse).catch(reject);
  });
}

function fakeAgent(opts: { throwAuth?: boolean; provider?: 'anthropic' | 'openai' | 'ollama' } = {}): unknown {
  return {
    async chat() {
      if (opts.throwAuth) {
        throw new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set.');
      }
      return 'ok';
    },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    getConfig() {
      return {
        agent: { name: 'X', defaultProvider: opts.provider ?? 'anthropic', model: 'claude-sonnet-4' },
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

class MockUnavailable implements VisionProvider {
  async isAvailable(): Promise<boolean> { return false; }
  async describe(): Promise<{ description: string }> { return { description: '[Vision not available]' }; }
}

describe('Multimodal UX polish', () => {
  afterEach(() => clearVisionProviderForTesting());

  it('returns preview + textLength in attachment summary', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const text = 'X'.repeat(500);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('summary') },
      { name: 'files', filename: 'big.txt', contentType: 'text/plain', data: Buffer.from(text) },
    ]);
    expect(r.status).toBe(200);
    const a = (r.body['attachments'] as Array<Record<string, unknown>>)[0];
    expect(typeof a['preview']).toBe('string');
    expect(String(a['preview']).length).toBeLessThanOrEqual(301);
    expect(String(a['preview'])).toMatch(/^X+…$/); // 300 X's + ellipsis
    expect(Number(a['textLength'])).toBe(500);
  });

  it('unavailable image carries install-hint reason', async () => {
    setVisionProviderForTesting(new MockUnavailable());
    const router = createApiRouter(fakeAgent() as never);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('describe') },
      { name: 'files', filename: 'p.png', contentType: 'image/png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    expect(r.status).toBe(200);
    const a = (r.body['attachments'] as Array<Record<string, unknown>>)[0];
    expect(a['available']).toBe(false);
    expect(String(a['reason'])).toMatch(/install qwen3-vl|ollama pull/i);
  });

  it('multimodal/status exposes nested vision/stt/tts objects the Chat sidebar reads', async () => {
    // Codex finding: the sidebar read j.stt.available / j.vision.available /
    // j.tts.available, but the endpoint only returned {available, modalities}
    // — so the STT badge showed 'unavailable' while /api/stt/health said
    // available:true. Assert the nested objects exist with boolean flags so
    // the badges can never contradict the dedicated health endpoints.
    const router = createApiRouter(fakeAgent() as never);
    const r = await callGet(router, '/api/multimodal/status');
    expect(r.status).toBe(200);
    expect(typeof (r.body['stt'] as { available?: unknown })?.available).toBe('boolean');
    expect(typeof (r.body['vision'] as { available?: unknown })?.available).toBe('boolean');
    expect(typeof (r.body['tts'] as { available?: unknown })?.available).toBe('boolean');
    expect((r.body['stt'] as { engine?: string })?.engine).toBe('mlx-whisper');
  });

  it('PROVIDER_AUTH_MISSING is categorised with user-friendly message + 502', async () => {
    const router = createApiRouter(fakeAgent({ throwAuth: true }) as never);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('hello') },
    ]);
    expect(r.status).toBe(502);
    expect(r.body['code']).toBe('PROVIDER_AUTH_MISSING');
    expect(String(r.body['error'])).toMatch(/Set ANTHROPIC_API_KEY|switch to local Ollama/i);
    // user-facing message contains no stack trace markers
    expect(String(r.body['error'])).not.toMatch(/^\s*at\s|^Error:|throw\s/m);
  });
});

describe('GET /api/agent/provider/status', () => {
  const savedKey = process.env['ANTHROPIC_API_KEY'];
  afterEach(() => {
    if (savedKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = savedKey;
  });

  it('reports ready=true when ANTHROPIC_API_KEY is set', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const router = createApiRouter(fakeAgent({ provider: 'anthropic' }) as never);
    const r = await callGet(router, '/api/agent/provider/status');
    expect(r.status).toBe(200);
    expect(r.body['provider']).toBe('anthropic');
    expect(r.body['ready']).toBe(true);
    expect(r.body['model']).toBeDefined();
  });

  it('reports ready=false + hint when API key missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const router = createApiRouter(fakeAgent({ provider: 'anthropic' }) as never);
    const r = await callGet(router, '/api/agent/provider/status');
    expect(r.status).toBe(200);
    expect(r.body['ready']).toBe(false);
    expect(String(r.body['reason'])).toMatch(/ANTHROPIC_API_KEY not set/);
    expect(String(r.body['hint'])).toMatch(/AGENT_DEFAULT_PROVIDER=ollama/);
  });
});
