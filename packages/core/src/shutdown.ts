import { createLogger } from './logger.js';

const log = createLogger('shutdown');

export type ShutdownHandler = () => Promise<void>;

export class ShutdownManager {
  private handlers: Array<{ name: string; handler: ShutdownHandler }> = [];
  private shuttingDown = false;

  register(name: string, handler: ShutdownHandler): void {
    this.handlers.push({ name, handler });
    log.info({ name }, 'Shutdown handler registered');
  }

  unregister(name: string): void {
    this.handlers = this.handlers.filter((h) => h.name !== name);
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;

    log.info({ handlerCount: this.handlers.length }, 'Shutting down gracefully');

    // Execute in reverse order (LIFO — last registered shuts down first)
    for (let i = this.handlers.length - 1; i >= 0; i--) {
      const { name, handler } = this.handlers[i]!;
      try {
        await handler();
        log.info({ name }, 'Shutdown handler completed');
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ name, error: msg }, 'Shutdown handler error');
      }
    }

    log.info('Graceful shutdown complete');
  }

  listen(): void {
    const onSignal = () => {
      this.shutdown().then(() => {
        process.exit(0);
      }).catch(() => {
        process.exit(1);
      });
    };

    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }
}
