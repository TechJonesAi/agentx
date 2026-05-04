import { describe, it, expect, beforeEach } from 'vitest';
import { ReasoningService, type ReasoningInput, type InternetSearchProvider, type InternetResult } from '../../src/reasoning/reasoning-service.js';

function makeInput(overrides: Partial<ReasoningInput> = {}): ReasoningInput {
  return {
    query: 'test query',
    facts: [],
    bundles: [],
    contradictions: [],
    uncertainty_flags: [],
    diagnostics: { route: 'unknown', vector_used: false, fallback_used: false },
    ...overrides,
  };
}

function makeBundle(documentId: string, snippet: string) {
  return {
    document_id: documentId,
    file_name: `${documentId}.pdf`,
    evidence_items: [{
      text: snippet,
      match_type: 'fts',
      citation: { document_id: documentId, chunk_id: `${documentId}-c1`, page_number: 1, evidence_type: 'fts' },
    }],
  };
}

describe('ReasoningService — construction', () => {
  it('constructs with no args', () => {
    const r = new ReasoningService();
    expect(r).toBeDefined();
  });

  it('exposes diagnostics with initial counters', () => {
    const r = new ReasoningService();
    const d = r.getDiagnostics();
    expect(d.total_reasonings).toBe(0);
    expect(d.last_confidence).toBeNull();
    expect(d.last_validation_passed).toBeNull();
    expect(d.last_degraded).toBe(false);
  });
});

describe('ReasoningService — reason() with no evidence', () => {
  let r: ReasoningService;
  beforeEach(() => { r = new ReasoningService(); });

  it('returns insufficient evidence when bundles and facts are empty', async () => {
    const out = await r.reason(makeInput({ query: 'orphan query' }));
    expect(out.confidence.level).toBe('insufficient');
    expect(out.summary).toBeDefined();
    expect(out.internet_used).toBe(false);
  });

  it('increments total_reasonings counter', async () => {
    await r.reason(makeInput());
    await r.reason(makeInput());
    expect(r.getDiagnostics().total_reasonings).toBe(2);
  });

  it('records confidence in diagnostics after reasoning', async () => {
    await r.reason(makeInput());
    expect(r.getDiagnostics().last_confidence).toBe('insufficient');
  });
});

describe('ReasoningService — reason() with facts only', () => {
  let r: ReasoningService;
  beforeEach(() => { r = new ReasoningService(); });

  it('produces deterministic output when only facts are present', async () => {
    const out = await r.reason(makeInput({
      facts: [{ label: 'document_count', value: 7, source: 'sql:documents' }],
    }));
    expect(out).toBeDefined();
    expect(out.summary).toBeTruthy();
    expect(out.internet_used).toBe(false);
  });

  it('reflects fact source in document_findings or summary', async () => {
    const out = await r.reason(makeInput({
      query: 'how many documents do we have',
      facts: [{ label: 'document_count', value: 42, source: 'sql:documents' }],
    }));
    const allText = JSON.stringify(out);
    expect(allText).toContain('42');
  });
});

describe('ReasoningService — reason() with evidence bundles', () => {
  let r: ReasoningService;
  beforeEach(() => { r = new ReasoningService(); });

  it('summarises when bundles are present without an LLM', async () => {
    const out = await r.reason(makeInput({
      query: 'who is robert moyes',
      bundles: [
        makeBundle('doc-1', 'Robert Moyes is the company secretary'),
        makeBundle('doc-2', 'Robert Moyes signed the agreement'),
      ],
    }));
    expect(out.confidence.level).not.toBe('insufficient');
    expect(out.supporting_evidence.length).toBeGreaterThan(0);
  });

  it('preserves citations from evidence bundles', async () => {
    const out = await r.reason(makeInput({
      bundles: [makeBundle('doc-A', 'snippet text')],
    }));
    const text = JSON.stringify(out);
    expect(text).toContain('doc-A');
  });

  it('reflects validation result in diagnostics', async () => {
    await r.reason(makeInput({
      bundles: [makeBundle('doc-1', 'snippet')],
    }));
    const d = r.getDiagnostics();
    // validation result is recorded post-reason — should be a boolean (true or false), not null
    expect(d.last_validation_passed).not.toBeNull();
  });
});

describe('ReasoningService — internet provider integration', () => {
  it('does not call internet when allowInternet is false', async () => {
    let called = 0;
    const stub: InternetSearchProvider = {
      async search(): Promise<InternetResult[]> {
        called++;
        return [];
      },
    };
    const r = new ReasoningService(undefined, stub);
    await r.reason(makeInput({ bundles: [makeBundle('d', 's')] }), { allowInternet: false });
    expect(called).toBe(0);
  });

  it('does not call internet when no internet provider supplied', async () => {
    const r = new ReasoningService();
    const out = await r.reason(makeInput({ bundles: [makeBundle('d', 's')] }), { allowInternet: true });
    expect(out.internet_used).toBe(false);
  });

  it('falls back to internet-only path when allowInternet=true and bundles empty', async () => {
    const stub: InternetSearchProvider = {
      async search(): Promise<InternetResult[]> {
        return [{ snippet: 'wikipedia summary', source: 'https://en.wikipedia.org/x', title: 'X' }];
      },
    };
    const r = new ReasoningService(undefined, stub);
    const out = await r.reason(makeInput({ query: 'general knowledge q' }), { allowInternet: true });
    expect(out.internet_used).toBe(true);
    expect(out.external_context.length).toBeGreaterThan(0);
  });

  it('handles internet search failure without throwing', async () => {
    const stub: InternetSearchProvider = {
      async search(): Promise<InternetResult[]> {
        throw new Error('network down');
      },
    };
    const r = new ReasoningService(undefined, stub);
    const out = await r.reason(makeInput({ query: 'general knowledge q' }), { allowInternet: true });
    expect(out).toBeDefined();
    // it should fall through to insufficient or deterministic, but not throw
  });
});

describe('ReasoningService — output shape', () => {
  let r: ReasoningService;
  beforeEach(() => { r = new ReasoningService(); });

  it('has all required ReasoningOutput fields', async () => {
    const out = await r.reason(makeInput({ bundles: [makeBundle('d', 's')] }));
    expect(out).toHaveProperty('summary');
    expect(out).toHaveProperty('document_findings');
    expect(out).toHaveProperty('supporting_evidence');
    expect(out).toHaveProperty('contradictions');
    expect(out).toHaveProperty('external_context');
    expect(out).toHaveProperty('internet_used');
    expect(out).toHaveProperty('internet_reason');
    expect(out).toHaveProperty('interpretation');
    expect(out).toHaveProperty('practical_guidance');
    expect(out).toHaveProperty('uncertainties');
    expect(out).toHaveProperty('confidence');
    expect(out).toHaveProperty('validation');
  });

  it('confidence has level and reasons', async () => {
    const out = await r.reason(makeInput());
    expect(out.confidence).toHaveProperty('level');
    expect(['high', 'medium', 'low', 'insufficient']).toContain(out.confidence.level);
  });
});
