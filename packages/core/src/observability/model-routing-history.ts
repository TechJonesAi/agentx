/**
 * ModelRoutingHistory — in-memory ring buffer of recent LLM routing decisions.
 *
 * Records, for each chat/stream/builder call:
 *   - timestamp
 *   - task type (chat | stream | builder | tool-followup | ...)
 *   - selected model
 *   - provider id
 *   - reason (free-text — e.g. "config default", "forced via routing.json", ...)
 *   - whether a fallback was used
 *   - whether localOnly was enforced
 *   - whether tool-calling was enabled
 *   - latency in ms (set after the call returns)
 *
 * Powers the dashboard "Active LLM Routing" panel and Phase 4 truth surface.
 */

export interface ModelRoutingDecision {
  id: string;
  timestamp: string;
  taskType: string;
  model: string;
  provider: string;
  reason: string;
  fallbackUsed: boolean;
  localOnly: boolean;
  toolCallingEnabled: boolean;
  visionRequired?: boolean;
  latencyMs?: number;
}

const MAX_ENTRIES_DEFAULT = 200;

export class ModelRoutingHistory {
  private static instance: ModelRoutingHistory | null = null;
  private entries: ModelRoutingDecision[] = [];
  private readonly maxEntries: number;
  private seq = 0;

  static getInstance(): ModelRoutingHistory {
    if (!this.instance) this.instance = new ModelRoutingHistory();
    return this.instance;
  }

  /** Test-only factory. */
  static __createForTest(max = MAX_ENTRIES_DEFAULT): ModelRoutingHistory {
    return new ModelRoutingHistory(max);
  }

  private constructor(max: number = MAX_ENTRIES_DEFAULT) {
    this.maxEntries = Math.max(1, max);
  }

  /** Record a routing decision and return its id so the caller can patch
   *  latency on completion. */
  record(d: Omit<ModelRoutingDecision, 'id' | 'timestamp'>): string {
    const id = `route-${Date.now()}-${(this.seq++).toString(36)}`;
    this.entries.push({ id, timestamp: new Date().toISOString(), ...d });
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
    return id;
  }

  /** Patch the latency on a previously-recorded decision. */
  setLatency(id: string, latencyMs: number): void {
    const e = this.entries.find(x => x.id === id);
    if (e) e.latencyMs = latencyMs;
  }

  /** Most-recent decision (or null). */
  current(): ModelRoutingDecision | null {
    return this.entries.length > 0 ? (this.entries[this.entries.length - 1] ?? null) : null;
  }

  /** Newest-first list, capped at limit. */
  list(limit = 50): ModelRoutingDecision[] {
    const n = Math.max(1, Math.min(limit, this.maxEntries));
    return this.entries.slice(-n).reverse();
  }

  size(): number { return this.entries.length; }
  clear(): void { this.entries = []; }
}
