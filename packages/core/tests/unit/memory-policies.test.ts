import { describe, it, expect } from 'vitest';
import {
  normalizeContent,
  contentHash,
  generateTrigrams,
  jaccardTrigramSimilarity,
  computeRelevanceScore,
  computeRecencyScore,
  computeFrequencyScore,
  computeDecayFactor,
  DEFAULT_MEMORY_POLICY,
} from '../../src/memory/memory-policies.js';

describe('normalizeContent', () => {
  it('lowercases', () => {
    expect(normalizeContent('Hello World')).toBe('hello world');
  });

  it('collapses whitespace', () => {
    expect(normalizeContent('foo   bar\n\tbaz')).toBe('foo bar baz');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeContent('   x  ')).toBe('x');
  });

  it('handles empty input', () => {
    expect(normalizeContent('')).toBe('');
  });
});

describe('contentHash', () => {
  it('produces consistent hash for the same content', () => {
    expect(contentHash('hello')).toBe(contentHash('hello'));
  });

  it('produces different hashes for different content', () => {
    expect(contentHash('hello')).not.toBe(contentHash('world'));
  });

  it('is invariant to case + whitespace via normalisation', () => {
    expect(contentHash('Hello World')).toBe(contentHash('hello   world'));
  });

  it('hex output', () => {
    expect(contentHash('x')).toMatch(/^[0-9a-f]+$/);
  });
});

describe('generateTrigrams', () => {
  it('produces character trigrams from normalized content', () => {
    const tg = generateTrigrams('hello');
    expect(tg.size).toBeGreaterThan(0);
  });

  it('returns identical set for identical normalized input', () => {
    expect(Array.from(generateTrigrams('Hello')).sort()).toEqual(Array.from(generateTrigrams('hello')).sort());
  });

  it('handles short input gracefully', () => {
    const tg = generateTrigrams('ab');
    expect(tg).toBeInstanceOf(Set);
  });
});

describe('jaccardTrigramSimilarity', () => {
  it('identical strings → 1', () => {
    expect(jaccardTrigramSimilarity('hello world', 'hello world')).toBe(1);
  });

  it('completely disjoint strings → 0 or near 0', () => {
    const sim = jaccardTrigramSimilarity('aaaaaaaa', 'bbbbbbbb');
    expect(sim).toBeLessThan(0.1);
  });

  it('similar strings → between 0 and 1', () => {
    const sim = jaccardTrigramSimilarity('the quick brown fox', 'the quick brown dog');
    expect(sim).toBeGreaterThan(0.4);
    expect(sim).toBeLessThan(1);
  });

  it('case-insensitive', () => {
    expect(jaccardTrigramSimilarity('Hello', 'hello')).toBe(1);
  });
});

describe('computeRelevanceScore', () => {
  it('returns 0 for unrelated content', () => {
    const r = computeRelevanceScore('apple', 'orange banana');
    expect(r.score).toBe(0);
  });

  it('returns positive score when query terms appear in content', () => {
    const r = computeRelevanceScore('apple', 'i ate an apple yesterday');
    expect(r.score).toBeGreaterThan(0);
    expect(r.matchedTerms).toContain('apple');
  });

  it('matches multiple query terms', () => {
    const r = computeRelevanceScore('quick fox', 'the quick brown fox');
    expect(r.matchedTerms.length).toBe(2);
  });
});

describe('computeRecencyScore', () => {
  it('recent access → high score (close to 1)', () => {
    const now = Date.now();
    const score = computeRecencyScore(now, now, now);
    expect(score).toBeGreaterThan(0.9);
  });

  it('very old access → low score', () => {
    const now = Date.now();
    const oneYearAgo = now - 365 * 24 * 60 * 60 * 1000;
    const score = computeRecencyScore(oneYearAgo, oneYearAgo, now);
    expect(score).toBeLessThan(0.5);
  });
});

describe('computeFrequencyScore', () => {
  it('zero accesses → 0', () => {
    expect(computeFrequencyScore(0)).toBe(0);
  });

  it('higher access count → higher score (monotonic)', () => {
    const a = computeFrequencyScore(1);
    const b = computeFrequencyScore(10);
    const c = computeFrequencyScore(100);
    expect(a).toBeLessThanOrEqual(b);
    expect(b).toBeLessThanOrEqual(c);
  });

  it('caps at or below 1', () => {
    expect(computeFrequencyScore(1_000_000)).toBeLessThanOrEqual(1);
  });
});

describe('computeDecayFactor', () => {
  it('returns 1 when age is 0', () => {
    const now = Date.now();
    const f = computeDecayFactor(now, now, 1, now);
    expect(f).toBe(1);
  });

  it('decays over time (halflife respected)', () => {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;
    const halfLifeDays = 1;
    const f = computeDecayFactor(now - oneDayMs, now - oneDayMs, halfLifeDays, now);
    // After exactly one half-life, factor should be ~0.5
    expect(f).toBeGreaterThan(0.4);
    expect(f).toBeLessThan(0.6);
  });

  it('uses createdAt when accessedAt is 0', () => {
    const now = Date.now();
    const f = computeDecayFactor(0, now, 100, now);
    expect(f).toBe(1);
  });
});

describe('DEFAULT_MEMORY_POLICY', () => {
  it('is defined', () => {
    expect(DEFAULT_MEMORY_POLICY).toBeDefined();
  });
});
