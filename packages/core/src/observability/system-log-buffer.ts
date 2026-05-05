/**
 * SystemLogBuffer — in-memory ring buffer of recent system log entries.
 *
 * Captures every log call made via the pino logger so the dashboard's
 * Logs → System Logs tab can display real entries instead of an empty list.
 *
 * Design notes:
 *   - Pure in-memory; resets on process restart. This is intentional —
 *     the rotating file at ~/.agentx/logs/web-server.log is the durable
 *     store. This buffer is for live dashboard display only.
 *   - Bounded at MAX_ENTRIES (default 500) via ring-buffer semantics.
 *   - Never throws — log capture must not break the logger.
 *   - Matches the shape Logs.tsx expects: { level, message, timestamp, module, details? }
 */

const LEVEL_NAMES: Record<number, string> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

export interface SystemLogEntry {
  level: string;
  message: string;
  timestamp: string;       // ISO
  module?: string | null;
  /** JSON-serialised custom fields (e.g. error codes, IDs) from the log call. */
  details?: string | null;
}

const MAX_ENTRIES_DEFAULT = 500;

export class SystemLogBuffer {
  private static instance: SystemLogBuffer | null = null;
  private entries: SystemLogEntry[] = [];
  private readonly maxEntries: number;

  static getInstance(): SystemLogBuffer {
    if (!this.instance) this.instance = new SystemLogBuffer();
    return this.instance;
  }

  /** Test-only factory so tests don't share state across describes. */
  static __createForTest(max = MAX_ENTRIES_DEFAULT): SystemLogBuffer {
    return new SystemLogBuffer(max);
  }

  private constructor(max: number = MAX_ENTRIES_DEFAULT) {
    this.maxEntries = Math.max(1, max);
  }

  /**
   * Capture a single log entry. Called by the pino hook.
   * Never throws.
   *
   * @param levelNum   pino numeric level (30=info, 40=warn, 50=error, ...)
   * @param args       raw arguments passed to info/warn/error/...
   */
  capture(levelNum: number, args: unknown[]): void {
    try {
      const levelName = LEVEL_NAMES[levelNum] ?? String(levelNum);
      const { message, module, details } = parseLogArgs(args);
      this.entries.push({
        level: levelName,
        message,
        timestamp: new Date().toISOString(),
        module: module ?? null,
        details: details ?? null,
      });
      if (this.entries.length > this.maxEntries) {
        // Drop oldest
        this.entries.splice(0, this.entries.length - this.maxEntries);
      }
    } catch {
      // Never let the logger break the caller
    }
  }

  /**
   * Return the N most recent entries (newest first).
   * Optional filtering by level, module, or free-text match.
   */
  list(opts: {
    limit?: number;
    level?: string;
    module?: string;
    search?: string;
  } = {}): SystemLogEntry[] {
    const limit = Math.max(1, Math.min(opts.limit ?? 200, this.maxEntries));
    let items = this.entries.slice();
    if (opts.level) {
      const target = opts.level.toLowerCase();
      items = items.filter(e => e.level === target);
    }
    if (opts.module) {
      const target = opts.module.toLowerCase();
      items = items.filter(e => (e.module ?? '').toLowerCase().includes(target));
    }
    if (opts.search) {
      const target = opts.search.toLowerCase();
      items = items.filter(e =>
        e.message.toLowerCase().includes(target) ||
        (e.module ?? '').toLowerCase().includes(target) ||
        (e.details ?? '').toLowerCase().includes(target),
      );
    }
    // Newest first
    return items.slice(-limit).reverse();
  }

  /** Current number of entries held. */
  size(): number { return this.entries.length; }

  /** Test-only helper — clear all entries. */
  clear(): void { this.entries = []; }
}

/**
 * Parse pino logMethod arguments into a flattened shape.
 *
 * Pino log calls can look like:
 *   log.info('just a message')
 *   log.info({some: 'field'}, 'message with context')
 *   log.info({err: e}, 'error message')
 * This normaliser pulls out: message, module (if present in bindings), and any
 * remaining custom fields stringified for "details".
 */
function parseLogArgs(args: unknown[]): { message: string; module?: string | null; details?: string | null } {
  if (args.length === 0) return { message: '' };

  // Pattern 1: first arg is a string → args[0] is the message
  if (typeof args[0] === 'string') {
    return { message: String(args[0]) };
  }

  // Pattern 2: first arg is an object of custom fields
  const first = args[0] as Record<string, unknown> | null;
  const message = typeof args[1] === 'string'
    ? String(args[1])
    : (typeof first?.msg === 'string' ? first.msg : '');

  if (!first || typeof first !== 'object') {
    return { message };
  }

  const moduleField = typeof first.module === 'string' ? first.module : null;

  // Everything except msg/module becomes "details"
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(first)) {
    if (k === 'msg' || k === 'module') continue;
    rest[k] = v;
  }
  let details: string | null = null;
  if (Object.keys(rest).length > 0) {
    try {
      details = JSON.stringify(rest, null, 0);
      if (details.length > 800) details = details.slice(0, 800) + '…';
    } catch {
      details = null;
    }
  }
  return { message, module: moduleField, details };
}
