/**
 * Ollama provider — per-call model override.
 * Batch 3 verification: passing `model` in LLMRequestOptions must change
 * the model name sent in the request body, WITHOUT mutating provider state.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OllamaProvider } from '../../src/llm/ollama.js';

const FAKE_RESPONSE = {
  message: { content: 'ok', role: 'assistant', tool_calls: undefined },
  done: true,
  prompt_eval_count: 1,
  eval_count: 1,
};

describe('OllamaProvider — per-call model override', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => { originalFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = originalFetch; });

  it('passes options.model to the request body when provided', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(FAKE_RESPONSE), { status: 200 });
    }) as never;

    const p = new OllamaProvider('default-model', 'http://localhost:11434');
    await p.complete({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }], model: 'override-model' });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.body.model).toBe('override-model');
  });

  it('falls back to constructor model when options.model not set', async () => {
    const calls: Array<{ body: Record<string, unknown> }> = [];
    globalThis.fetch = vi.fn(async (_url, init?: RequestInit) => {
      calls.push({ body: JSON.parse(String(init?.body ?? '{}')) });
      return new Response(JSON.stringify(FAKE_RESPONSE), { status: 200 });
    }) as never;

    const p = new OllamaProvider('default-model', 'http://localhost:11434');
    await p.complete({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }] });

    expect(calls[0]?.body.model).toBe('default-model');
  });

  it('does NOT mutate provider.model when override is supplied', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify(FAKE_RESPONSE), { status: 200 }),
    ) as never;
    const p = new OllamaProvider('default-model', 'http://localhost:11434');
    await p.complete({ messages: [{ role: 'user', content: 'hi', timestamp: 0 }], model: 'override-X' });
    expect(p.getModel()).toBe('default-model');
  });
});
