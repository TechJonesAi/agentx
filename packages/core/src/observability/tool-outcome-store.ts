/**
 * ToolOutcomeStore — self-learning record of every tool call's outcome.
 *
 * Each call records: tool name, success (no [...error]: prefix), latency,
 * result preview, timestamp. Powers the dashboard Self-Learning surface
 * (which tools fail most? which work reliably?) and is the foundation for
 * future routing decisions ("avoid X tool for goal Y after N failures").
 *
 * Outcomes are detected from the tool's returned string by the heuristic
 * "if the first segment looks like '[<tool> error]:' or starts with
 * '[Blocked]', mark as failure; otherwise success." Each tool is free to
 * conform.
 */

export interface ToolOutcome {
  id: string;
  timestamp: string;
  toolName: string;
  success: boolean;
  latencyMs: number;
  resultPreview: string;     // first 200 chars of result, no PII filtering yet
  failureReason?: string;    // extracted message if !success
}

export interface ToolReliability {
  toolName: string;
  totalCalls: number;
  successCount: number;
  failureCount: number;
  successRate: number;       // 0..1
  avgLatencyMs: number;
  lastUsedAt?: string;
  lastFailureReason?: string;
}

const MAX_ENTRIES = 500;

export class ToolOutcomeStore {
  private static instance: ToolOutcomeStore | null = null;
  private entries: ToolOutcome[] = [];
  private seq = 0;

  static getInstance(): ToolOutcomeStore {
    if (!this.instance) this.instance = new ToolOutcomeStore();
    return this.instance;
  }

  static __createForTest(): ToolOutcomeStore {
    return new ToolOutcomeStore();
  }

  /** Record an outcome. `result` is whatever the tool returned. */
  record(toolName: string, result: string, latencyMs: number): void {
    const text = String(result ?? '');
    const failureMatch = text.match(/^\s*\[(?:[A-Za-z_-]+\s+)?(?:error|Blocked)[^\]]*\]\s*:?\s*(.*)$/m);
    const success = !failureMatch;
    const entry: ToolOutcome = {
      id: `tool-${Date.now()}-${(this.seq++).toString(36)}`,
      timestamp: new Date().toISOString(),
      toolName,
      success,
      latencyMs,
      resultPreview: text.slice(0, 200),
      ...(failureMatch ? { failureReason: failureMatch[1]?.trim() || 'unknown' } : {}),
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
  }

  /** Most recent N outcomes (newest first). */
  recent(limit = 50): ToolOutcome[] {
    const n = Math.max(1, Math.min(limit, MAX_ENTRIES));
    return this.entries.slice(-n).reverse();
  }

  /** Reliability summary per tool — used by the self-learning panel. */
  reliability(): ToolReliability[] {
    const by = new Map<string, ToolOutcome[]>();
    for (const e of this.entries) {
      const arr = by.get(e.toolName) ?? [];
      arr.push(e);
      by.set(e.toolName, arr);
    }
    const out: ToolReliability[] = [];
    for (const [toolName, arr] of by.entries()) {
      const successCount = arr.filter((x) => x.success).length;
      const failureCount = arr.length - successCount;
      const totalLatency = arr.reduce((s, x) => s + x.latencyMs, 0);
      const last = arr[arr.length - 1];
      const lastFailure = [...arr].reverse().find((x) => !x.success);
      out.push({
        toolName,
        totalCalls: arr.length,
        successCount,
        failureCount,
        successRate: arr.length > 0 ? successCount / arr.length : 0,
        avgLatencyMs: arr.length > 0 ? Math.round(totalLatency / arr.length) : 0,
        ...(last?.timestamp !== undefined ? { lastUsedAt: last.timestamp } : {}),
        ...(lastFailure?.failureReason !== undefined ? { lastFailureReason: lastFailure.failureReason } : {}),
      });
    }
    return out.sort((a, b) => b.totalCalls - a.totalCalls);
  }

  /** Tools that should be demoted from the next provider call because
   *  their last N calls have been unreliable. Default thresholds:
   *  - N = last 10 calls of that tool
   *  - successRate < 0.5
   *  Returns tool names, sorted alphabetically. */
  demotedTools(opts: { window?: number; threshold?: number } = {}): Array<{ toolName: string; recentSuccessRate: number; recentCalls: number }> {
    const window = Math.max(1, opts.window ?? 10);
    const threshold = opts.threshold ?? 0.5;
    const by = new Map<string, ToolOutcome[]>();
    for (const e of this.entries) {
      const arr = by.get(e.toolName) ?? [];
      arr.push(e);
      by.set(e.toolName, arr);
    }
    const out: Array<{ toolName: string; recentSuccessRate: number; recentCalls: number }> = [];
    for (const [toolName, arr] of by.entries()) {
      const recent = arr.slice(-window);
      if (recent.length < window) continue;          // need a full window
      const successes = recent.filter((x) => x.success).length;
      const rate = successes / recent.length;
      if (rate < threshold) {
        out.push({ toolName, recentSuccessRate: rate, recentCalls: recent.length });
      }
    }
    out.sort((a, b) => a.toolName.localeCompare(b.toolName));
    return out;
  }

  /** Reset the store. Exposed for user "Clear Learning Data" action. */
  clear(): void { this.entries = []; }

  size(): number { return this.entries.length; }
}
