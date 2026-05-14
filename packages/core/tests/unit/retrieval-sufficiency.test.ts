/**
 * Batch A2 — Retrieval-sufficiency heuristic.
 *
 * Pure-function tests. No DB, no agent — the helper takes query + metadata
 * and returns a deterministic decision so the policy gate can be unit-tested
 * in isolation.
 */
import { describe, it, expect } from 'vitest';
import {
  assessRetrievalSufficiency,
  extractQueryTerms,
} from '../../src/reasoning/retrieval-sufficiency.js';

describe('extractQueryTerms', () => {
  it('lower-cases, splits on non-alphanum, and drops short/stopword tokens', () => {
    expect(extractQueryTerms('What is the LOCAL builder codename?')).toEqual(['local', 'builder', 'codename']);
  });
  it('deduplicates within a single query', () => {
    expect(extractQueryTerms('handbook handbook BOOK book Handbook')).toEqual(['handbook', 'book']);
  });
  it('returns empty for stopword-only or short-token-only queries', () => {
    expect(extractQueryTerms('what is the?')).toEqual([]);
    expect(extractQueryTerms('a b c')).toEqual([]);
  });
});

describe('assessRetrievalSufficiency', () => {
  it('sufficient — single doc with snippet hit', () => {
    const d = assessRetrievalSufficiency({
      query: 'private memory passphrase handbook',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'doc-A',
        file_name: 'AgentXPrivateMemoryHandbook.pdf',
        title: 'AgentX Private Memory Handbook',
        snippet: 'the private memory passphrase is BLUE LANTERN 47',
      }],
    });
    expect(d.sufficient).toBe(true);
    expect(d.reason).toBe('snippet_overlap');
    expect(d.matchedDocumentIds).toEqual(['doc-A']);
    expect(d.matchedTerms.sort()).toEqual(['handbook', 'memory', 'passphrase', 'private']);
    expect(d.score).toBe(1);
  });

  it('insufficient — zero matches', () => {
    const d = assessRetrievalSufficiency({
      query: 'private memory passphrase handbook',
      retrievalMatchCount: 0,
      retrievalDocuments: [],
    });
    expect(d.sufficient).toBe(false);
    expect(d.reason).toBe('no_match');
    expect(d.score).toBe(0);
  });

  it('insufficient — retrievalMatchCount=0 with stale doc array', () => {
    const d = assessRetrievalSufficiency({
      query: 'something',
      retrievalMatchCount: 0,
      retrievalDocuments: [{ document_id: 'x', file_name: 'x.txt' }],
    });
    expect(d.sufficient).toBe(false);
    expect(d.reason).toBe('no_match');
  });

  it('insufficient — irrelevant doc (no term overlap)', () => {
    const d = assessRetrievalSufficiency({
      query: 'private memory passphrase handbook',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'doc-X',
        file_name: 'recipes.txt',
        title: 'Cooking Notes',
        snippet: 'butter sugar flour eggs vanilla',
      }],
    });
    expect(d.sufficient).toBe(false);
    expect(d.reason).toBe('no_term_overlap');
    expect(d.matchedDocumentIds).toEqual([]);
  });

  it('sufficient via title/file_name even when snippet missing', () => {
    const d = assessRetrievalSufficiency({
      query: 'tribunal handbook section',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'doc-T',
        file_name: 'EmploymentTribunalHandbook2025.pdf',
        title: 'Employment Tribunal Handbook 2025',
        // no snippet
      }],
    });
    expect(d.sufficient).toBe(true);
    expect(d.reason).toBe('title_or_filename_overlap');
    expect(d.matchedDocumentIds).toEqual(['doc-T']);
  });

  it('stopwords are ignored — query of only stopwords is no_meaningful_terms', () => {
    const d = assessRetrievalSufficiency({
      query: 'what is the from with and?',
      retrievalMatchCount: 1,
      retrievalDocuments: [{ document_id: 'd', file_name: 'd.txt', snippet: 'anything' }],
    });
    expect(d.sufficient).toBe(false);
    expect(d.reason).toBe('no_meaningful_terms');
  });

  it('partial coverage — score reflects fraction of docs that matched', () => {
    const d = assessRetrievalSufficiency({
      query: 'handbook tribunal',
      retrievalMatchCount: 2,
      retrievalDocuments: [
        { document_id: 'doc-A', file_name: 'x.txt', snippet: 'recipe ingredients' },
        { document_id: 'doc-B', file_name: 'TribunalHandbook.pdf', title: 'Tribunal Handbook' },
      ],
    });
    expect(d.sufficient).toBe(true);
    expect(d.matchedDocumentIds).toEqual(['doc-B']);
    expect(d.score).toBeCloseTo(0.5);
  });

  it('does not crash on null sender / missing fields', () => {
    const d = assessRetrievalSufficiency({
      query: 'project code',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'doc-E',
        file_name: 'email.eml',
        sender: null,
        snippet: 'the project code is X',
      }],
    });
    expect(d.sufficient).toBe(true);
  });
});
