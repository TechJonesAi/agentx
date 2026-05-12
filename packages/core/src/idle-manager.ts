/**
 * Idle Manager — manages resource quiescence after task completion.
 *
 * After a build/task finishes, starts an idle countdown. When the countdown
 * expires, enters idle mode: unloads heavy Ollama models, slows health checks,
 * and reduces background activity. On next task, wakes up instantly.
 */

import { createLogger } from './logger.js';

const log = createLogger('idle-manager');

/** Default idle timeout: 2 minutes after last task completion */
const DEFAULT_IDLE_TIMEOUT_MS = 2 * 60 * 1000;

export type IdleState = 'active' | 'idle';

export interface IdleManagerConfig {
  idleTimeoutMs?: number;
  /** Called when entering idle — should unload models, slow timers, etc. */
  onEnterIdle?: () => Promise<void>;
  /** Called when leaving idle — should restore normal operation */
  onExitIdle?: () => Promise<void>;
}

export class IdleManager {
  private state: IdleState = 'active';
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeoutMs: number;
  private readonly onEnterIdle?: () => Promise<void>;
  private readonly onExitIdle?: () => Promise<void>;
  private lastActivityAt: number = Date.now();

  constructor(config: IdleManagerConfig = {}) {
    this.idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.onEnterIdle = config.onEnterIdle;
    this.onExitIdle = config.onExitIdle;
  }

  /** Call when a task/build starts. Exits idle mode if needed. */
  markActive(): void {
    this.lastActivityAt = Date.now();
    this.clearIdleTimer();

    if (this.state === 'idle') {
      this.state = 'active';
      log.info('Exiting idle mode — task started');
      this.onExitIdle?.().catch(err => {
        log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to exit idle mode');
      });
    }
  }

  /** Call when a task/build completes. Starts idle countdown. */
  markTaskComplete(): void {
    this.lastActivityAt = Date.now();
    this.clearIdleTimer();

    log.info({ idleTimeoutMs: this.idleTimeoutMs }, 'Task complete — starting idle countdown');

    this.idleTimer = setTimeout(() => {
      this.enterIdle();
    }, this.idleTimeoutMs);
  }

  private enterIdle(): void {
    if (this.state === 'idle') return;

    this.state = 'idle';
    log.info({
      idleSinceMs: Date.now() - this.lastActivityAt,
    }, 'Entering idle mode — releasing resources');

    this.onEnterIdle?.().catch(err => {
      log.error({ err: err instanceof Error ? err.message : String(err) }, 'Failed to enter idle mode');
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  getState(): IdleState {
    return this.state;
  }

  getStatus(): { state: IdleState; lastActivityAt: number; idleTimeoutMs: number } {
    return {
      state: this.state,
      lastActivityAt: this.lastActivityAt,
      idleTimeoutMs: this.idleTimeoutMs,
    };
  }

  /** Cleanup on shutdown */
  destroy(): void {
    this.clearIdleTimer();
  }
}
