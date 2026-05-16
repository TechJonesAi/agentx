/**
 * RetrievalOutcomeStore unit tests — Batch 2 verification.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { RetrievalOutcomeStore } from '../../src/observability/retrieval-outcome-store.js';

let store: RetrievalOutcomeStore;

beforeEach(() => {
  store = RetrievalOutcomeStore.__createForTest();
});

describe('RetrievalOutcomeStore — record + reliability', () => {
  it('records success with match count and latency', () => {
    store.record({
      query: 'what is X',
      success: true,
      matchCount: 3,
      sufficient: true,
      fallbackUsed: false,
      latencyMs: 42,
      sourceTypes: ['fts'],
      groundedAnswer: null,
    });
    const list = store.recent(5);
    expect(list).toHaveLength(1);
    expect(list[0]?.success).toBe(true);
    expect(list[0]?.matchCount).toBe(3);
  });

  it('computes reliability stats correctly', () => {
    for (let i = 0; i < 3; i++) {
      store.record({ query: 'q', success: true, matchCount: 2, sufficient: true, fallbackUsed: false, latencyMs: 10, sourceTypes: ['fts'], groundedAnswer: null });
    }
    store.record({ query: 'q', success: false, matchCount: 0, sufficient: false, fallbackUsed: true, latencyMs: 50, sourceTypes: [], groundedAnswer: null, failureReason: 'no hits' });
    const r = store.reliability();
    expect(r.totalCalls).toBe(4);
    expect(r.successCount).toBe(3);
    expect(r.failureCount).toBe(1);
    expect(r.successRate).toBeCloseTo(0.75, 5);
    expect(r.avgMatchCount).toBe(1.5);
    expect(r.avgLatencyMs).toBe(20);
    expect(r.sufficientCount).toBe(3);
    expect(r.fallbackCount).toBe(1);
    expect(r.lastFailureReason).toBe('no hits');
  });

  it('returns zeroes when empty', () => {
    const r = store.reliability();
    expect(r.totalCalls).toBe(0);
    expect(r.successRate).toBe(0);
  });

  it('topSources counts only successful calls and sorts descending', () => {
    store.record({ query: 'q', success: true, matchCount: 1, sufficient: true, fallbackUsed: false, latencyMs: 1, sourceTypes: ['fts'], groundedAnswer: null });
    store.record({ query: 'q', success: true, matchCount: 1, sufficient: true, fallbackUsed: false, latencyMs: 1, sourceTypes: ['fts', 'vector'], groundedAnswer: null });
    store.record({ query: 'q', success: false, matchCount: 0, sufficient: false, fallbackUsed: false, latencyMs: 1, sourceTypes: ['sql'], groundedAnswer: null });
    const top = store.topSources();
    expect(top[0]).toEqual({ source: 'fts', count: 2 });
    expect(top.find(t => t.source === 'sql')).toBeUndefined();
  });

  it('clear() empties the store', () => {
    store.record({ query: 'q', success: true, matchCount: 1, sufficient: true, fallbackUsed: false, latencyMs: 1, sourceTypes: [], groundedAnswer: null });
    expect(store.size()).toBe(1);
    store.clear();
    expect(store.size()).toBe(0);
  });
});
