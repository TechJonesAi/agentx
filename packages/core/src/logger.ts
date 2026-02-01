import pino from 'pino';

const level = process.env['LOG_LEVEL'] ?? 'info';

export const logger = pino({
  level,
  transport:
    process.env['NODE_ENV'] !== 'production'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});

export function createLogger(name: string) {
  return logger.child({ module: name });
}
