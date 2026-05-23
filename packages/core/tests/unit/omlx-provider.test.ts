/**
 * OmlxProvider — Batch 9 hard-localhost validation + OpenAI-compatible
 * request shape + per-call model override.
 *
 * The provider MUST reject any non-localhost endpoint at construction
 * time so a misconfiguration cannot silently leak inference to a remote
 * server. This guarantee is independent of runtime localOnly settings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OmlxProvider } from '../../src/llm/omlx.js';

describe('OmlxProvider — localhost-only validation', () => {
  it('accepts localhost / 127.0.0.1 / ::1 / 0.0.0.0', () => {
    for (const host of ['localhost', '127.0.0.1', '0.0.0.0']) {
      expect(() => OmlxProvider.assertLocalhostOnly(`http://${host}:8080`)).not.toThrow();
    }
    // IPv6 must include brackets in URL form
    expect(() => OmlxProvider.assertLocalhostOnly('http://[::1]:8080')).not.toThrow();
  });

  it('rejects non-localhost hostnames', () => {
    for (const url of [
      'http://example.com:8080',
      'https://api.openai.com/v1',
      'http://192.168.1.50:8080',  // LAN — still not allowed
      'http://10.0.0.1:8080',
      'http://my-mac.local:8080',
    ]) {
      expect(() => OmlxProvider.assertLocalhostOnly(url)).toThrow(/non-local host/);
    }
  });

  it('rejects malformed URLs', () => {
    expect(() => OmlxProvider.assertLocalhostOnly('not a url')).toThrow();
    expect(() => OmlxProvider.assertLocalhostOnly('')).toThrow();
  });

  it('constructor throws for non-local endpoint', () => {
    expect(() => new OmlxProvider({ endpoint: 'http://example.com:8080' })).toThrow(/non-local host/);
  });

  it('constructor succeeds for local endpoint and exposes getter', () => {
    const p = new OmlxProvider({ endpoint: 'http://localhost:8080', model: 'test-model' });
    expect(p.getEndpoint()).toBe('http://localhost:8080');
    expect(p.getModel()).toBe('test-model');
    expect(p.name).toBe('omlx');
    expect(p.isConfigured()).toBe(true);
  });
});

describe('OmlxProvider — OpenAI-compatible request', () => {
  let prevFetch: typeof globalThis.fetch;
  beforeEach(() => { prevFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = prevFetch; });

  const okBody = {
    choices: [{ message: { content: 'hello from omlx', tool_calls: [] }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  };

  it('sends POST /v1/chat/completions with model + messages', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(okBody), { status: 200 });
    }) as never;

    const p = new OmlxProvider({ endpoint: 'http://localhost:8080', model: 'default-mlx' });
    const r = await p.complete({
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      systemPrompt: 'you are helpful',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://localhost:8080/v1/chat/completions');
    expect(calls[0]?.body.model).toBe('default-mlx');
    expect(calls[0]?.body.stream).toBe(false);
    const messages = calls[0]?.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[0]?.content).toBe('you are helpful');
    expect(messages[1]?.role).toBe('user');
    expect(r.content).toBe('hello from omlx');
    expect(r.usage?.inputTokens).toBe(10);
    expect(r.usage?.outputTokens).toBe(5);
  });

  it('honors per-call model override without mutating provider state', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(okBody), { status: 200 });
    }) as never;

    const p = new OmlxProvider({ endpoint: 'http://localhost:8080', model: 'default-mlx' });
    await p.complete({
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      model: 'override-mlx',
    });
    expect(calls[0]?.body.model).toBe('override-mlx');
    expect(p.getModel()).toBe('default-mlx');  // unchanged
  });

  it('emits OpenAI-shaped tool definitions when provided', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_u: string | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(okBody), { status: 200 });
    }) as never;

    const p = new OmlxProvider({ endpoint: 'http://localhost:8080' });
    await p.complete({
      messages: [{ role: 'user', content: 'hi', timestamp: 0 }],
      tools: [{ name: 'shell', description: 'run', parameters: { type: 'object', properties: {} } }],
    });
    const tools = calls[0]?.body.tools as Array<{ type: string; function: { name: string } }>;
    expect(tools).toHaveLength(1);
    expect(tools[0]?.type).toBe('function');
    expect(tools[0]?.function.name).toBe('shell');
  });

  it('throws when /v1/chat/completions returns non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => new Response('boom', { status: 500, statusText: 'Internal' })) as never;
    const p = new OmlxProvider({ endpoint: 'http://localhost:8080' });
    await expect(p.complete({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] }))
      .rejects.toThrow(/oMLX request failed: 500/);
  });
});
