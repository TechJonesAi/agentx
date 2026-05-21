/**
 * TelemetryStore — Batch 5 live performance metrics ring buffer.
 *
 * Records per-call telemetry across providers/tools/retrieval/OCR so the
 * dashboard's Active LLM Routing panel + telemetry surface can show
 * tokens/sec, p50/p95 latency, queue health, and provider performance.
 *
 * Each entry is small, JSON-safe, and indexed by kind so reliability
 * rollups are O(N) over recent entries.
 */

export type TelemetryKind =
  | 'llm.complete'
  | 'llm.stream'
  | 'tool.exec'
  | 'retrieval.query'
  | 'ocr.extract'
  | 'builder.run'
  | 'validation.run';

export interface TelemetryEntry {
  id: string;
  timestamp: string;
  kind: TelemetryKind;
  /** Free-text label for the entry (e.g. tool name, model name). */
  label: string;
  /** Wall-clock duration in ms. Set to 0 for instantaneous events. */
  latencyMs: number;
  /** Optional input token count (LLM). */
  inputTokens?: number;
  /** Optional output token count (LLM). */
  outputTokens?: number;
  /** Optional success flag. */
  success?: boolean;
  /** Optional free-text error reason. */
  errorReason?: string;
}

export interface TelemetryRollup {
  kind: TelemetryKind;
  totalCalls: number;
  p50LatencyMs: number;
  p95LatencyMs: number;
  avgLatencyMs: number;
  successRate: number;       // 0..1; 1 when no success flags recorded
  totalInputTokens: number;
  totalOutputTokens: number;
  tokensPerSecond: number;   // outputTokens / sum(latencyMs/1000)
}

const MAX_ENTRIES = 1000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
  return sorted[idx] ?? 0;
}

export class TelemetryStore {
  private static instance: TelemetryStore | null = null;
  private entries: TelemetryEntry[] = [];
  private seq = 0;

  static getInstance(): TelemetryStore {
    if (!this.instance) this.instance = new TelemetryStore();
    return this.instance;
  }

  static __createForTest(): TelemetryStore {
    return new TelemetryStore();
  }

  record(e: Omit<TelemetryEntry, 'id' | 'timestamp'>): void {
    const entry: TelemetryEntry = {
      id: `tel-${Date.now()}-${(this.seq++).toString(36)}`,
      timestamp: new Date().toISOString(),
      ...e,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  recent(limit = 100, kind?: TelemetryKind): TelemetryEntry[] {
    const n = Math.max(1, Math.min(limit, MAX_ENTRIES));
    let list = this.entries;
    if (kind) list = list.filter((e) => e.kind === kind);
    return list.slice(-n).reverse();
  }

  rollupByKind(): TelemetryRollup[] {
    const groups = new Map<TelemetryKind, TelemetryEntry[]>();
    for (const e of this.entries) {
      const arr = groups.get(e.kind) ?? [];
      arr.push(e);
      groups.set(e.kind, arr);
    }
    const out: TelemetryRollup[] = [];
    for (const [kind, list] of groups.entries()) {
      const latencies = list.map((e) => e.latencyMs).sort((a, b) => a - b);
      const successList = list.filter((e) => typeof e.success === 'boolean');
      const successCount = successList.filter((e) => e.success === true).length;
      const totalIn = list.reduce((s, e) => s + (e.inputTokens ?? 0), 0);
      const totalOut = list.reduce((s, e) => s + (e.outputTokens ?? 0), 0);
      const totalLatencySec = list.reduce((s, e) => s + e.latencyMs, 0) / 1000;
      out.push({
        kind,
        totalCalls: list.length,
        p50LatencyMs: percentile(latencies, 50),
        p95LatencyMs: percentile(latencies, 95),
        avgLatencyMs: list.length > 0 ? Math.round(latencies.reduce((s, n) => s + n, 0) / list.length) : 0,
        successRate: successList.length > 0 ? successCount / successList.length : 1,
        totalInputTokens: totalIn,
        totalOutputTokens: totalOut,
        tokensPerSecond: totalLatencySec > 0 ? Math.round(totalOut / totalLatencySec) : 0,
      });
    }
    return out.sort((a, b) => b.totalCalls - a.totalCalls);
  }

  clear(): void { this.entries = []; }
  size(): number { return this.entries.length; }

  /** Batch 6D — per-model health derived from llm.* telemetry entries.
   *  Keyed by the label field (which chatStream sets to "provider:model").
   *  Used by ModelRoutingEngine for latency-driven model demotion. */
  perModelHealth(): Record<string, { totalCalls: number; p95LatencyMs: number; successRate: number }> {
    const byLabel = new Map<string, TelemetryEntry[]>();
    for (const e of this.entries) {
      if (e.kind !== 'llm.complete' && e.kind !== 'llm.stream') continue;
      const arr = byLabel.get(e.label) ?? [];
      arr.push(e);
      byLabel.set(e.label, arr);
    }
    const out: Record<string, { totalCalls: number; p95LatencyMs: number; successRate: number }> = {};
    for (const [label, list] of byLabel.entries()) {
      const latencies = list.map((e) => e.latencyMs).sort((a, b) => a - b);
      const idx95 = Math.min(latencies.length - 1, Math.max(0, Math.floor(0.95 * latencies.length)));
      const p95 = latencies[idx95] ?? 0;
      const successList = list.filter((e) => typeof e.success === 'boolean');
      const successCount = successList.filter((e) => e.success === true).length;
      out[label] = {
        totalCalls: list.length,
        p95LatencyMs: p95,
        successRate: successList.length > 0 ? successCount / successList.length : 1,
      };
    }
    return out;
  }
}
