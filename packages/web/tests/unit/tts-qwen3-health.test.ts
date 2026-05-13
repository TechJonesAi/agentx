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

  it('AGENTX_TTS_QWEN3_BASE_URL overrides default and beats the generic env', () => {
    process.env['AGENTX_TTS_BASE_URL'] = 'http://1.1.1.1:9999';
    process.env['AGENTX_TTS_QWEN3_BASE_URL'] = 'http://2.2.2.2:8888';
    try {
      const p = new Qwen3Provider();
      expect(p.getEndpointUrl()).toBe('http://2.2.2.2:8888');
    } finally {
      delete process.env['AGENTX_TTS_BASE_URL'];
      delete process.env['AGENTX_TTS_QWEN3_BASE_URL'];
    }
  });

  it('falls back to AGENTX_TTS_BASE_URL when QWEN3-specific not set', () => {
    process.env['AGENTX_TTS_BASE_URL'] = 'http://3.3.3.3:7777';
    delete process.env['AGENTX_TTS_QWEN3_BASE_URL'];
    try {
      const p = new Qwen3Provider();
      expect(p.getEndpointUrl()).toBe('http://3.3.3.3:7777');
    } finally {
      delete process.env['AGENTX_TTS_BASE_URL'];
    }
  });

  it('synthesize sets lastSuccessAt on success', async () => {
    const audioBytes = Buffer.from('ID3\x03\x00fakepayload', 'binary');
    setFetch(async () => {
      // Health probe path is not exercised here — only /tts is called.
      return new Response(audioBytes as unknown as BodyInit, {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      });
    });
    const p = new Qwen3Provider('http://127.0.0.1:9880');
    expect(p.getLastSuccessAt()).toBeNull();
    const r = await p.synthesize({ text: 'hello', voiceId: 'Chelsie' });
    expect(r.contentType).toBe('audio/mpeg');
    expect(r.providerId).toBe('qwen3');
    expect(p.getLastSuccessAt()).not.toBeNull();
  });
});
