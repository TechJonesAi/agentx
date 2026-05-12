/**
 * /api/chat/multimodal?stream=true — SSE streaming branch.
 *
 * Covers:
 *   - default (no stream) preserves JSON shape (regression)
 *   - stream=true sets text/event-stream headers
 *   - emits attachment_processed per file
 *   - emits chat_started before tokens
 *   - emits retrieval when agent.chatStream fires onRetrieval
 *   - emits token + done from agent.chatStream
 *   - emits error from onError with categorised code
 *   - non-multipart still 400
 *   - missing message+files still 400
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import {
  setVisionProviderForTesting,
  clearVisionProviderForTesting,
  type VisionProvider,
} from '@agentx/core';

interface CallResult { status: number; headers: Record<string, string>; body: string; }

function callMultipart(
  router: ReturnType<typeof createApiRouter>, url: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const boundary = '----mm' + Math.random().toString(16).slice(2);
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
    const out: Buffer[] = []; let status = 0; const headers: Record<string, string> = {};
    const res: Partial<http.ServerResponse> = {
      writeHead(c: number, h?: Record<string, string>) {
        status = c;
        if (h) {
          for (const [k, v] of Object.entries(h)) headers[k.toLowerCase()] = v;
        }
        return this as http.ServerResponse;
      },
      setHeader(k: string, v: string) {
        headers[k.toLowerCase()] = v;
        return this as http.ServerResponse;
      },
      write(c: string | Buffer) { out.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) out.push(Buffer.from(c));
        resolve({ status, headers, body: Buffer.concat(out).toString('utf-8') });
      },
    };
    router.handle('POST', url, req, res as http.ServerResponse).catch(reject);
  });
}

function parseSse(body: string): Array<Record<string, unknown>> {
  const events: Array<Record<string, unknown>> = [];
  for (const block of body.split('\n\n')) {
    const line = block.split('\n').find((l) => l.startsWith('data: '));
    if (!line) continue;
    try { events.push(JSON.parse(line.slice(6)) as Record<string, unknown>); } catch { /* */ }
  }
  return events;
}

function fakeStreamingAgent(opts: {
  onRetrieval?: unknown;
  tokens?: string[];
  errorMessage?: string;
} = {}): unknown {
  return {
    async chat() { return 'non-stream-ok'; },
    async chatStream(_input: string, callbacks: {
      onRetrieval?: (m: unknown) => void;
      onToken?: (t: string) => void;
      onError?: (e: Error) => void;
    }) {
      if (opts.errorMessage) {
        callbacks.onError?.(new Error(opts.errorMessage));
        throw new Error(opts.errorMessage);
      }
      if (opts.onRetrieval) callbacks.onRetrieval?.(opts.onRetrieval);
      const tokens = opts.tokens ?? ['Hello', ' ', 'world'];
      for (const t of tokens) callbacks.onToken?.(t);
      return tokens.join('');
    },
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

class MockVisionUnavailable implements VisionProvider {
  async isAvailable(): Promise<boolean> { return false; }
  async describe(): Promise<{ description: string }> { return { description: '[Vision not available]' }; }
}

describe('POST /api/chat/multimodal — streaming branch', () => {
  afterEach(() => clearVisionProviderForTesting());

  it('non-streaming default preserves JSON contract (regression)', async () => {
    const router = createApiRouter(fakeStreamingAgent() as never);
    const r = await callMultipart(router, '/api/chat/multimodal', [
      { name: 'message', data: Buffer.from('hello') },
    ]);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'] ?? '')).toMatch(/application\/json/);
    const body = JSON.parse(r.body) as Record<string, unknown>;
    expect(body['response']).toBe('non-stream-ok');
    expect(body['multimodal']).toBe(false);
  });

  it('stream=true returns text/event-stream', async () => {
    const router = createApiRouter(fakeStreamingAgent() as never);
    const r = await callMultipart(router, '/api/chat/multimodal?stream=true', [
      { name: 'message', data: Buffer.from('hi') },
    ]);
    expect(r.status).toBe(200);
    expect(String(r.headers['content-type'] ?? '')).toMatch(/event-stream/);
  });

  it('emits attachment_processed for each uploaded document', async () => {
    const router = createApiRouter(fakeStreamingAgent() as never);
    const r = await callMultipart(router, '/api/chat/multimodal?stream=true', [
      { name: 'message', data: Buffer.from('summarise') },
      { name: 'files', filename: 'a.txt', contentType: 'text/plain', data: Buffer.from('alpha doc') },
      { name: 'files', filename: 'b.txt', contentType: 'text/plain', data: Buffer.from('beta doc') },
    ]);
    const events = parseSse(r.body);
    const attached = events.filter((e) => e['type'] === 'attachment_processed');
    expect(attached).toHaveLength(2);
    expect(attached[0]['filename']).toBe('a.txt');
    expect(attached[0]['available']).toBe(true);
    expect(attached[1]['filename']).toBe('b.txt');
  });

  it('emits attachment_processed with available:false for unreachable vision', async () => {
    setVisionProviderForTesting(new MockVisionUnavailable());
    const router = createApiRouter(fakeStreamingAgent() as never);
    const r = await callMultipart(router, '/api/chat/multimodal?stream=true', [
      { name: 'message', data: Buffer.from('describe') },
      { name: 'files', filename: 'p.png', contentType: 'image/png',
        data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
    ]);
    const events = parseSse(r.body);
    const att = events.find((e) => e['type'] === 'attachment_processed') as Record<string, unknown>;
    expect(att['available']).toBe(false);
    expect(att['kind']).toBe('image');
    expect(String(att['reason'])).toMatch(/vision/i);
  });

  it('emits chat_started before tokens, then done', async () => {
    const router = createApiRouter(fakeStreamingAgent({ tokens: ['foo', 'bar'] }) as never);
    const r = await callMultipart(router, '/api/chat/multimodal?stream=true', [
      { name: 'message', data: Buffer.from('go') },
    ]);
    const events = parseSse(r.body);
    const startedIdx = events.findIndex((e) => e['type'] === 'chat_started');
    const firstTokenIdx = events.findIndex((e) => e['type'] === 'token');
    const doneIdx = events.findIndex((e) => e['type'] === 'done');
    expect(startedIdx).toBeGreaterThanOrEqual(0);
    expect(firstTokenIdx).toBeGreaterThan(startedIdx);
    expect(doneIdx).toBeGreaterThan(firstTokenIdx);
    expect(String((events[doneIdx] as Record<string, unknown>)['content'])).toBe('foobar');
  });

  it('emits retrieval event when chatStream fires onRetrieval', async () => {
    const router = createApiRouter(fakeStreamingAgent({
      onRetrieval: { hits: 3, mode: 'EXACT_SEARCH' },
      tokens: ['ok'],
    }) as never);
    const r = await callMultipart(router, '/api/chat/multimodal?stream=true', [
      { name: 'message', data: Buffer.from('q?') },
    ]);
    const events = parseSse(r.body);
    const retrieval = events.find((e) => e['type'] === 'retrieval') as Record<string, unknown>;
    expect(retrieval).toBeDefined();
    expect((retrieval['retrieval'] as Record<string, unknown>)['hits']).toBe(3);
  });

  it('emits error event with categorised code when chatStream throws', async () => {
    const router = createApiRouter(fakeStreamingAgent({
      errorMessage: 'Ollama request failed: 404 Not Found',
    }) as never);
    const r = await callMultipart(router, '/api/chat/multimodal?stream=true', [
      { name: 'message', data: Buffer.from('go') },
    ]);
    const events = parseSse(r.body);
    const err = events.find((e) => e['type'] === 'error') as Record<string, unknown>;
    expect(err).toBeDefined();
    expect(err['code']).toBe('PROVIDER_UNREACHABLE');
    expect(String(err['message'])).toMatch(/Ollama|provider/i);
  });

  it('non-multipart body still 400 in stream mode', async () => {
    const router = createApiRouter(fakeStreamingAgent() as never);
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method: 'POST', url: '/api/chat/multimodal?stream=true',
      headers: { 'content-type': 'application/json' } });
    process.nextTick(() => {
      (req as unknown as { emit(e: string, c?: Buffer): void }).emit('data', Buffer.from('{}'));
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const out: Buffer[] = []; let status = 0;
    await new Promise<void>((resolve) => {
      const res: Partial<http.ServerResponse> = {
        writeHead(c: number) { status = c; return this as http.ServerResponse; },
        setHeader() { return this as http.ServerResponse; },
        write(c: string | Buffer) { out.push(Buffer.from(c)); return true; },
        end(c?: string | Buffer) {
          if (c) out.push(Buffer.from(c));
          resolve();
        },
      };
      void router.handle('POST', '/api/chat/multimodal?stream=true', req, res as http.ServerResponse);
    });
    expect(status).toBe(400);
  });
});
