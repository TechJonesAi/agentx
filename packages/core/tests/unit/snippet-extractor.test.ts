import { describe, it, expect } from 'vitest';
import { extractSnippet } from '../../src/retrieval/snippet-extractor.js';

describe('extractSnippet — phrase match path', () => {
  it('returns a window containing the matched phrase', () => {
    const content = 'Earlier in the day, Robert Moyes attended a meeting and signed the agreement.';
    const r = extractSnippet(content, 'robert moyes');
    expect(r.snippet.toLowerCase()).toContain('robert moyes');
    expect(r.matchedPhrase).toBe('Robert Moyes'); // original casing preserved
  });

  it('caps total length at maxChars + 2 (for ellipses)', () => {
    const content = 'a'.repeat(2000) + ' Robert Moyes ' + 'b'.repeat(2000);
    const r = extractSnippet(content, 'Robert Moyes', 240);
    expect(r.snippet.length).toBeLessThanOrEqual(242);
    expect(r.snippet.toLowerCase()).toContain('robert moyes');
  });

  it('inserts leading ellipsis when window starts mid-content', () => {
    const long = 'x'.repeat(500) + ' Jane Doe ' + 'y'.repeat(500);
    const r = extractSnippet(long, 'Jane Doe', 100);
    expect(r.snippet.startsWith('…')).toBe(true);
  });

  it('inserts trailing ellipsis when window ends mid-content', () => {
    const long = 'x'.repeat(500) + ' Jane Doe ' + 'y'.repeat(500);
    const r = extractSnippet(long, 'Jane Doe', 100);
    expect(r.snippet.endsWith('…')).toBe(true);
  });

  it('case-insensitive match — preserves original casing in matchedPhrase', () => {
    const content = 'In the document, ROBERT MOYES is the lead signatory.';
    const r = extractSnippet(content, 'robert moyes');
    expect(r.matchedPhrase).toBe('ROBERT MOYES');
  });
});

describe('extractSnippet — no match path', () => {
  it('returns leading slice when phrase is absent', () => {
    const content = 'this content does not contain the search term anywhere in it';
    const r = extractSnippet(content, 'unicorn', 30);
    expect(r.matchedPhrase).toBeUndefined();
    expect(r.snippet.length).toBeLessThanOrEqual(31); // 30 + ellipsis
    expect(content.startsWith(r.snippet.replace(/…$/, ''))).toBe(true);
  });

  it('returns full content when shorter than maxChars', () => {
    const content = 'short';
    const r = extractSnippet(content, 'unicorn', 240);
    expect(r.snippet).toBe('short');
  });
});

describe('extractSnippet — empty / null safety', () => {
  it('null content → empty snippet', () => {
    expect(extractSnippet(null, 'phrase').snippet).toBe('');
  });
  it('undefined content → empty snippet', () => {
    expect(extractSnippet(undefined, 'phrase').snippet).toBe('');
  });
  it('whitespace-only content → empty snippet', () => {
    expect(extractSnippet('   \n\t  ', 'phrase').snippet).toBe('');
  });
  it('empty phrase → leading slice without highlight', () => {
    const r = extractSnippet('hello world from the test', '');
    expect(r.matchedPhrase).toBeUndefined();
    expect(r.snippet).toContain('hello world');
  });
  it('null phrase → leading slice', () => {
    const r = extractSnippet('hello world', null);
    expect(r.matchedPhrase).toBeUndefined();
  });
});

describe('extractSnippet — whitespace normalisation', () => {
  it('collapses multi-line / tab whitespace into single spaces', () => {
    const content = 'first line\n\n\tRobert    Moyes\nspoke';
    const r = extractSnippet(content, 'Robert Moyes');
    expect(r.snippet).not.toContain('\n');
    expect(r.snippet).not.toContain('\t');
  });
});
