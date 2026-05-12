/**
 * Build Queue Manager — ensures only ONE app build runs at a time.
 *
 * All build entry points (chat pipeline, REST API) must acquire the lock
 * before executing. If a build is already running, the request is queued.
 * When the current build finishes, the next queued build starts automatically.
 */

import { createLogger } from './logger.js';

const log = createLogger('build-queue');

export type BuildStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface QueuedBuild {
  id: string;
  appName: string;
  prompt: string;
  workspace: string;
  sessionId?: string;
  status: BuildStatus;
  queuedAt: number;
  startedAt?: number;
  completedAt?: number;
  /** Resolve the promise returned to the caller */
  resolve: (result: unknown) => void;
  /** Reject the promise returned to the caller */
  reject: (error: Error) => void;
  /** The actual build execution function */
  execute: () => Promise<unknown>;
}

export interface BuildQueueState {
  running: { id: string; appName: string; workspace: string; startedAt: number } | null;
  queued: Array<{ id: string; appName: string; workspace: string; queuedAt: number }>;
  completed: Array<{ id: string; appName: string; status: BuildStatus; completedAt: number }>;
  maxConcurrent: number;
}

export class BuildQueueManager {
  private currentBuild: QueuedBuild | null = null;
  private queue: QueuedBuild[] = [];
  private history: QueuedBuild[] = [];
  private readonly maxHistory = 20;
  /** Called when a build starts (to exit idle mode) */
  onBuildStart?: () => void;
  /** Called when the last build finishes and queue is empty (to trigger idle countdown) */
  onAllBuildsComplete?: () => void;

  /**
   * Submit a build for execution. Returns a promise that resolves when the
   * build actually completes (which may be after waiting in the queue).
   */
  async submit(opts: {
    id: string;
    appName: string;
    prompt: string;
    workspace: string;
    sessionId?: string;
    execute: () => Promise<unknown>;
  }): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const entry: QueuedBuild = {
        id: opts.id,
        appName: opts.appName,
        prompt: opts.prompt,
        workspace: opts.workspace,
        sessionId: opts.sessionId,
        status: 'queued',
        queuedAt: Date.now(),
        resolve,
        reject,
        execute: opts.execute,
      };

      if (!this.currentBuild) {
        // No build running → start immediately
        this.startBuild(entry);
      } else {
        // Build already running → queue
        this.queue.push(entry);
        log.info({
          queuedId: entry.id,
          appName: entry.appName,
          currentBuildId: this.currentBuild.id,
          queueLength: this.queue.length,
        }, 'Build queued — another build is running');
      }
    });
  }

  private async startBuild(entry: QueuedBuild): Promise<void> {
    this.currentBuild = entry;
    entry.status = 'running';
    entry.startedAt = Date.now();

    // Notify idle manager — system is active
    try { this.onBuildStart?.(); } catch { /* non-critical */ }

    log.info({
      buildId: entry.id,
      appName: entry.appName,
      workspace: entry.workspace,
      queueLength: this.queue.length,
    }, 'Build starting');

    try {
      const result = await entry.execute();
      entry.status = 'completed';
      entry.completedAt = Date.now();
      log.info({
        buildId: entry.id,
        appName: entry.appName,
        durationMs: entry.completedAt - (entry.startedAt ?? entry.queuedAt),
      }, 'Build completed');
      entry.resolve(result);
    } catch (err) {
      entry.status = 'failed';
      entry.completedAt = Date.now();
      log.error({
        buildId: entry.id,
        appName: entry.appName,
        error: err instanceof Error ? err.message : String(err),
      }, 'Build failed');
      entry.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      // Archive to history
      this.history.push(entry);
      if (this.history.length > this.maxHistory) this.history.shift();
      this.currentBuild = null;

      // Start next queued build if any
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    if (this.currentBuild) return; // already running
    const next = this.queue.shift();
    if (next) {
      log.info({
        buildId: next.id,
        appName: next.appName,
        waitMs: Date.now() - next.queuedAt,
        remainingQueue: this.queue.length,
      }, 'Starting next queued build');
      this.startBuild(next);
    } else {
      // Queue empty, no build running — notify idle manager
      try { this.onAllBuildsComplete?.(); } catch { /* non-critical */ }
    }
  }

  /** Whether a build is currently running */
  isBuilding(): boolean {
    return this.currentBuild !== null;
  }

  /** Get the current running build ID (or null) */
  getRunningBuildId(): string | null {
    return this.currentBuild?.id ?? null;
  }

  /** Get full queue state for API/UI */
  getState(): BuildQueueState {
    return {
      running: this.currentBuild ? {
        id: this.currentBuild.id,
        appName: this.currentBuild.appName,
        workspace: this.currentBuild.workspace,
        startedAt: this.currentBuild.startedAt ?? this.currentBuild.queuedAt,
      } : null,
      queued: this.queue.map(q => ({
        id: q.id,
        appName: q.appName,
        workspace: q.workspace,
        queuedAt: q.queuedAt,
      })),
      completed: this.history.slice(-10).map(h => ({
        id: h.id,
        appName: h.appName,
        status: h.status,
        completedAt: h.completedAt ?? Date.now(),
      })),
      maxConcurrent: 1,
    };
  }

  /** Cancel the currently running build (best-effort — the pipeline must check for cancellation) */
  cancelCurrent(): boolean {
    if (!this.currentBuild) return false;
    log.info({ buildId: this.currentBuild.id }, 'Build cancelled by user');
    this.currentBuild.status = 'cancelled';
    this.currentBuild.completedAt = Date.now();
    // The actual pipeline abort is handled by the session abort controller
    return true;
  }

  /** Clear all queued (not running) builds */
  clearQueue(): number {
    const count = this.queue.length;
    for (const entry of this.queue) {
      entry.status = 'cancelled';
      entry.completedAt = Date.now();
      entry.reject(new Error('Build cancelled — queue cleared'));
      this.history.push(entry);
    }
    this.queue = [];
    if (this.history.length > this.maxHistory) {
      this.history = this.history.slice(-this.maxHistory);
    }
    log.info({ clearedCount: count }, 'Build queue cleared');
    return count;
  }

  /** Get queue length */
  get queueLength(): number {
    return this.queue.length;
  }
}
