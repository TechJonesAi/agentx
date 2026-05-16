/**
 * ToolOutcomeStore unit tests — Batch 1 verification checkpoint.
 *
 * Coverage:
 *  - record() captures success and failure outcomes
 *  - failure detection heuristic matches "[<tool> error]:" and "[Blocked]"
 *  - latency stored as-is
 *  - reliability() rolls up per-tool success rate and avg latency
 *  - recent() returns newest-first up to limit
 *  - clear() empties the store
 *  - JSON-safe snapshot (no circular refs, no functions)
 *  - ring buffer cap respected
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolOutcomeStore } from '../../src/observability/tool-outcome-store.js';

let store: ToolOutcomeStore;

beforeEach(() => {
  store = ToolOutcomeStore.__createForTest();
});

describe('ToolOutcomeStore — record()', () => {
  it('records a success when result has no error prefix', () => {
    store.record('shell', 'ok output here', 42);
    const r = store.recent(1)[0]!;
    expect(r.toolName).toBe('shell');
    expect(r.success).toBe(true);
    expect(r.latencyMs).toBe(42);
    expect(r.failureReason).toBeUndefined();
    expect(r.resultPreview).toBe('ok output here');
  });

  it('records a failure when result starts with "[<tool> error]:"', () => {
    store.record('shell', '[shell error]: command not found', 10);
    const r = store.recent(1)[0]!;
    expect(r.success).toBe(false);
    expect(r.failureReason).toContain('command not found');
  });

  it('records a failure when result starts with "[Blocked]"', () => {
    store.record('shell', '[Blocked]: command matches blocked pattern', 10);
    const r = store.recent(1)[0]!;
    expect(r.success).toBe(false);
  });

  it('handles generic error prefix without tool name', () => {
    store.record('foo', '[error]: something', 5);
    const r = store.recent(1)[0]!;
    expect(r.success).toBe(false);
  });

  it('truncates resultPreview to 200 chars', () => {
    const long = 'x'.repeat(500);
    store.record('shell', long, 1);
    const r = store.recent(1)[0]!;
    expect(r.resultPreview.length).toBe(200);
  });
});

describe('ToolOutcomeStore — reliability()', () => {
  it('computes per-tool success rate and avg latency', () => {
    store.record('shell', 'ok', 10);
    store.record('shell', 'ok', 20);
    store.record('shell', '[shell error]: boom', 30);
    store.record('write_file', 'ok', 50);

    const rel = store.reliability();
    const shell = rel.find(r => r.toolName === 'shell')!;
    const writeFile = rel.find(r => r.toolName === 'write_file')!;

    expect(shell.totalCalls).toBe(3);
    expect(shell.successCount).toBe(2);
    expect(shell.failureCount).toBe(1);
    expect(shell.successRate).toBeCloseTo(2 / 3, 5);
    expect(shell.avgLatencyMs).toBe(20);     // (10+20+30)/3
    expect(shell.lastFailureReason).toContain('boom');

    expect(writeFile.totalCalls).toBe(1);
    expect(writeFile.successRate).toBe(1);
  });

  it('returns empty array when no outcomes recorded', () => {
    expect(store.reliability()).toEqual([]);
  });

  it('sorts reliability rollups by totalCalls descending', () => {
    store.record('a', 'ok', 1);
    store.record('b', 'ok', 1);
    store.record('b', 'ok', 1);
    store.record('b', 'ok', 1);
    store.record('c', 'ok', 1);
    store.record('c', 'ok', 1);
    const names = store.reliability().map(r => r.toolName);
    expect(names).toEqual(['b', 'c', 'a']);
  });
});

describe('ToolOutcomeStore — recent() + clear()', () => {
  it('returns newest-first', () => {
    store.record('a', 'ok', 1);
    store.record('b', 'ok', 1);
    const list = store.recent(10);
    expect(list[0]?.toolName).toBe('b');
    expect(list[1]?.toolName).toBe('a');
  });

  it('respects limit', () => {
    for (let i = 0; i < 10; i++) store.record('a', 'ok', 1);
    expect(store.recent(3)).toHaveLength(3);
  });

  it('clear() removes all entries', () => {
    store.record('a', 'ok', 1);
    store.record('b', 'ok', 1);
    expect(store.size()).toBe(2);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.recent(10)).toEqual([]);
    expect(store.reliability()).toEqual([]);
  });
});

describe('ToolOutcomeStore — JSON snapshot safety', () => {
  it('reliability + recent are JSON-serializable without throw', () => {
    store.record('a', 'ok', 1);
    store.record('a', '[a error]: x', 2);
    const payload = { reliability: store.reliability(), recent: store.recent(10) };
    expect(() => JSON.stringify(payload)).not.toThrow();
    const round = JSON.parse(JSON.stringify(payload));
    expect(round.reliability).toHaveLength(1);
    expect(round.recent).toHaveLength(2);
  });
});

describe('ToolOutcomeStore — ring buffer cap', () => {
  it('caps stored entries at MAX_ENTRIES (500) — dropping oldest first', () => {
    for (let i = 0; i < 600; i++) {
      store.record('shell', `entry-${i}`, 1);
    }
    expect(store.size()).toBeLessThanOrEqual(500);
    // Most recent must still be present
    const newest = store.recent(1)[0]!;
    expect(newest.resultPreview).toBe('entry-599');
  });
});
