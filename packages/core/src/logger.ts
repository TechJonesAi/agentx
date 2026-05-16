import pino from 'pino';
import { SystemLogBuffer } from './observability/system-log-buffer.js';

const level = process.env['LOG_LEVEL'] ?? 'info';

const LEVEL_NUM: Record<string, number> = {
  trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60,
};

// Hook pino's logMethod so every log call also lands in the in-memory
// SystemLogBuffer that powers the dashboard Logs → System Logs tab.
// Without this, the buffer stays empty and the dashboard tab is dead.
export const logger = pino({
  level,
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
  hooks: {
    logMethod(args, method, levelNum) {
      try {
        const lvl = typeof levelNum === 'number' ? levelNum : (LEVEL_NUM[method.name as string] ?? 30);
        SystemLogBuffer.getInstance().capture(lvl, args as unknown[]);
      } catch { /* never let logging break the caller */ }
      return method.apply(this, args);
    },
  },
});

export function createLogger(name: string) {
  return logger.child({ module: name });
}
