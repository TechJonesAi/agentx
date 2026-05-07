/**
 * Tier 2 batch A — Claude OAuth routes asserted end-to-end via the api router.
 *
 *   POST /api/auth/claude/start       → start OAuth flow
 *   POST /api/auth/claude/disconnect  → clear stored credentials
 *   GET  /api/auth/claude/status      → connection status (Tier 1; sanity)
 *
 * Tests use a fake agent that returns a stub OAuth service. We never run a
 * real PKCE/Keychain interaction — each method on the stub is a Promise.
 */
import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

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
        try { resolve({ status, body: raw ? JSON.parse(raw) : {}, raw }); }
        catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

interface OAuthStub {
  startAuthFlow?: () => Promise<{ authUrl: string; state: string; callbackPort: number; waitForCompletion(): Promise<unknown> }>;
  disconnect?: () => Promise<void>;
  getStatus?: () => Promise<unknown>;
}

function fakeAgent(opts: { oauth?: OAuthStub | null } = {}): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
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

describe('Tier 2 batch A — Claude OAuth routes', () => {
  describe('POST /api/auth/claude/start', () => {
    it('returns 200 with authUrl + callbackPort when service starts the flow', async () => {
      const waitForCompletion = vi.fn(() => new Promise<unknown>(() => { /* never resolves */ }));
      const startAuthFlow = vi.fn(async () => ({
        authUrl: 'https://auth.example.com/oauth?state=abc',
        state: 'abc',
        callbackPort: 9876,
        waitForCompletion,
      }));
      const router = createApiRouter(fakeAgent({ oauth: { startAuthFlow } }) as never);
      const r = await call(router, 'POST', '/api/auth/claude/start');
      expect(r.status).toBe(200);
      expect(r.body['started']).toBe(true);
      expect(r.body['authUrl']).toBe('https://auth.example.com/oauth?state=abc');
      expect(r.body['callbackPort']).toBe(9876);
      // The route should NOT block on waitForCompletion — it must have been
      // called (fire-and-forget) but its promise must not affect response.
      expect(waitForCompletion).toHaveBeenCalledTimes(1);
      // shim envelope must NOT appear
      expect(r.body['available']).toBeUndefined();
      expect(r.body['reason']).toBeUndefined();
    });

    it('returns 500 with safe error message when startAuthFlow throws', async () => {
      const startAuthFlow = vi.fn(async () => { throw new Error('keychain blocked'); });
      const router = createApiRouter(fakeAgent({ oauth: { startAuthFlow } }) as never);
      const r = await call(router, 'POST', '/api/auth/claude/start');
      expect(r.status).toBe(500);
      expect(String(r.body['error'])).toContain('keychain blocked');
      expect(r.body['available']).toBeUndefined();
    });

    it('swallows waitForCompletion rejection so the server stays alive', async () => {
      // waitForCompletion rejects later; the route must have already responded.
      let rejecter: (e: Error) => void = () => { /* */ };
      const wait = new Promise<unknown>((_, reject) => { rejecter = reject; });
      const startAuthFlow = vi.fn(async () => ({
        authUrl: 'https://x', state: 's', callbackPort: 0, waitForCompletion: () => wait,
      }));
      const router = createApiRouter(fakeAgent({ oauth: { startAuthFlow } }) as never);
      const r = await call(router, 'POST', '/api/auth/claude/start');
      expect(r.status).toBe(200);
      // Reject after the response has been sent — must not throw "unhandled promise"
      rejecter(new Error('user cancelled'));
      // Give the rejection a tick to propagate; absence of crash = pass.
      await new Promise((res) => setTimeout(res, 5));
    });

    it('returns 500 when OAuth service is null (defensive parity with silly)', async () => {
      const router = createApiRouter(fakeAgent({ oauth: null }) as never);
      const r = await call(router, 'POST', '/api/auth/claude/start');
      expect(r.status).toBe(500);
      expect(String(r.body['error'])).toContain('OAuth service unavailable');
    });
  });

  describe('POST /api/auth/claude/disconnect', () => {
    it('returns 200 { disconnected: true } when service revokes successfully', async () => {
      const disconnect = vi.fn(async () => undefined);
      const router = createApiRouter(fakeAgent({ oauth: { disconnect } }) as never);
      const r = await call(router, 'POST', '/api/auth/claude/disconnect');
      expect(r.status).toBe(200);
      expect(r.body['disconnected']).toBe(true);
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(r.body['available']).toBeUndefined();
    });

    it('returns 200 { disconnected: true, reason: "service_unavailable" } when service is null', async () => {
      const router = createApiRouter(fakeAgent({ oauth: null }) as never);
      const r = await call(router, 'POST', '/api/auth/claude/disconnect');
      expect(r.status).toBe(200);
      expect(r.body['disconnected']).toBe(true);
      expect(r.body['reason']).toBe('service_unavailable');
    });

    it('returns 500 with safe error message when disconnect throws', async () => {
      const disconnect = vi.fn(async () => { throw new Error('keychain locked'); });
      const router = createApiRouter(fakeAgent({ oauth: { disconnect } }) as never);
      const r = await call(router, 'POST', '/api/auth/claude/disconnect');
      expect(r.status).toBe(500);
      expect(String(r.body['error'])).toContain('keychain locked');
    });
  });

  describe('GET /api/auth/claude/status (Tier 1 sanity)', () => {
    it('still returns the service status when wired', async () => {
      const getStatus = vi.fn(async () => ({ connected: true, account: 'demo@example.com' }));
      const router = createApiRouter(fakeAgent({ oauth: { getStatus } }) as never);
      const r = await call(router, 'GET', '/api/auth/claude/status');
      expect(r.status).toBe(200);
      expect(r.body['connected']).toBe(true);
      expect(r.body['account']).toBe('demo@example.com');
    });

    it('still returns service_unavailable when service is null', async () => {
      const router = createApiRouter(fakeAgent({ oauth: null }) as never);
      const r = await call(router, 'GET', '/api/auth/claude/status');
      expect(r.status).toBe(200);
      expect(r.body['connected']).toBe(false);
      expect(r.body['reason']).toBe('service_unavailable');
    });
  });
});
