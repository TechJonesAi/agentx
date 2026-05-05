import { describe, it, expect } from 'vitest';
import { normalizeSemanticQuery } from '../../src/retrieval/semantic-query-normalizer.js';

describe('normalizeSemanticQuery — empty / null safety', () => {
  it('returns empty string for null', () => {
    expect(normalizeSemanticQuery(null)).toBe('');
  });
  it('returns empty string for undefined', () => {
    expect(normalizeSemanticQuery(undefined)).toBe('');
  });
  it('returns empty string for empty input', () => {
    expect(normalizeSemanticQuery('')).toBe('');
  });
  it('returns empty string for whitespace-only input', () => {
    expect(normalizeSemanticQuery('   \n\t  ')).toBe('');
  });
  it('returns empty string for stop-words-only input', () => {
    expect(normalizeSemanticQuery('what is the about?')).toBe('');
  });
});

describe('normalizeSemanticQuery — strips question stop words', () => {
  it('"What documents are about HR escalation and payroll issues?" → keeps content tokens', () => {
    const out = normalizeSemanticQuery('What documents are about HR escalation and payroll issues?');
    const tokens = new Set(out.split(/\s+/));
    expect(tokens.has('hr')).toBe(true);
    expect(tokens.has('escalation')).toBe(true);
    expect(tokens.has('payroll')).toBe(true);
    // Stop words removed
    expect(tokens.has('what')).toBe(false);
    expect(tokens.has('documents')).toBe(false);
    expect(tokens.has('are')).toBe(false);
    expect(tokens.has('about')).toBe(false);
    expect(tokens.has('and')).toBe(false);
    expect(tokens.has('issues')).toBe(false);
  });

  it('"Tell me what files are about the grievance" → grievance', () => {
    const out = normalizeSemanticQuery('Tell me what files are about the grievance');
    expect(out).toBe('grievance');
  });

  it('"Show me how the payroll issue was resolved" → payroll resolved', () => {
    const out = normalizeSemanticQuery('Show me how the payroll issue was resolved');
    const tokens = out.split(/\s+/);
    expect(tokens).toContain('payroll');
    expect(tokens).toContain('resolved');
    expect(tokens).not.toContain('show');
    expect(tokens).not.toContain('me');
    expect(tokens).not.toContain('how');
    expect(tokens).not.toContain('the');
    expect(tokens).not.toContain('was');
  });
});

describe('normalizeSemanticQuery — preserves quoted phrases', () => {
  it('double-quoted phrase is preserved verbatim with FTS5 phrase syntax', () => {
    const out = normalizeSemanticQuery('What does "case number 12345" appear in the docs?');
    expect(out).toContain('"case number 12345"');
    // "what", "does", "in", "the", "docs" all stripped (note: "appear" is content, kept)
    expect(out).not.toMatch(/\bdoes\b/);
    expect(out).not.toMatch(/\bdocs\b/);
    expect(out).not.toMatch(/\bwhat\b/);
  });

  it('single-quoted phrase is preserved (re-emitted with double quotes)', () => {
    const out = normalizeSemanticQuery("show all references to 'Robert Moyes'");
    expect(out).toContain('"Robert Moyes"');
  });

  it('multiple quoted phrases each preserved', () => {
    const out = normalizeSemanticQuery('"alpha team" and "beta team" reports');
    expect(out).toContain('"alpha team"');
    expect(out).toContain('"beta team"');
    expect(out).toContain('reports');
  });

  it('content + quoted phrase mix', () => {
    const out = normalizeSemanticQuery('What about "HR escalation" please?');
    expect(out).toContain('"HR escalation"');
    expect(out).not.toContain('please');
    expect(out).not.toContain('about');
  });

  it('empty quoted phrase is dropped', () => {
    const out = normalizeSemanticQuery('what about ""');
    expect(out).toBe('');
  });
});

describe('normalizeSemanticQuery — output formatting', () => {
  it('output is lowercase for non-quoted tokens', () => {
    const out = normalizeSemanticQuery('HR Escalation Payroll');
    expect(out).toBe('hr escalation payroll');
  });

  it('quoted phrase preserves casing inside quotes', () => {
    const out = normalizeSemanticQuery('"Robert Moyes" follow-up');
    // "Robert Moyes" preserved exactly inside quotes
    expect(out).toContain('"Robert Moyes"');
    expect(out).toContain('follow');
    expect(out).toContain('up');
  });

  it('strips punctuation outside quotes', () => {
    const out = normalizeSemanticQuery('grievance, payroll; HR.');
    expect(out).toBe('grievance payroll hr');
  });

  it('preserves single tokens that are not stop words', () => {
    expect(normalizeSemanticQuery('grievance')).toBe('grievance');
  });

  it('idempotent on already-normalized input', () => {
    const once = normalizeSemanticQuery('hr escalation payroll');
    const twice = normalizeSemanticQuery(once);
    expect(twice).toBe(once);
  });
});

describe('normalizeSemanticQuery — edge cases', () => {
  it('treats unmatched/nested quotes leniently — never throws', () => {
    // The regex matches non-overlapping outer quotes. Nested or stray quotes
    // are tokenised as content. The contract is "never throw, return a
    // searchable string"; exact tokenisation of malformed inputs is
    // implementation-defined and not part of the public contract.
    expect(() => normalizeSemanticQuery('"he said "hi"" to her')).not.toThrow();
    expect(() => normalizeSemanticQuery('"open without close')).not.toThrow();
    expect(() => normalizeSemanticQuery('close without open"')).not.toThrow();
  });

  it('numbers are preserved as content tokens', () => {
    const out = normalizeSemanticQuery('What about case 12345?');
    expect(out).toContain('12345');
    expect(out).toContain('case');
  });

  it('hyphenated words split into tokens (default behavior)', () => {
    // Punctuation strip splits "follow-up" into "follow up"
    const out = normalizeSemanticQuery('follow-up notes');
    expect(out).toContain('follow');
    expect(out).toContain('up');
    expect(out).toContain('notes');
  });
});
