#!/usr/bin/env node
/**
 * Standalone server entry for @agentx/web.
 *
 *   - `pnpm -C packages/web start`  (after build)
 *   - `node packages/web/dist/serve.js`
 *
 * Reads PORT and HOST from env (defaults: 3001, 127.0.0.1).
 * Constructs an Agent + WebServer and handles graceful shutdown.
 */

import { Agent, createLogger } from '@agentx/core';
import { WebServer } from './server/index.js';

const log = createLogger('web:serve');

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 3001);
  const host = process.env['HOST'] ?? '127.0.0.1';

  const agent = new Agent();
  const server = new WebServer({ port, host, agent });
  await server.start();

  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`AgentX Web UI running on http://${displayHost}:${port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down web server…');
    await server.stop();
    await agent.shutdown?.();
    process.exit(0);
  };

  process.on('SIGINT',  () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

main().catch((err) => {
  log.error({ error: err }, 'Failed to start web server');
  console.error('Failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
