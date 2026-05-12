/**
 * Tier 3 Vision Batch — POST /api/vision/analyze
 *
 * Tests use setVisionProviderForTesting() to inject a mock VisionProvider.
 * No live Ollama dependency. Covers:
 *   - rejects non-multipart body (400)
 *   - rejects missing image part (400)
 *   - returns {available:false} when provider reports unavailable
 *   - returns {available:true, description} when provider succeeds
 *   - returns {available:false} when provider returns a "[…]" placeholder
 *   - builder/run still returns the honest shim envelope (501)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import {
  setVisionProviderForTesting,
  clearVisionProviderForTesting,
  type VisionProvider,
} from '@agentx/core';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function callMultipart(
  router: ReturnType<typeof createApiRouter>,
  url: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const boundary = '----testboundary' + Math.random().toString(16).slice(2);
    const chunks: Buffer[] = [];
    for (const p of parts) {
      let header = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
      if (p.filename) header += `; filename="${p.filename}"`;
      header += '\r\n';
      if (p.contentType) header += `Content-Type: ${p.contentType}\r\n`;
      header += '\r\n';
      chunks.push(Buffer.from(header, 'utf-8'));
      chunks.push(p.data);
      chunks.push(Buffer.from('\r\n', 'utf-8'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
    const body = Buffer.concat(chunks);

    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, {
      method: 'POST',
      url,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    });
    process.nextTick(() => {
      (req as unknown as { emit(e: string, c?: Buffer): void }).emit('data', body);
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const out: Buffer[] = [];
    let status = 0;
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

function callPlain(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
  body?: Buffer,
  contentType?: string,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    const headers: Record<string, string> = {};
    if (contentType) headers['content-type'] = contentType;
    Object.assign(req, { method, url, headers });
    process.nextTick(() => {
      if (body) (req as unknown as { emit(e: string, c?: Buffer): void }).emit('data', body);
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = [];
    let status = 0;
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

class MockUnavailableVision implements VisionProvider {
  async isAvailable(): Promise<boolean> { return false; }
  async describe(): Promise<{ description: string }> { return { description: '[Vision not available]' }; }
}

class MockSuccessVision implements VisionProvider {
  async isAvailable(): Promise<boolean> { return true; }
  async describe(): Promise<{ description: string }> {
    return { description: 'A small red boat on a calm blue lake at sunrise.' };
  }
}

class MockPlaceholderVision implements VisionProvider {
  async isAvailable(): Promise<boolean> { return true; }
  async describe(): Promise<{ description: string }> { return { description: '[No description generated]' }; }
}

describe('Tier 3 Vision — POST /api/vision/analyze', () => {
  afterEach(() => clearVisionProviderForTesting());

  it('rejects non-multipart body with 400', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await callPlain(router, 'POST', '/api/vision/analyze',
      Buffer.from('{"foo":"bar"}'), 'application/json');
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toMatch(/multipart/i);
  });

  it('rejects missing image part with 400', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await callMultipart(router, '/api/vision/analyze', [
      { name: 'notes', data: Buffer.from('hello') }, // text field, no file
    ]);
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toMatch(/no image/i);
  });

  it('returns {available:false} when vision provider is unavailable', async () => {
    setVisionProviderForTesting(new MockUnavailableVision());
    const router = createApiRouter(fakeAgent() as never);
    const r = await callMultipart(router, '/api/vision/analyze', [
      { name: 'image', filename: 'test.png', contentType: 'image/png',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) },
    ]);
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(false);
    expect(String(r.body['reason'])).toMatch(/vision model not available/i);
    expect(r.body['model']).toBeDefined();
    expect(r.body['description']).toBeUndefined();
  });

  it('returns {available:true, description} when provider succeeds', async () => {
    setVisionProviderForTesting(new MockSuccessVision());
    const router = createApiRouter(fakeAgent() as never);
    const r = await callMultipart(router, '/api/vision/analyze', [
      { name: 'image', filename: 'boat.png', contentType: 'image/png',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(true);
    expect(r.body['description']).toMatch(/red boat/i);
    expect(r.body['filename']).toBe('boat.png');
    expect(r.body['size']).toBe(4);
    expect(typeof r.body['latencyMs']).toBe('number');
  });

  it('treats "[…]" placeholder as unavailable', async () => {
    setVisionProviderForTesting(new MockPlaceholderVision());
    const router = createApiRouter(fakeAgent() as never);
    const r = await callMultipart(router, '/api/vision/analyze', [
      { name: 'image', filename: 'x.png', contentType: 'image/png',
        data: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(false);
    expect(String(r.body['reason'])).toMatch(/no description/i);
  });

  it('accepts file under "upload" field name too', async () => {
    setVisionProviderForTesting(new MockSuccessVision());
    const router = createApiRouter(fakeAgent() as never);
    const r = await callMultipart(router, '/api/vision/analyze', [
      { name: 'upload', filename: 'cat.jpg', contentType: 'image/jpeg',
        data: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
    ]);
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(true);
  });
});

describe('Tier 3 Builder/run — permanent shim swapped to supervisor/restart', () => {
  // /api/builder/run became a real BuilderV2-backed route. The
  // permanent-shim contract is now asserted against /api/supervisor/restart
  // (silly never had a real backend for it either).
  it('still returns the honest unavailable envelope (supervisor/restart)', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await callPlain(router, 'POST', '/api/supervisor/restart');
    expect(r.status).toBe(501);
    expect(r.body['available']).toBe(false);
    expect(r.body['reason']).toBe('not implemented on this build');
    expect(r.body['endpoint']).toBe('/api/supervisor/restart');
  });
});
