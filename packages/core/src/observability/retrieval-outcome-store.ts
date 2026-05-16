/**
 * RetrievalOutcomeStore — self-learning record of retrieval attempts.
 *
 * Every chat call that invokes the retrieval pipeline records its outcome
 * here: query, latency, match count, whether the result was sufficient,
 * whether a fallback was used, source types, error if any. Drives the
 * dashboard "retrieval quality trends" surface and (in future batches)
 * the routing layer that picks retrieval strategies.
 */

export interface RetrievalOutcome {
  id: string;
  timestamp: string;
  query: string;
  success: boolean;
  matchCount: number;
  sufficient: boolean | null;       // null when sufficiency check didn't run
  fallbackUsed: boolean;
  latencyMs: number;
  sourceTypes: string[];            // e.g. ['memory', 'cognitive', 'document']
  groundedAnswer: boolean | null;   // null when downstream answer-grading didn't run
  failureReason?: string;
}

export interface RetrievalReliability {
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;             // 0..1
  avgMatchCount: number;
  avgLatencyMs: number;
  sufficientCount: number;          // calls where sufficiency was true
  fallbackCount: number;
  lastFailureReason?: string;
}

const MAX_ENTRIES = 500;

export class RetrievalOutcomeStore {
  private static instance: RetrievalOutcomeStore | null = null;
  private entries: RetrievalOutcome[] = [];
  private seq = 0;

  static getInstance(): RetrievalOutcomeStore {
    if (!this.instance) this.instance = new RetrievalOutcomeStore();
    return this.instance;
  }

  static __createForTest(): RetrievalOutcomeStore {
    return new RetrievalOutcomeStore();
  }

  record(o: Omit<RetrievalOutcome, 'id' | 'timestamp'>): void {
    const entry: RetrievalOutcome = {
      id: `ret-${Date.now()}-${(this.seq++).toString(36)}`,
      timestamp: new Date().toISOString(),
      ...o,
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  recent(limit = 50): RetrievalOutcome[] {
    const n = Math.max(1, Math.min(limit, MAX_ENTRIES));
    return this.entries.slice(-n).reverse();
  }

  reliability(): RetrievalReliability {
    if (this.entries.length === 0) {
      return {
        totalCalls: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgMatchCount: 0,
        avgLatencyMs: 0,
        sufficientCount: 0,
        fallbackCount: 0,
      };
    }
    const successCount = this.entries.filter((e) => e.success).length;
    const totalMatches = this.entries.reduce((s, e) => s + e.matchCount, 0);
    const totalLatency = this.entries.reduce((s, e) => s + e.latencyMs, 0);
    const sufficientCount = this.entries.filter((e) => e.sufficient === true).length;
    const fallbackCount = this.entries.filter((e) => e.fallbackUsed).length;
    const lastFailure = [...this.entries].reverse().find((e) => !e.success);
    return {
      totalCalls: this.entries.length,
      successCount,
      failureCount: this.entries.length - successCount,
      successRate: successCount / this.entries.length,
      avgMatchCount: Math.round((totalMatches / this.entries.length) * 100) / 100,
      avgLatencyMs: Math.round(totalLatency / this.entries.length),
      sufficientCount,
      fallbackCount,
      ...(lastFailure?.failureReason !== undefined ? { lastFailureReason: lastFailure.failureReason } : {}),
    };
  }

  /** Useful documents/sources — count appearances across successful calls. */
  topSources(limit = 10): Array<{ source: string; count: number }> {
    const counts = new Map<string, number>();
    for (const e of this.entries) {
      if (!e.success) continue;
      for (const s of e.sourceTypes) counts.set(s, (counts.get(s) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([source, count]) => ({ source, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  clear(): void { this.entries = []; }
  size(): number { return this.entries.length; }
}
