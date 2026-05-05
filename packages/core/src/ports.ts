import * as net from 'node:net';
import { createLogger } from './logger.js';

const log = createLogger('core:ports');

/**
 * Allocate a free OS port by binding to port 0 and reading the assignment.
 */
export async function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('Failed to allocate port'));
        return;
      }
      const port = addr.port;
      srv.close(() => {
        log.info({ port }, 'Allocated port');
        resolve(port);
      });
    });
    srv.on('error', reject);
  });
}

/**
 * Check whether a port is available (not in use).
 */
export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => {
      srv.close(() => resolve(true));
    });
  });
}

/**
 * Wait until a port becomes connectable, with timeout.
 */
export async function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
  const start = Date.now();
  const interval = 250;

  while (Date.now() - start < timeoutMs) {
    const connected = await new Promise<boolean>((resolve) => {
      const sock = net.createConnection({ host: '127.0.0.1', port });
      sock.once('connect', () => {
        sock.destroy();
        resolve(true);
      });
      sock.once('error', () => {
        sock.destroy();
        resolve(false);
      });
    });
    if (connected) return;
    await new Promise((r) => setTimeout(r, interval));
  }

  throw new Error(`Port ${port} not reachable after ${timeoutMs}ms`);
}
