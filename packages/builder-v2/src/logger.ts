/**
 * Simple logger for Builder V2
 * Wraps console for structured logging
 */

export interface Logger {
  info(msg: string | Record<string, unknown>, message?: string): void;
  warn(msg: string | Record<string, unknown>, message?: string): void;
  error(msg: string | Record<string, unknown>, message?: string): void;
  debug(msg: string | Record<string, unknown>, message?: string): void;
}

export function createLogger(name: string): Logger {
  return {
    info(msg, message) {
      if (typeof msg === 'object') {
        console.log(`[${name}] INFO:`, JSON.stringify(msg), message);
      } else {
        console.log(`[${name}] INFO: ${msg}`);
      }
    },
    warn(msg, message) {
      if (typeof msg === 'object') {
        console.warn(`[${name}] WARN:`, JSON.stringify(msg), message);
      } else {
        console.warn(`[${name}] WARN: ${msg}`);
      }
    },
    error(msg, message) {
      if (typeof msg === 'object') {
        console.error(`[${name}] ERROR:`, JSON.stringify(msg), message);
      } else {
        console.error(`[${name}] ERROR: ${msg}`);
      }
    },
    debug(msg, message) {
      if (typeof msg === 'object') {
        console.debug(`[${name}] DEBUG:`, JSON.stringify(msg), message);
      } else {
        console.debug(`[${name}] DEBUG: ${msg}`);
      }
    },
  };
}
