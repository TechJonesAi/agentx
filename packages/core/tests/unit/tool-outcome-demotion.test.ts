/**
 * ToolOutcomeStore.demotedTools() — Batch 2 self-learning → routing influence.
 *
 * Tools that consistently fail must be demoted from the offered set in
 * subsequent provider calls. The store reports which tools should be
 * dropped given a configurable window + threshold.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolOutcomeStore } from '../../src/observability/tool-outcome-store.js';

let store: ToolOutcomeStore;
beforeEach(() => { store = ToolOutcomeStore.__createForTest(); });

describe('ToolOutcomeStore.demotedTools()', () => {
  it('returns empty when window has not been reached', () => {
    for (let i = 0; i < 9; i++) store.record('a', '[a error]: fail', 1);
    expect(store.demotedTools({ window: 10 })).toEqual([]);
  });

  it('returns a tool whose last 10 calls are <50% success', () => {
    for (let i = 0; i < 4; i++) store.record('flaky', 'ok', 1);
    for (let i = 0; i < 6; i++) store.record('flaky', '[flaky error]: x', 1);
    const out = store.demotedTools({ window: 10, threshold: 0.5 });
    expect(out).toHaveLength(1);
    expect(out[0]?.toolName).toBe('flaky');
    expect(out[0]?.recentSuccessRate).toBeCloseTo(0.4, 5);
  });

  it('does NOT demote a tool above threshold', () => {
    for (let i = 0; i < 6; i++) store.record('healthy', 'ok', 1);
    for (let i = 0; i < 4; i++) store.record('healthy', '[healthy error]: x', 1);
    expect(store.demotedTools({ window: 10, threshold: 0.5 })).toEqual([]);
  });

  it('considers only the most recent <window> calls — a tool that recovered does NOT demote', () => {
    for (let i = 0; i < 8; i++) store.record('reborn', '[reborn error]: x', 1);
    for (let i = 0; i < 10; i++) store.record('reborn', 'ok', 1);
    expect(store.demotedTools({ window: 10, threshold: 0.5 })).toEqual([]);
  });

  it('lists multiple tools when several breach threshold, sorted alphabetically', () => {
    for (let i = 0; i < 10; i++) store.record('zebra', '[zebra error]: x', 1);
    for (let i = 0; i < 10; i++) store.record('alpha', '[alpha error]: x', 1);
    const out = store.demotedTools({ window: 10, threshold: 0.5 });
    expect(out.map(o => o.toolName)).toEqual(['alpha', 'zebra']);
  });

  it('threshold is configurable — 0.9 demotes more aggressively', () => {
    for (let i = 0; i < 7; i++) store.record('ok-mostly', 'ok', 1);
    for (let i = 0; i < 3; i++) store.record('ok-mostly', '[ok-mostly error]: x', 1);
    // 70% success
    expect(store.demotedTools({ window: 10, threshold: 0.5 })).toEqual([]);
    expect(store.demotedTools({ window: 10, threshold: 0.9 })).toHaveLength(1);
  });
});
