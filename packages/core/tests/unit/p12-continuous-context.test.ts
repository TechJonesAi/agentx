/**
 * P12-2 — Continuous Context tests.
 *
 * Covers:
 *   - Archive: compacted turns + summary persisted, deduped by batch,
 *     searchable via FTS (and LIKE fallback shape).
 *   - Bridge: recap built from latest summary + recent decisions;
 *     null on empty store; excludes current session's own summary.
 *   - Journal: record + list + kind filter; never throws on bad input.
 *   - ContextManager archive sink: fires on summarisation with a
 *     stable batch id; sink errors are swallowed.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { ContinuousContextStore } from '../../src/memory/continuous-context.js';
import { ContextManager } from '../../src/context-manager.js';
import type { Message } from '../../src/types.js';

function msg(role: Message['role'], content: string, ts: number): Message {
  return { role, content, timestamp: ts };
}

describe('P12-2 ContinuousContextStore', () => {
  let db: Database.Database;
  let store: ContinuousContextStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new ContinuousContextStore(db);
  });

  it('archives compacted turns + summary and dedupes by batch id', () => {
    const turns = [
      msg('user', 'We agreed the tribunal deadline is 14 March', 1000),
      msg('assistant', 'Noted: tribunal deadline 14 March, bundle due 7 days before.', 2000),
    ];
    const r1 = store.archiveCompactedTurns('s1', turns, 'Deadline discussion: tribunal 14 March.', 'batch-1');
    expect(r1.archived).toBe(3); // 2 turns + 1 summary
    const r2 = store.archiveCompactedTurns('s1', turns, 'Deadline discussion: tribunal 14 March.', 'batch-1');
    expect(r2.archived).toBe(0); // dedupe
    expect(store.getStats().archivedTurns).toBe(2);
    expect(store.getStats().summaries).toBe(1);
  });

  it('searchArchive finds archived content by keyword', () => {
    store.archiveCompactedTurns('s1', [
      msg('user', 'The witness statement from Penny Frisby needs review', 1000),
    ], null, 'b1');
    const hits = store.searchArchive('witness statement Penny');
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.content).toContain('Penny Frisby');
  });

  it('searchArchive returns [] for tiny queries', () => {
    expect(store.searchArchive('ab')).toEqual([]);
  });

  it('getBridgeContext returns null on a virgin store', () => {
    expect(store.getBridgeContext()).toBeNull();
  });

  it('getBridgeContext returns latest summary + recent decisions', () => {
    store.archiveCompactedTurns('old-session', [msg('user', 'x'.repeat(20), 1)], 'Session about tribunal prep.', 'b1');
    store.recordDecision('compaction', 'Compacted 10 turns', { n: 10 }, 'old-session');
    const bridge = store.getBridgeContext('new-session');
    expect(bridge).not.toBeNull();
    expect(bridge!.lastSummary).toContain('tribunal prep');
    expect(bridge!.lastSessionId).toBe('old-session');
    expect(bridge!.recentDecisions.length).toBeGreaterThan(0);
  });

  it('getBridgeContext excludes the current session own summary', () => {
    store.archiveCompactedTurns('current', [msg('user', 'y'.repeat(20), 1)], 'Current session summary.', 'b1');
    const bridge = store.getBridgeContext('current');
    // Only decision entries could remain — summary must not leak back
    expect(bridge?.lastSummary ?? null).toBeNull();
  });

  it('renderBridgeBlock caps output length', () => {
    store.archiveCompactedTurns('s1', [msg('user', 'z'.repeat(20), 1)], 'S'.repeat(5000), 'b1');
    const bridge = store.getBridgeContext('other')!;
    const block = store.renderBridgeBlock(bridge);
    expect(block.length).toBeLessThanOrEqual(1200);
    expect(block).toContain('[Previous session recap]');
  });

  it('decision journal records + lists + filters by kind', () => {
    store.recordDecision('safe_failure', 'Refused: doc not found', { doc: 'X.pdf' }, 's1');
    store.recordDecision('compaction', 'Compacted 5 turns', undefined, 's1');
    expect(store.listDecisions().length).toBe(2);
    const safe = store.listDecisions({ kind: 'safe_failure' });
    expect(safe.length).toBe(1);
    expect(safe[0]!.title).toContain('Refused');
    expect(JSON.parse(safe[0]!.detail_json!)).toEqual({ doc: 'X.pdf' });
  });

  it('recordDecision truncates oversized payloads instead of throwing', () => {
    expect(() =>
      store.recordDecision('error', 'T'.repeat(10_000), { blob: 'B'.repeat(100_000) }),
    ).not.toThrow();
    const rows = store.listDecisions({ kind: 'error' });
    expect(rows[0]!.title.length).toBeLessThanOrEqual(300);
    expect(rows[0]!.detail_json!.length).toBeLessThanOrEqual(4000);
  });
});

describe('P12-2 ContextManager archive sink', () => {
  it('fires the sink with a stable batch id when summarisation occurs', async () => {
    const cm = new ContextManager('ollama', {
      maxContextTokens: 300,
      reservedOutputTokens: 50,
      systemPromptTokens: 50,
      keepRecentMessages: 2,
    });
    cm.setSummarizer(async () => 'summary of older turns');
    const captured: Array<{ sessionId: string; count: number; summary: string | null; batchId: string }> = [];
    cm.setArchiveSink((sessionId, older, summary, batchId) => {
      captured.push({ sessionId, count: older.length, summary, batchId });
    });

    // Enough messages to exceed the tiny budget
    const messages: Message[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(msg(i % 2 === 0 ? 'user' : 'assistant', `message number ${i} with some padding text to inflate tokens`, 1000 + i));
    }
    const result = await cm.prepareContext('sess-1', messages);
    expect(result.wasTruncated).toBe(true);
    expect(captured.length).toBe(1);
    expect(captured[0]!.sessionId).toBe('sess-1');
    expect(captured[0]!.count).toBe(10); // 12 - keepRecent(2)
    expect(captured[0]!.summary).toBe('summary of older turns');
    expect(captured[0]!.batchId).toContain('sess-1:');
  });

  it('sink errors are swallowed — prepareContext still succeeds', async () => {
    const cm = new ContextManager('ollama', {
      maxContextTokens: 300,
      reservedOutputTokens: 50,
      systemPromptTokens: 50,
      keepRecentMessages: 2,
    });
    cm.setSummarizer(async () => 'summary');
    cm.setArchiveSink(() => { throw new Error('sink exploded'); });
    const messages: Message[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(msg('user', `padding message ${i} with enough words to overflow the small budget`, i));
    }
    const result = await cm.prepareContext('sess-2', messages);
    expect(result.wasTruncated).toBe(true);
    expect(result.summaryAdded).toBe(true);
  });

  it('no sink configured → identical legacy behaviour', async () => {
    const cm = new ContextManager('ollama', {
      maxContextTokens: 300,
      reservedOutputTokens: 50,
      systemPromptTokens: 50,
      keepRecentMessages: 2,
    });
    cm.setSummarizer(async () => 'summary');
    const messages: Message[] = [];
    for (let i = 0; i < 12; i++) {
      messages.push(msg('user', `padding message ${i} with enough words to overflow the small budget`, i));
    }
    const result = await cm.prepareContext('sess-3', messages);
    expect(result.wasTruncated).toBe(true);
    expect(result.summaryAdded).toBe(true);
  });
});
