/**
 * Qwen3 TTS provider — health diagnostics.
 *
 * Verifies the four failure categories surface distinct, actionable detail
 * strings + the endpointUrl/latencyMs fields, and the happy path returns
 * ok:true with latencyMs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Qwen3Provider } from '../../src/server/tts/providers/qwen3.js';

const realFetch = globalThis.fetch;

function setFetch(impl: (input: unknown, init?: unknown) => Promise<Response>) {
  globalThis.fetch = impl as typeof globalThis.fetch;
}

describe('Qwen3Provider.health()', () => {
  afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

  it('reports misconfigured when baseUrl is not http(s)://host', async () => {
    const p = new Qwen3Provider('not-a-url');
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.category).toBe('misconfigured');
    expect(h.detail).toMatch(/AGENTX_TTS_BASE_URL/);
    expect(h.endpointUrl).toBe('not-a-url');
  });

  it('reports unreachable on ECONNREFUSED-style fetch failure with actionable hint', async () => {
    setFetch(async () => { throw new TypeError('fetch failed'); });
    const p = new Qwen3Provider('http://127.0.0.1:9880');
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.category).toBe('unreachable');
    expect(h.detail).toMatch(/No service listening/);
    expect(h.detail).toMatch(/AGENTX_TTS_/); // hint references the disable knob / config env
    expect(h.endpointUrl).toBe('http://127.0.0.1:9880');
    expect(typeof h.latencyMs).toBe('number');
  });

  it('reports timeout when fetch is aborted', async () => {
    setFetch(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });
    const p = new Qwen3Provider('http://127.0.0.1:9880');
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.category).toBe('timeout');
    expect(h.detail).toMatch(/within \d+ms/);
  });

  it('reports bad_status on non-2xx HTTP', async () => {
    setFetch(async () => new Response('nope', { status: 500 }));
    const p = new Qwen3Provider('http://127.0.0.1:9880');
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.category).toBe('bad_status');
    expect(h.detail).toMatch(/HTTP 500/);
  });

  it('reports ok:true with latencyMs on healthy 200', async () => {
    setFetch(async () => new Response('{}', { status: 200 }));
    const p = new Qwen3Provider('http://127.0.0.1:9880');
    const h = await p.health();
    expect(h.ok).toBe(true);
    expect(h.category).toBeUndefined();
    expect(typeof h.latencyMs).toBe('number');
    expect(h.lastSuccessAt).toBeNull(); // never synthesized yet
  });

  it('honours AGENTX_TTS_QWEN3_DISABLED=1 by disabling the provider', () => {
    process.env['AGENTX_TTS_QWEN3_DISABLED'] = '1';
    try {
      const p = new Qwen3Provider('http://127.0.0.1:9880');
      expect(p.isEnabled()).toBe(false);
    } finally {
      delete process.env['AGENTX_TTS_QWEN3_DISABLED'];
    }
  });
});
