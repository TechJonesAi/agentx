/**
 * Live-route regression — POST /api/chat returns categorised error JSON
 * (not a raw 500 leak) when the agent's chat() throws a provider-auth
 * error. Reproduces the urgent live-dashboard 500 reported by the user.
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';

interface FakeAgentOpts {
  chatThrows?: Error;
  retrievalMeta?: unknown;
}

function fakeAgent(opts: FakeAgentOpts = {}): unknown {
  return {
    async chat() {
      if (opts.chatThrows) throw opts.chatThrows;
      return 'ok';
    },
    getLastRetrievalMetadata() { return opts.retrievalMeta ?? null; },
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
    getSessionManager() {
      return {
        listActive() { return []; },
        resetSession() { /* no-op */ },
      };
    },
    getToolRegistry() {
      return { getDefinitions() { return []; } };
    },
  };
}

/** Send a JSON body and a synthesised request/response pair through the router. */
function postChat(router: ReturnType<typeof createApiRouter>, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, {
      method: 'POST',
      url: '/api/chat',
      headers: { 'content-type': 'application/json' },
    });
    // Emit data + end on next tick so the parseBody listener is set up.
    process.nextTick(() => {
      (req as unknown as { emit(e: string, ...args: unknown[]): void }).emit('data', Buffer.from(data, 'utf-8'));
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
        try {
          const text = Buffer.concat(chunks).toString('utf-8');
          resolve({ status, body: text ? JSON.parse(text) : {} });
        } catch (e) { reject(e); }
      },
    };

    router.handle('POST', '/api/chat', req, res as http.ServerResponse).catch(reject);
  });
}

describe('POST /api/chat — error categorisation (live-route regression)', () => {
  it('Anthropic missing-auth error → 503 / PROVIDER_AUTH_MISSING (not 500 raw leak)', async () => {
    const agent = fakeAgent({
      chatThrows: new Error(
        'Could not resolve authentication method. Expected either apiKey or authToken to be set.',
      ),
    });
    const router = createApiRouter(agent as never);
    const r = await postChat(router, { message: 'How many documents do I have?' });
    expect(r.status).toBe(503);
    expect(r.body['code']).toBe('PROVIDER_AUTH_MISSING');
    expect(String(r.body['error'])).toMatch(/not authenticated/i);
    // The raw SDK string MUST NOT leak to the client
    expect(JSON.stringify(r.body)).not.toContain('X-Api-Key');
    expect(JSON.stringify(r.body)).not.toContain('apiKey or authToken');
  });

  it('Rate limit error → 429 / PROVIDER_RATE_LIMITED', async () => {
    const agent = fakeAgent({ chatThrows: new Error('rate limit exceeded') });
    const router = createApiRouter(agent as never);
    const r = await postChat(router, { message: 'q' });
    expect(r.status).toBe(429);
    expect(r.body['code']).toBe('PROVIDER_RATE_LIMITED');
  });

  it('Network unreachable → 502 / PROVIDER_UNREACHABLE', async () => {
    const agent = fakeAgent({ chatThrows: new Error('connect ECONNREFUSED 127.0.0.1:11434') });
    const router = createApiRouter(agent as never);
    const r = await postChat(router, { message: 'q' });
    expect(r.status).toBe(502);
    expect(r.body['code']).toBe('PROVIDER_UNREACHABLE');
  });

  it('Successful chat returns 200 with the response', async () => {
    const agent = fakeAgent();
    const router = createApiRouter(agent as never);
    const r = await postChat(router, { message: 'hello' });
    expect(r.status).toBe(200);
    expect(r.body['response']).toBe('ok');
  });

  it('Missing message → 400', async () => {
    const agent = fakeAgent();
    const router = createApiRouter(agent as never);
    const r = await postChat(router, {});
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toMatch(/required/);
  });
});

describe('GET /api/providers — provider availability for the dashboard', () => {
  it('returns active provider, model, and a list with configured/notConfigured state', async () => {
    const agent = fakeAgent();
    const router = createApiRouter(agent as never);
    const r = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
      const req = new http.IncomingMessage(null as unknown as never);
      Object.assign(req, { method: 'GET', url: '/api/providers', headers: {} });
      const chunks: Buffer[] = [];
      let status = 0;
      const res: Partial<http.ServerResponse> = {
        writeHead(code: number) { status = code; return this as http.ServerResponse; },
        setHeader() { return this as http.ServerResponse; },
        end(c?: string | Buffer) {
          if (c) chunks.push(Buffer.from(c));
          try { resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) }); }
          catch (e) { reject(e); }
        },
      };
      router.handle('GET', '/api/providers', req, res as http.ServerResponse).catch(reject);
    });
    expect(r.status).toBe(200);
    expect(r.body['active']).toBe('anthropic');
    expect(Array.isArray(r.body['providers'])).toBe(true);
    const providers = r.body['providers'] as Array<{ id: string; configured: boolean }>;
    expect(providers.map(p => p.id).sort()).toEqual(['anthropic', 'ollama', 'openai']);
    // Ollama is always shown as configured (no API key needed)
    const ollama = providers.find(p => p.id === 'ollama')!;
    expect(ollama.configured).toBe(true);
  });
});
