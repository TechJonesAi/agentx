/**
 * TelemetryStore — Batch 5 perf metrics.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryStore } from '../../src/observability/telemetry-store.js';

let store: TelemetryStore;
beforeEach(() => { store = TelemetryStore.__createForTest(); });

describe('TelemetryStore.record + recent', () => {
  it('records entries newest-first via recent()', () => {
    store.record({ kind: 'llm.stream', label: 'm1', latencyMs: 100 });
    store.record({ kind: 'llm.stream', label: 'm2', latencyMs: 200 });
    const list = store.recent(2);
    expect(list[0]?.label).toBe('m2');
    expect(list[1]?.label).toBe('m1');
  });

  it('filters recent() by kind when provided', () => {
    store.record({ kind: 'llm.stream', label: 'a', latencyMs: 10 });
    store.record({ kind: 'ocr.extract', label: 'b', latencyMs: 50 });
    expect(store.recent(10, 'ocr.extract')).toHaveLength(1);
    expect(store.recent(10, 'llm.stream')).toHaveLength(1);
  });

  it('respects MAX_ENTRIES (1000) ring buffer cap', () => {
    for (let i = 0; i < 1200; i++) store.record({ kind: 'tool.exec', label: `t${i}`, latencyMs: 1 });
    expect(store.size()).toBeLessThanOrEqual(1000);
    expect(store.recent(1)[0]?.label).toBe('t1199');
  });
});

describe('TelemetryStore.rollupByKind', () => {
  it('computes p50, p95, avg, successRate, tokens/sec', () => {
    // 100 calls: latencies 1..100 ms, all success, 10 output tokens each.
    for (let i = 1; i <= 100; i++) {
      store.record({ kind: 'llm.stream', label: 'm', latencyMs: i, outputTokens: 10, inputTokens: 5, success: true });
    }
    const r = store.rollupByKind().find((x) => x.kind === 'llm.stream')!;
    expect(r.totalCalls).toBe(100);
    expect(r.p50LatencyMs).toBeGreaterThanOrEqual(45);
    expect(r.p50LatencyMs).toBeLessThanOrEqual(55);
    expect(r.p95LatencyMs).toBeGreaterThanOrEqual(90);
    expect(r.p95LatencyMs).toBeLessThanOrEqual(100);
    expect(r.successRate).toBe(1);
    expect(r.totalOutputTokens).toBe(1000);
    expect(r.totalInputTokens).toBe(500);
    // Sum latency = 5050ms = 5.05s; 1000 tokens → ~198 tokens/sec
    expect(r.tokensPerSecond).toBeGreaterThan(150);
    expect(r.tokensPerSecond).toBeLessThan(250);
  });

  it('successRate is 1 when no success flag was recorded (neutral default)', () => {
    store.record({ kind: 'tool.exec', label: 'a', latencyMs: 1 });
    expect(store.rollupByKind()[0]?.successRate).toBe(1);
  });

  it('successRate reflects failures', () => {
    store.record({ kind: 'tool.exec', label: 'a', latencyMs: 1, success: true });
    store.record({ kind: 'tool.exec', label: 'a', latencyMs: 1, success: false });
    store.record({ kind: 'tool.exec', label: 'a', latencyMs: 1, success: true });
    expect(store.rollupByKind()[0]?.successRate).toBeCloseTo(2 / 3, 5);
  });

  it('sorts rollups by totalCalls descending', () => {
    store.record({ kind: 'llm.stream', label: 'x', latencyMs: 1 });
    store.record({ kind: 'ocr.extract', label: 'x', latencyMs: 1 });
    store.record({ kind: 'ocr.extract', label: 'x', latencyMs: 1 });
    expect(store.rollupByKind()[0]?.kind).toBe('ocr.extract');
  });
});

describe('TelemetryStore.clear', () => {
  it('empties the store', () => {
    store.record({ kind: 'llm.stream', label: 'a', latencyMs: 1 });
    expect(store.size()).toBe(1);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.recent(10)).toEqual([]);
  });
});
