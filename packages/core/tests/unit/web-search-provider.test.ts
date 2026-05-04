import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DuckDuckGoSearchProvider } from '../../src/reasoning/web-search-provider.js';

describe('DuckDuckGoSearchProvider', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('constructs without args', () => {
    const p = new DuckDuckGoSearchProvider();
    expect(p).toBeDefined();
    expect(typeof p.search).toBe('function');
  });

  it('returns empty array when fetch returns no usable results', async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const p = new DuckDuckGoSearchProvider();
    const out = await p.search('test query');
    expect(Array.isArray(out)).toBe(true);
  });

  it('returns empty array when fetch fails', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('network'); }) as unknown as typeof fetch;
    const p = new DuckDuckGoSearchProvider();
    const out = await p.search('test query');
    expect(Array.isArray(out)).toBe(true);
    expect(out.length).toBe(0);
  });

  it('honours maxResults parameter', async () => {
    // Arrange a response with many AbstractText / RelatedTopics entries
    const fakeBody = {
      AbstractText: 'Wikipedia summary.',
      AbstractURL: 'https://en.wikipedia.org/x',
      Heading: 'X',
      RelatedTopics: Array.from({ length: 10 }, (_, i) => ({
        Text: `topic ${i} description`,
        FirstURL: `https://example.com/${i}`,
      })),
    };
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(fakeBody), { status: 200 })) as unknown as typeof fetch;
    const p = new DuckDuckGoSearchProvider();
    const out = await p.search('q', 3);
    expect(out.length).toBeLessThanOrEqual(3);
  });

  it('non-200 status results in empty array', async () => {
    globalThis.fetch = vi.fn(async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    const p = new DuckDuckGoSearchProvider();
    const out = await p.search('q');
    expect(out.length).toBe(0);
  });
});
