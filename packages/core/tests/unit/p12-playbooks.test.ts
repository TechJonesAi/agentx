/**
 * P12-3 — Playbook (success memory) tests.
 *
 * Covers: signature stability, outcome learning + confidence math,
 * recall matching + evidence gate, feedback dynamics (up strengthens,
 * down weakens and strips model bias), hint rendering, stats.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PlaybookStore, querySignature } from '../../src/memory/playbook-store.js';

describe('P12-3 querySignature', () => {
  it('is stable across word order and punctuation', () => {
    const a = querySignature('What deadlines are mentioned across my emails?');
    const b = querySignature('across my emails, what DEADLINES are mentioned??');
    expect(a).toBe(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('drops stopwords and short tokens', () => {
    const s = querySignature('what is the of to a in it');
    expect(s).toBe('');
  });
});

describe('P12-3 PlaybookStore', () => {
  let db: Database.Database;
  let store: PlaybookStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new PlaybookStore(db);
  });

  const Q = 'Summarise all references to Robert Moyes across my emails';

  it('recordOutcome creates a playbook and updates counters on repeat', () => {
    store.recordOutcome({ taskType: 'retrieval-grounded-qa', query: Q, model: 'llama3.3:70b', success: true, retrievalSource: 'fts', retrievalMatchCount: 4, responseChars: 900 });
    store.recordOutcome({ taskType: 'retrieval-grounded-qa', query: Q, model: 'llama3.3:70b', success: true, responseChars: 850 });
    const rows = store.list({ taskType: 'retrieval-grounded-qa' });
    expect(rows.length).toBe(1);
    expect(rows[0]!.use_count).toBe(2);
    expect(rows[0]!.success_count).toBe(2);
    // Laplace: (2+1)/(2+2) = 0.75
    expect(rows[0]!.confidence).toBe(0.75);
    expect(rows[0]!.approach_hint).toContain('model=llama3.3:70b');
  });

  it('findBest returns null below 2 uses (no single-accident doctrine)', () => {
    store.recordOutcome({ taskType: 'chat', query: 'hello there friend', model: 'qwen3:14b', success: true });
    expect(store.findBest('chat', 'hello there friend')).toBeNull();
  });

  it('findBest matches similar queries of the same task type', () => {
    for (let i = 0; i < 3; i++) {
      store.recordOutcome({ taskType: 'retrieval-grounded-qa', query: Q, model: 'llama3.3:70b', success: true });
    }
    const match = store.findBest('retrieval-grounded-qa', 'references to Robert Moyes in my emails please');
    expect(match).not.toBeNull();
    expect(match!.overlap).toBeGreaterThanOrEqual(0.5);
  });

  it('findBest does NOT match across task types', () => {
    for (let i = 0; i < 3; i++) {
      store.recordOutcome({ taskType: 'retrieval-grounded-qa', query: Q, model: 'llama3.3:70b', success: true });
    }
    expect(store.findBest('coding', Q)).toBeNull();
  });

  it('model bias gate requires conf ≥ 0.8 AND ≥ 3 successes', () => {
    // 2 successes → (2+1)/(2+2)=0.75 < 0.8 → not eligible
    store.recordOutcome({ taskType: 'summarisation', query: 'summarise the quarterly board report content', model: 'qwen3:14b', success: true });
    store.recordOutcome({ taskType: 'summarisation', query: 'summarise the quarterly board report content', model: 'qwen3:14b', success: true });
    let m = store.findBest('summarisation', 'summarise the quarterly board report content');
    expect(m!.modelBiasEligible).toBe(false);
    // 4 successes → (4+1)/(4+2)=0.83 ≥ 0.8, successes ≥ 3 → eligible
    store.recordOutcome({ taskType: 'summarisation', query: 'summarise the quarterly board report content', model: 'qwen3:14b', success: true });
    store.recordOutcome({ taskType: 'summarisation', query: 'summarise the quarterly board report content', model: 'qwen3:14b', success: true });
    m = store.findBest('summarisation', 'summarise the quarterly board report content');
    expect(m!.modelBiasEligible).toBe(true);
    expect(m!.playbook.model).toBe('qwen3:14b');
  });

  it('positive feedback strengthens confidence', () => {
    store.recordOutcome({ taskType: 'chat', query: 'tell me a joke about typescript programming', model: 'qwen3:14b', success: true });
    store.recordOutcome({ taskType: 'chat', query: 'tell me a joke about typescript programming', model: 'qwen3:14b', success: true });
    const before = store.list()[0]!.confidence;
    const applied = store.applyFeedback('chat', 'tell me a joke about typescript programming', true);
    expect(applied).toBe(true);
    expect(store.list()[0]!.confidence).toBeGreaterThan(before);
  });

  it('negative feedback weakens confidence and strips model bias below 0.4', () => {
    store.recordOutcome({ taskType: 'chat', query: 'weather chat about rainy days outside', model: 'qwen3:14b', success: true });
    store.recordOutcome({ taskType: 'chat', query: 'weather chat about rainy days outside', model: 'qwen3:14b', success: true });
    // Two hard downvotes: uses 2→6, successes stay 2 → (2+1)/(6+2)=0.38 < 0.4
    store.applyFeedback('chat', 'weather chat about rainy days outside', false);
    store.applyFeedback('chat', 'weather chat about rainy days outside', false);
    const row = store.list()[0]!;
    expect(row.confidence).toBeLessThan(0.4);
    expect(row.model).toBeNull(); // bias stripped
  });

  it('applyFeedback returns false when no matching playbook exists', () => {
    expect(store.applyFeedback('chat', 'completely novel unseen question here', true)).toBe(false);
  });

  it('renderHintBlock is capped and mentions the success ratio', () => {
    for (let i = 0; i < 3; i++) {
      store.recordOutcome({ taskType: 'chat', query: 'greetings and salutations dear machine', model: 'qwen3:14b', success: true, responseChars: 100 });
    }
    const m = store.findBest('chat', 'greetings and salutations dear machine')!;
    const block = store.renderHintBlock(m);
    expect(block.length).toBeLessThanOrEqual(300);
    expect(block).toContain('3/3 past successes');
  });

  it('getStats aggregates', () => {
    store.recordOutcome({ taskType: 'chat', query: 'alpha beta gamma delta epsilon words', model: 'm1', success: true });
    store.recordOutcome({ taskType: 'coding', query: 'refactor the parser function implementation cleanly', model: 'm2', success: true });
    const s = store.getStats();
    expect(s.playbooks).toBe(2);
    expect(s.totalUses).toBe(2);
    expect(s.avgConfidence).toBeGreaterThan(0);
  });
});
