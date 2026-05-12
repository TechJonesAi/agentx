/**
 * Chat Multimodal — POST /api/chat/multimodal.
 *
 * Additive route that enriches the user prompt with attachment-derived
 * text (vision for images, extraction for documents) then delegates to
 * agent.chat(). R1–R12 retrieval is preserved because the existing chat
 * path is what runs server-side.
 *
 * Coverage:
 *   - rejects non-multipart body
 *   - rejects missing message AND missing files
 *   - returns response when message-only (no attachments, delegates to chat)
 *   - text document upload extracts content and chat sees enriched prompt
 *   - image attachment with unavailable vision provider → response still
 *     returned, attachment reported available=false with reason
 *   - image attachment with mocked successful vision → enriched prompt
 *     contains the description
 *   - response shape: { response, sessionId, multimodal, attachments[] }
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
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
    const boundary = '----mmb' + Math.random().toString(16).slice(2);
    const chunks: Buffer[] = [];
    for (const p of parts) {
      let h = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
      if (p.filename) h += `; filename="${p.filename}"`;
      h += '\r\n';
      if (p.contentType) h += `Content-Type: ${p.contentType}\r\n`;
      h += '\r\n';
      chunks.push(Buffer.from(h, 'utf-8'));
      chunks.push(p.data);
      chunks.push(Buffer.from('\r\n', 'utf-8'));
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

function callJson(
  router: ReturnType<typeof createApiRouter>, method: string, url: string, body?: unknown,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    Object.assign(req, { method, url, headers });
    process.nextTick(() => {
      if (body !== undefined) {
        (req as unknown as { emit(e: string, c?: Buffer): void }).emit('data', Buffer.from(JSON.stringify(body)));
      }
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
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

function fakeAgent(opts: { capturedPrompt?: { value: string } } = {}): unknown {
  return {
    async chat(input: string) {
      if (opts.capturedPrompt) opts.capturedPrompt.value = input;
      return `echo: ${input.slice(0, 200)}`;
    },
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
    return { description: 'A diagram showing the org chart with three boxes labelled CEO, CTO, CFO.' };
  }
}

describe('Chat Multimodal — POST /api/chat/multimodal', () => {
  afterEach(() => clearVisionProviderForTesting());

  it('rejects non-multipart body with 400', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await callJson(router, 'POST', '/api/chat/multimodal', { message: 'hi' });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toMatch(/multipart/i);
  });

  it('rejects missing message and missing files with 400', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'sessionId', data: Buffer.from('x') },
    ]);
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toMatch(/message or at least one file/i);
  });

  it('returns chat response when only a message is provided (no attachments)', async () => {
    const cap = { value: '' };
    const router = createApiRouter(fakeAgent({ capturedPrompt: cap }) as never);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('what is two plus two') },
    ]);
    expect(r.status).toBe(200);
    expect(r.body['multimodal']).toBe(false);
    expect(String(r.body['response'])).toMatch(/^echo: what is two plus two/);
    expect((r.body['attachments'] as unknown[])).toEqual([]);
    expect(cap.value).toBe('what is two plus two');
  });

  it('extracts text from a document upload and enriches prompt', async () => {
    const cap = { value: '' };
    const router = createApiRouter(fakeAgent({ capturedPrompt: cap }) as never);
    const docText = 'Quarterly revenue report: Q1 revenue 1.2M, Q2 1.5M, Q3 1.8M.';
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('summarise this report') },
      { name: 'files', filename: 'report.txt', contentType: 'text/plain',
        data: Buffer.from(docText, 'utf-8') },
    ]);
    expect(r.status).toBe(200);
    expect(r.body['multimodal']).toBe(true);
    const atts = r.body['attachments'] as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(1);
    expect(atts[0]['filename']).toBe('report.txt');
    expect(atts[0]['kind']).toBe('document');
    expect(atts[0]['available']).toBe(true);
    expect(Number(atts[0]['textLength'])).toBeGreaterThan(0);
    // The captured prompt should contain both the user message and the
    // extracted document text.
    expect(cap.value).toContain('summarise this report');
    expect(cap.value).toContain('Quarterly revenue report');
  });

  it('returns response even when vision provider is unavailable for an image', async () => {
    setVisionProviderForTesting(new MockUnavailableVision());
    const cap = { value: '' };
    const router = createApiRouter(fakeAgent({ capturedPrompt: cap }) as never);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('what is in this picture') },
      { name: 'files', filename: 'photo.png', contentType: 'image/png',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    expect(r.status).toBe(200);
    const atts = r.body['attachments'] as Array<Record<string, unknown>>;
    expect(atts[0]['kind']).toBe('image');
    expect(atts[0]['available']).toBe(false);
    expect(String(atts[0]['reason'])).toMatch(/vision model not available/i);
    // Chat still ran and the response references the image attachment.
    expect(cap.value).toContain('what is in this picture');
    expect(cap.value).toContain('image content unavailable');
  });

  it('enriches prompt with vision description when provider succeeds', async () => {
    setVisionProviderForTesting(new MockSuccessVision());
    const cap = { value: '' };
    const router = createApiRouter(fakeAgent({ capturedPrompt: cap }) as never);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('describe this image') },
      { name: 'files', filename: 'org.png', contentType: 'image/png',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    expect(r.status).toBe(200);
    expect(r.body['multimodal']).toBe(true);
    expect(cap.value).toContain('describe this image');
    expect(cap.value).toContain('CEO, CTO, CFO');
    const atts = r.body['attachments'] as Array<Record<string, unknown>>;
    expect(atts[0]['available']).toBe(true);
    expect(Number(atts[0]['textLength'])).toBeGreaterThan(0);
  });

  it('accepts multiple files and reports per-attachment status', async () => {
    setVisionProviderForTesting(new MockSuccessVision());
    const router = createApiRouter(fakeAgent() as never);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('analyse all these') },
      { name: 'files', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('alpha doc') },
      { name: 'files', filename: 'b.png', contentType: 'image/png',
        data: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);
    expect(r.status).toBe(200);
    const atts = r.body['attachments'] as Array<Record<string, unknown>>;
    expect(atts).toHaveLength(2);
    expect(atts.map((a) => a['kind'])).toEqual(['document', 'image']);
  });

  it('forwards sessionId to agent.chat', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('continue') },
      { name: 'sessionId', data: Buffer.from('test-session-xyz') },
    ]);
    expect(r.status).toBe(200);
    expect(r.body['sessionId']).toBe('test-session-xyz');
  });
});
