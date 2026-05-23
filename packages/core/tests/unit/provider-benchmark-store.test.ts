/**
 * ProviderBenchmarkStore — Batch 9 evidence-based routing input.
 *
 * Covers:
 *   - record() + recent() round-trip per category
 *   - filtering by category and provider
 *   - compare() picks highest avgScore with latency tiebreaker
 *   - compare() returns null winner when below minSamples
 *   - compare() surfaces human-readable reasons
 *   - taskCategories() lists distinct values
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { ProviderBenchmarkStore } from '../../src/observability/provider-benchmark-store.js';

const SLOW_IO = 60_000;

let tmpDir: string;
let db: Database.Database;
let store: ProviderBenchmarkStore;

function applyMigration(d: Database.Database): void {
  const sql = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/009_provider_benchmarks.sql'), 'utf-8');
  d.exec(sql);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-bench-'));
  db = new Database(path.join(tmpDir, 'b.db'));
  applyMigration(db);
  store = ProviderBenchmarkStore.__createForTest(db);
}, SLOW_IO);

afterEach(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
}, SLOW_IO);

describe('record + recent', () => {
  it('round-trips a benchmark row with full field set', () => {
    const row = store.record({
      taskCategory: 'coding',
      provider: 'ollama',
      model: 'qwen2.5-coder:32b',
      ttftMs: 80, totalLatencyMs: 1200, tokensPerSec: 25,
      jsonValid: true, toolCallValid: true,
      groundedScore: 0.9, retryCount: 0, score: 0.85,
      notes: 'first sample',
    });
    expect(row.benchmarkId).toMatch(/^bm-/);
    const list = store.recent(10);
    expect(list).toHaveLength(1);
    expect(list[0]?.provider).toBe('ollama');
    expect(list[0]?.jsonValid).toBe(true);
    expect(list[0]?.score).toBe(0.85);
  }, SLOW_IO);

  it('filters by category + provider', () => {
    store.record({ taskCategory: 'coding', provider: 'ollama', model: 'a', score: 0.6 });
    store.record({ taskCategory: 'coding', provider: 'omlx', model: 'b', score: 0.7 });
    store.record({ taskCategory: 'summarisation', provider: 'ollama', model: 'a', score: 0.5 });

    expect(store.recent(10, 'coding')).toHaveLength(2);
    expect(store.recent(10, 'coding', 'omlx')).toHaveLength(1);
    expect(store.recent(10, undefined, 'ollama')).toHaveLength(2);
  }, SLOW_IO);
});

describe('compare', () => {
  it('returns null winner when below minSamples', () => {
    store.record({ taskCategory: 'coding', provider: 'omlx', model: 'a', score: 0.95 });
    const c = store.compare('coding', { minSamples: 3 });
    expect(c.winner).toBeNull();
    expect(c.reasons[0]).toContain('no provider has >= 3 samples');
  }, SLOW_IO);

  it('picks the provider with highest avgScore', () => {
    // ollama averages 0.5, omlx averages 0.8 — omlx must win.
    for (const s of [0.4, 0.5, 0.6]) store.record({ taskCategory: 'tool-calling', provider: 'ollama', model: 'a', score: s });
    for (const s of [0.7, 0.8, 0.9]) store.record({ taskCategory: 'tool-calling', provider: 'omlx', model: 'b', score: s });

    const c = store.compare('tool-calling', { minSamples: 3 });
    expect(c.winner).toBe('omlx');
    expect(c.reasons.some(r => r.includes('omlx highest avg score'))).toBe(true);
    expect(c.reasons.some(r => r.includes('runner-up'))).toBe(true);
  }, SLOW_IO);

  it('uses lower avgLatencyMs as tiebreaker when scores are equal', () => {
    for (const lat of [100, 110, 90]) store.record({ taskCategory: 'chat', provider: 'omlx', model: 'fast', score: 0.7, totalLatencyMs: lat });
    for (const lat of [500, 550, 600]) store.record({ taskCategory: 'chat', provider: 'ollama', model: 'slow', score: 0.7, totalLatencyMs: lat });
    const c = store.compare('chat', { minSamples: 3 });
    expect(c.winner).toBe('omlx');
    expect(c.reasons.some(r => r.includes('also faster'))).toBe(true);
  }, SLOW_IO);

  it('returns null winner when no samples exist for category', () => {
    const c = store.compare('does-not-exist');
    expect(c.winner).toBeNull();
    expect(c.perProvider).toEqual([]);
  }, SLOW_IO);
});

describe('taskCategories + size', () => {
  it('lists distinct categories with samples', () => {
    store.record({ taskCategory: 'coding', provider: 'a', model: 'x', score: 0.5 });
    store.record({ taskCategory: 'reasoning', provider: 'a', model: 'x', score: 0.5 });
    store.record({ taskCategory: 'coding', provider: 'b', model: 'y', score: 0.5 });
    expect(store.taskCategories().sort()).toEqual(['coding', 'reasoning']);
    expect(store.size()).toBe(3);
  }, SLOW_IO);
});
