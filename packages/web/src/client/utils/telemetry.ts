/**
 * Structured Telemetry for AgentX
 * Consistent logging across all platform components
 *
 * Usage:
 * telemetry.builder('spec', { appName: 'MyApp', platform: 'ios' })
 * telemetry.workflow('stage_change', { workflow: 'id', stage: 'codegen' })
 * telemetry.error('api_error', { endpoint: '/api/build', status: 500 })
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type TelemetryNamespace =
  | 'agentx:event'
  | 'agentx:builder'
  | 'agentx:workflow'
  | 'agentx:memory'
  | 'agentx:tool'
  | 'agentx:agent-loop'
  | 'agentx:runtime';

export interface TelemetryEntry {
  namespace: TelemetryNamespace;
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
  timestamp: number;
  duration?: number;
}

/**
 * Structured telemetry logger
 */
class Telemetry {
  private entries: TelemetryEntry[] = [];
  private maxHistorySize = 500;
  private isDevelopment = true;

  constructor() {
    this.isDevelopment = typeof window !== 'undefined' && !window.location.hostname.includes('prod');
  }

  /**
   * Internal logging method
   */
  private log(
    namespace: TelemetryNamespace,
    level: LogLevel,
    message: string,
    context: Record<string, unknown> = {},
    duration?: number
  ): void {
    const entry: TelemetryEntry = {
      namespace,
      level,
      message,
      context,
      timestamp: Date.now(),
      duration,
    };

    this.entries.push(entry);
    if (this.entries.length > this.maxHistorySize) {
      this.entries.shift();
    }

    // Log to console with color coding
    if (this.isDevelopment) {
      const style = this.getConsoleStyle(level);
      console.log(
        `%c[${namespace}:${level}] ${message}`,
        style,
        context
      );
    }

    // Send to external telemetry (if configured)
    this.sendToBackend(entry);
  }

  /**
   * Get console style based on log level
   */
  private getConsoleStyle(level: LogLevel): string {
    const styles: Record<LogLevel, string> = {
      debug: 'color: #888; font-size: 12px;',
      info: 'color: #00d9ff; font-size: 13px; font-weight: bold;',
      warn: 'color: #ffa500; font-size: 13px; font-weight: bold;',
      error: 'color: #ff4444; font-size: 13px; font-weight: bold;',
    };
    return styles[level];
  }

  /**
   * Send telemetry to backend (for production)
   */
  private sendToBackend(entry: TelemetryEntry): void {
    if (!this.isDevelopment) {
      // In production, could send to telemetry service
      // fetch('/api/telemetry', { method: 'POST', body: JSON.stringify(entry) })
    }
  }

  // ─── Builder Telemetry ──────────────────────────────────────

  builder(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:builder', 'info', action, context);
  }

  builderDebug(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:builder', 'debug', action, context);
  }

  builderError(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:builder', 'error', action, context);
  }

  // ─── Workflow Telemetry ────────────────────────────────────

  workflow(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:workflow', 'info', action, context);
  }

  workflowDebug(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:workflow', 'debug', action, context);
  }

  workflowError(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:workflow', 'error', action, context);
  }

  // ─── Memory Telemetry ──────────────────────────────────────

  memory(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:memory', 'info', action, context);
  }

  memoryDebug(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:memory', 'debug', action, context);
  }

  // ─── Tool Telemetry ────────────────────────────────────────

  tool(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:tool', 'info', action, context);
  }

  toolDebug(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:tool', 'debug', action, context);
  }

  toolError(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:tool', 'error', action, context);
  }

  // ─── Agent Loop Telemetry ──────────────────────────────────

  agentLoop(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:agent-loop', 'info', action, context);
  }

  agentLoopDebug(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:agent-loop', 'debug', action, context);
  }

  agentLoopError(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:agent-loop', 'error', action, context);
  }

  // ─── Runtime Telemetry ────────────────────────────────────

  runtime(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:runtime', 'info', action, context);
  }

  runtimeDebug(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:runtime', 'debug', action, context);
  }

  runtimeError(action: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:runtime', 'error', action, context);
  }

  // ─── Generic Logging ───────────────────────────────────────

  logMessage(level: LogLevel, message: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:runtime', level, message, context);
  }

  warn(message: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:runtime', 'warn', message, context);
  }

  error(message: string, context: Record<string, unknown> = {}): void {
    this.log('agentx:runtime', 'error', message, context);
  }

  // ─── Timing ────────────────────────────────────────────────

  /**
   * Measure execution time of a function
   */
  async measureAsync<T>(
    namespace: TelemetryNamespace,
    label: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const start = performance.now();
    try {
      const result = await fn();
      const duration = Math.round(performance.now() - start);
      this.log(namespace, 'info', `${label} completed`, { duration }, duration);
      return result;
    } catch (error) {
      const duration = Math.round(performance.now() - start);
      this.log(
        namespace,
        'error',
        `${label} failed`,
        { duration, error: error instanceof Error ? error.message : String(error) },
        duration
      );
      throw error;
    }
  }

  /**
   * Measure execution time of a sync function
   */
  measureSync<T>(
    namespace: TelemetryNamespace,
    label: string,
    fn: () => T
  ): T {
    const start = performance.now();
    try {
      const result = fn();
      const duration = Math.round(performance.now() - start);
      this.log(namespace, 'info', `${label} completed`, { duration }, duration);
      return result;
    } catch (error) {
      const duration = Math.round(performance.now() - start);
      this.log(
        namespace,
        'error',
        `${label} failed`,
        { duration, error: error instanceof Error ? error.message : String(error) },
        duration
      );
      throw error;
    }
  }

  // ─── History & Metrics ────────────────────────────────────

  /**
   * Get recent log entries
   */
  getHistory(namespace?: TelemetryNamespace, limit = 50): TelemetryEntry[] {
    let entries = [...this.entries];
    if (namespace) {
      entries = entries.filter(e => e.namespace === namespace);
    }
    return entries.slice(-limit);
  }

  /**
   * Get statistics about telemetry
   */
  getStats() {
    const byNamespace: Record<TelemetryNamespace, number> = {
      'agentx:event': 0,
      'agentx:builder': 0,
      'agentx:workflow': 0,
      'agentx:memory': 0,
      'agentx:tool': 0,
      'agentx:agent-loop': 0,
      'agentx:runtime': 0,
    };

    const byLevel: Record<LogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
    };

    this.entries.forEach(entry => {
      byNamespace[entry.namespace]++;
      byLevel[entry.level]++;
    });

    return {
      totalEntries: this.entries.length,
      byNamespace,
      byLevel,
      lastEntry: this.entries[this.entries.length - 1],
    };
  }

  /**
   * Clear history (for testing)
   */
  clear(): void {
    this.entries = [];
  }
}

// Export singleton instance
export const telemetry = new Telemetry();

// Also export the class for testing
export { Telemetry };
