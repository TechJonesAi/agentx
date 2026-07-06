/**
 * P13-B1 — Semantic memory tests (fake embedder, no network).
 *
 * The fake embedder maps known phrases to fixed unit vectors so cosine
 * behaviour is deterministic:
 *   dismissal-related  → [1, 0]
 *   weather-related    → [0, 1]
 *   mixed/unknown      → [0.7, 0.7] (normalised-ish)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PlaybookStore } from '../../src/memory/playbook-store.js';
import { ContinuousContextStore } from '../../src/memory/continuous-context.js';
import { cosineSim, vecToBuffer, bufferToVec } from '../../src/llm/ollama-embedder.js';

function fakeEmbed(text: string): number[] {
  const t = text.toLowerCase();
  if (t.includes('dismiss') || t.includes('unfair') || t.includes('termination') || t.includes('exposure')) return [1, 0];
  if (t.includes('weather') || t.includes('rain')) return [0, 1];
  return [0.5, 0.5];
}
const fakeEmbedder = async (texts: string[]) => texts.map(fakeEmbed);
const brokenEmbedder = async (_texts: string[]) => null;

// Let fire-and-forget embedding writes settle.
const settle = () => new Promise((r) => setTimeout(r, 30));

describe('P13-B1 embedder helpers', () => {
  it('cosineSim basics', () => {
    expect(cosineSim([1, 0], [1, 0])).toBe(1);
    expect(cosineSim([1, 0], [0, 1])).toBe(0);
    expect(cosineSim([], [1])).toBe(0);
  });

  it('vecToBuffer round-trips', () => {
    const v = [0.25, -1.5, 3];
    const back = bufferToVec(vecToBuffer(v));
    expect(back.length).toBe(3);
    expect(back[0]).toBeCloseTo(0.25);
    expect(back[1]).toBeCloseTo(-1.5);
  });
});

describe('P13-B1 semantic playbook recall', () => {
  let db: Database.Database;
  let store: PlaybookStore;

  beforeEach(async () => {
    db = new Database(':memory:');
    store = new PlaybookStore(db);
    store.setEmbedder(fakeEmbedder);
    // Train: dismissal playbook (3 successes → conf 0.8, bias-eligible)
    for (let i = 0; i < 3; i++) {
      store.recordOutcome({
        taskType: 'retrieval-grounded-qa',
        query: 'What is my strongest argument against dismissal?',
        model: 'llama3.3:70b',
        success: true,
      });
    }
    await settle();
  });

  it('matches semantically related query with DIFFERENT words', async () => {
    // "exposure on the unfair termination claim" shares NO content words
    // with the trained query — keyword Jaccard would miss it entirely.
    const m = await store.findBestSemantic(
      'retrieval-grounded-qa',
      'What is my exposure on the unfair termination claim?',
    );
    expect(m).not.toBeNull();
    expect(m!.overlap).toBeGreaterThanOrEqual(0.75);
    expect(m!.playbook.model).toBe('llama3.3:70b');
  });

  it('keyword matcher alone does NOT match the reworded query (proves semantic value)', () => {
    const m = store.findBest(
      'retrieval-grounded-qa',
      'What is my exposure on the unfair termination claim?',
    );
    expect(m).toBeNull();
  });

  it('does not match semantically unrelated queries', async () => {
    const m = await store.findBestSemantic('retrieval-grounded-qa', 'Will it rain this weekend, weather-wise?');
    expect(m).toBeNull();
  });

  it('falls back to keyword when embedder returns null', async () => {
    const db2 = new Database(':memory:');
    const s2 = new PlaybookStore(db2);
    s2.setEmbedder(brokenEmbedder);
    for (let i = 0; i < 2; i++) {
      s2.recordOutcome({ taskType: 'chat', query: 'greetings salutations dear machine friend', model: 'm', success: true });
    }
    await settle();
    const m = await s2.findBestSemantic('chat', 'greetings salutations dear machine friend');
    expect(m).not.toBeNull(); // keyword path rescued it
  });

  it('works with no embedder at all (pure keyword)', async () => {
    const db3 = new Database(':memory:');
    const s3 = new PlaybookStore(db3);
    for (let i = 0; i < 2; i++) {
      s3.recordOutcome({ taskType: 'chat', query: 'alpha beta gamma delta words here', model: 'm', success: true });
    }
    const m = await s3.findBestSemantic('chat', 'alpha beta gamma delta words here');
    expect(m).not.toBeNull();
  });
});

describe('P13-B1 semantic archive search', () => {
  it('finds semantically related archived turns; merges with keyword', async () => {
    const db = new Database(':memory:');
    const cc = new ContinuousContextStore(db);
    cc.setEmbedder(fakeEmbedder);
    cc.archiveCompactedTurns('s1', [
      { role: 'user', content: 'We discussed the dismissal case strategy at length', timestamp: 1000 },
      { role: 'assistant', content: 'The rain forecast for the weekend looks poor', timestamp: 2000 },
    ], null, 'b1');
    await settle();
    const hits = await cc.searchArchiveSemantic('unfair termination exposure', 3);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('dismissal');
    // The weather turn must not outrank the dismissal turn
    expect(hits[0]!.content).not.toContain('rain');
  });

  it('falls back to keyword search when embedder is unset', async () => {
    const db = new Database(':memory:');
    const cc = new ContinuousContextStore(db);
    cc.archiveCompactedTurns('s1', [
      { role: 'user', content: 'The witness statement from Penny needs review', timestamp: 1000 },
    ], null, 'b1');
    const hits = await cc.searchArchiveSemantic('witness statement Penny', 3);
    expect(hits.length).toBeGreaterThan(0);
  });
});
