/**
 * Tier 1 safe-batch — 5 newly-real routes asserted end-to-end via the
 * api router (no live HTTP server, just the handler).
 *
 *  1. GET /api/agent-loops/events    → real eventBus history (not shim)
 *  2. GET /api/agent-loops/:loopId   → 404 with safe shape for unknown id
 *  3. GET /api/agents/trace          → real {events,count} (not shim)
 *  4. GET /api/auth/claude/status    → {connected:false, reason:'service_unavailable'}
 *  5. GET /api/logs/llm-interactions/:id → 404 with safe shape for unknown id
 *
 * Plus regressions confirming the still-shimmed routes (Tier 2) remain 501.
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; headers: Record<string, string | string[] | undefined>; }

function call(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method, url, headers: {} });
    process.nextTick(() => {
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = [];
    let status = 0;
    const responseHeaders: Record<string, string | string[] | undefined> = {};
    const res: Partial<http.ServerResponse> = {
      writeHead(code: number, hdrs?: http.OutgoingHttpHeaders) {
        status = code;
        if (hdrs) for (const [k, v] of Object.entries(hdrs)) responseHeaders[k.toLowerCase()] = v as string;
        return this as http.ServerResponse;
      },
      setHeader(k: string, v: string | string[]) {
        responseHeaders[k.toLowerCase()] = v;
        return this as http.ServerResponse;
      },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status, body: raw ? JSON.parse(raw) : {}, raw, headers: responseHeaders }); }
        catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

function fakeAgent(opts: { oauth?: unknown } = {}): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    // The status route checks getClaudeOAuthService()'s null-ness.
    getClaudeOAuthService: () => opts.oauth ?? null,
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

describe('Tier 1 safe-batch — 5 newly-real routes', () => {
  it('GET /api/agent-loops/events returns a real {events: []} (not the shim envelope)', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/agent-loops/events');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body['events'])).toBe(true);
    // Not the SPA shim envelope
    expect(r.body['available']).toBeUndefined();
    expect(r.body['reason']).toBeUndefined();
  });

  it('GET /api/agent-loops/:loopId returns a safe 404 for unknown id (no shim leak)', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/agent-loops/nonexistent-loop-xyz');
    expect(r.status).toBe(404);
    expect(String(r.body['error'])).toContain('Agent loop not found');
    expect(r.body['available']).toBeUndefined();
  });

  it('GET /api/agents/trace returns {events,count} with empty events on a fresh bus', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/agents/trace?limit=20');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body['events'])).toBe(true);
    expect(typeof r.body['count']).toBe('number');
    expect(r.body['available']).toBeUndefined();
  });

  it('GET /api/auth/claude/status returns {connected:false, reason:"service_unavailable"} when service is null', async () => {
    const router = createApiRouter(fakeAgent({ oauth: null }) as never);
    const r = await call(router, 'GET', '/api/auth/claude/status');
    expect(r.status).toBe(200);
    expect(r.body['connected']).toBe(false);
    expect(r.body['reason']).toBe('service_unavailable');
    // Not the SPA shim envelope
    expect(r.body['available']).toBeUndefined();
  });

  it('GET /api/auth/claude/status returns the service status when wired', async () => {
    // Inject a fake oauth service to verify the wired path also works
    const fakeOauth = { async getStatus() { return { connected: true, account: 'demo@example.com' }; } };
    const router = createApiRouter(fakeAgent({ oauth: fakeOauth }) as never);
    const r = await call(router, 'GET', '/api/auth/claude/status');
    expect(r.status).toBe(200);
    expect(r.body['connected']).toBe(true);
    expect(r.body['account']).toBe('demo@example.com');
  });

  it('GET /api/logs/llm-interactions/:id returns a safe 404 for unknown id', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/logs/llm-interactions/some-fake-id-xyz');
    expect(r.status).toBe(404);
    expect(String(r.body['error'])).toContain('not found');
    expect(r.body['available']).toBeUndefined();
  });

  it('GET /api/logs/llm-interactions (top-level) is unaffected by the new :id handler', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/logs/llm-interactions');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body['entries'])).toBe(true);
  });

  // (Sanity: confirm a still-shimmed Tier 3 route stays 501.
  //  /api/agent-loops/start became real in Tier 2 batch C (env-gated).
  //  /api/vision/analyze remains shimmed (Tier 3 — Ollama vision dep).)
  it('Tier 3 route POST /api/vision/analyze is still shimmed (501)', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'POST', '/api/vision/analyze');
    expect(r.status).toBe(501);
    expect(r.body['available']).toBe(false);
  });
});
