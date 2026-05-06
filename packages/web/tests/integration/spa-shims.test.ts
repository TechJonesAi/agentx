/**
 * Step 3 — SPA compatibility shim regression.
 *
 * Asserts:
 *  - SPA-known but unimplemented endpoints return 501 with the
 *    { available: false, reason, method, endpoint, error } envelope.
 *  - Sub-paths under prefix entries (e.g. /api/integrity/repair/123) match.
 *  - Trailing slash is normalised.
 *  - Unknown endpoints fall through to a 404 with the SAME envelope shape so
 *    SPA panels never have to branch on shape.
 *  - Real, implemented endpoints (/api/health, /api/providers) are NOT
 *    intercepted.
 *  - The Content-Type is always application/json — never HTML.
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import { tryUnsupportedSpaShim } from '../../src/server/routes/spa-shims.js';

function fakeAgent(): unknown {
  return {
    async chat() { return 'ok'; },
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

interface Result { status: number; headers: Record<string, string | string[] | undefined>; body: Record<string, unknown>; raw: string; }

function call(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
  body?: unknown,
): Promise<Result> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : '';
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, {
      method,
      url,
      headers: data ? { 'content-type': 'application/json' } : {},
    });
    process.nextTick(() => {
      if (data) {
        (req as unknown as { emit(e: string, ...a: unknown[]): void }).emit('data', Buffer.from(data, 'utf-8'));
      }
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = [];
    let status = 0;
    const headers: Record<string, string | string[] | undefined> = {};
    const res: Partial<http.ServerResponse> = {
      writeHead(code: number, hdrs?: http.OutgoingHttpHeaders) {
        status = code;
        if (hdrs) for (const [k, v] of Object.entries(hdrs)) headers[k.toLowerCase()] = v as string;
        return this as http.ServerResponse;
      },
      setHeader(k: string, v: string | string[]) {
        headers[k.toLowerCase()] = v;
        return this as http.ServerResponse;
      },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const raw = Buffer.concat(chunks).toString('utf-8');
        try {
          resolve({ status, headers, body: raw ? JSON.parse(raw) : {}, raw });
        } catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

describe('SPA shims — pure matcher', () => {
  it('returns null for implemented endpoints', () => {
    expect(tryUnsupportedSpaShim('GET', '/api/health')).toBeNull();
    expect(tryUnsupportedSpaShim('GET', '/api/providers')).toBeNull();
    expect(tryUnsupportedSpaShim('GET', '/api/sessions')).toBeNull();
    expect(tryUnsupportedSpaShim('GET', '/api/projects')).toBeNull();
    expect(tryUnsupportedSpaShim('GET', '/api/cognitive/status')).toBeNull();
    expect(tryUnsupportedSpaShim('GET', '/api/builder/stats')).toBeNull();
  });

  it('matches exact known-unimplemented endpoints', () => {
    // /api/telemetry is still shimmed (no real route); /api/tts is now real.
    const r = tryUnsupportedSpaShim('POST', '/api/telemetry');
    expect(r?.status).toBe(501);
    expect(r?.body.available).toBe(false);
    expect(r?.body.reason).toBe('not implemented on this build');
    expect(r?.body.method).toBe('POST');
    expect(r?.body.endpoint).toBe('/api/telemetry');
  });

  it('matches sub-paths under prefix entries', () => {
    // /api/integrity prefix still shims sub-paths (status was extracted to a
    // real route in Phase D-prep round 1; repair / repair/:id still shimmed).
    expect(tryUnsupportedSpaShim('POST', '/api/integrity/repair')?.status).toBe(501);
    expect(tryUnsupportedSpaShim('GET', '/api/integrity/repair/abc-123')?.status).toBe(501);
    // agent-loops/history is now real — use /start which is still shimmed.
    expect(tryUnsupportedSpaShim('POST', '/api/agent-loops/start')?.status).toBe(501);
    expect(tryUnsupportedSpaShim('GET', '/api/agent-loops/events')?.status).toBe(501);
    // validation/run is now real — apply / patches / rollback still shimmed.
    expect(tryUnsupportedSpaShim('POST', '/api/validation/apply')?.status).toBe(501);
    expect(tryUnsupportedSpaShim('POST', '/api/vision/analyze')?.status).toBe(501);
    // mcp/servers list is now real — sub-path still shimmed.
    expect(tryUnsupportedSpaShim('GET', '/api/mcp/servers/foo')?.status).toBe(501);
  });

  it('does NOT match implemented top-level endpoints', () => {
    // /api/builder/stats is implemented and not in the shim list.
    expect(tryUnsupportedSpaShim('GET', '/api/builder/stats')).toBeNull();
    // /api/builder/runs is implemented as a real route in api.ts; the
    // matcher itself MAY still return a shim envelope (the prefix is kept
    // so sub-paths like /runs/123 match), but the api router checks real
    // handlers BEFORE the shim, so live behaviour at /api/builder/runs is
    // the real implementation. Sub-path is still shimmed at the matcher.
    expect(tryUnsupportedSpaShim('GET', '/api/builder/runs/123')?.status).toBe(501);
  });

  it('strips query string and trailing slash for matching', () => {
    expect(tryUnsupportedSpaShim('POST', '/api/telemetry?from=ui')?.status).toBe(501);
    expect(tryUnsupportedSpaShim('GET', '/api/integrity/repair/')?.status).toBe(501);
  });
});

describe('SPA shims — wired into the api router', () => {
  it('GET /api/telemetry returns 501 + safe JSON envelope (not HTML, not raw 404)', async () => {
    // /api/telemetry is one of the still-shimmed exact routes; this test
    // asserts the SPA shim contract end-to-end through the router.
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/telemetry');
    expect(r.status).toBe(501);
    expect(String(r.headers['content-type'] ?? '')).toMatch(/application\/json/);
    expect(r.body['available']).toBe(false);
    expect(r.body['reason']).toBe('not implemented on this build');
    expect(r.body['endpoint']).toBe('/api/telemetry');
    expect(r.body['method']).toBe('GET');
    expect(r.raw.startsWith('<')).toBe(false);
  });

  it('POST /api/vision/analyze returns 501 + safe JSON envelope', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'POST', '/api/vision/analyze', { image: 'x' });
    expect(r.status).toBe(501);
    expect(r.body['available']).toBe(false);
  });

  it('GET /api/integrity/status now returns a real 200 (route implemented in Phase D-prep)', async () => {
    // The /api/integrity/status route is now backed by IntelligenceHardening
    // via agent.getIntelligenceHardening(). With the fake agent (no getter),
    // it gracefully returns 200 + { available: false } rather than 501.
    // The /api/integrity prefix shim still applies to sub-paths like
    // /api/integrity/repair (asserted in the prefix-match test above).
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/integrity/status');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(false);
  });

  it('Truly unknown endpoint returns 404 with the SAME envelope shape', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/totally-made-up-route');
    expect(r.status).toBe(404);
    expect(r.body['available']).toBe(false);
    expect(r.body['reason']).toBe('unknown endpoint');
    expect(r.body['endpoint']).toBe('/api/totally-made-up-route');
    expect(r.body['method']).toBe('GET');
    expect(typeof r.body['error']).toBe('string');
  });

  it('Implemented endpoints are NOT intercepted by the shim', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/providers');
    expect(r.status).toBe(200);
    expect(r.body['active']).toBe('anthropic');
    // never the shim shape
    expect(r.body['available']).toBeUndefined();
    expect(r.body['reason']).toBeUndefined();
  });

  it('GET /api/health is unaffected', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/health');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBeUndefined();
  });
});
