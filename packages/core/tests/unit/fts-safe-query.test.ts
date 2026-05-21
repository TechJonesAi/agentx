/**
 * safeFtsQuery — Batch 4 retrieval truth hardening.
 *
 * Real natural-language queries must not silently produce zero matches due
 * to FTS5 syntax errors. This suite covers the punctuation, keyword,
 * phrase, and accent paths.
 */
import { describe, it, expect } from 'vitest';
import { safeFtsQuery } from '../../src/memory/fts-index-service.js';

describe('safeFtsQuery', () => {
  it('returns null for empty or whitespace input', () => {
    expect(safeFtsQuery('')).toBeNull();
    expect(safeFtsQuery('   \t\n')).toBeNull();
    expect(safeFtsQuery(null as unknown as string)).toBeNull();
  });

  it('strips punctuation and joins with spaces', () => {
    expect(safeFtsQuery("what's the deadline?")).toBe('what the deadline');
  });

  it('drops FTS5 operator chars (-, *, :, ", (, ), ^, +)', () => {
    expect(safeFtsQuery('quarterly-report status:open *priority')).toBe('quarterly report status open priority');
  });

  it('drops 1-character non-numeric tokens but keeps digits', () => {
    expect(safeFtsQuery('a b 9 yo')).toBe('9 yo');
  });

  it('drops bare FTS5 keywords (AND, OR, NOT, NEAR)', () => {
    expect(safeFtsQuery('memory AND notes OR tasks NEAR backups')).toBe('memory notes tasks backups');
  });

  it('preserves quoted phrases as FTS5 phrase tokens', () => {
    const out = safeFtsQuery('find "exact phrase" in notes');
    expect(out).toContain('"exact phrase"');
    expect(out).toContain('find');
    expect(out).toContain('notes');
  });

  it('lowercases and removes accents', () => {
    expect(safeFtsQuery('Naïve Café')).toBe('naive cafe');
  });

  it('returns null when only operator chars + 1-char tokens remain', () => {
    expect(safeFtsQuery('- - * + ^ : ( )')).toBeNull();
    expect(safeFtsQuery('a b c')).toBeNull();
  });

  it('phrase with punctuation in it is cleaned of punctuation but kept as phrase', () => {
    const out = safeFtsQuery('"O\'Brien report"');
    expect(out).toBe('"o brien report"');
  });

  it('handles multilingual scripts gracefully (CJK tokens are dropped — Western FTS limitation)', () => {
    // CJK chars are non-ASCII; the current tokenizer is ASCII-only so they
    // get filtered. Verify we don't crash and that mixed input works.
    const out = safeFtsQuery('hello 世界 ニュース update');
    expect(out).toBe('hello update');
  });
});
