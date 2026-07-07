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

import { Agent, createLogger, ServiceSupervisor, ensureMemoryApi } from '@agentx/core';
import { WebServer } from './server/index.js';

const log = createLogger('web:serve');

async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 3001);
  const host = process.env['HOST'] ?? '127.0.0.1';

  const agent = new Agent();
  const server = new WebServer({ port, host, agent });
  await server.start();

  // Memory API sidecar (:8100) — supervised child with health checks and
  // auto-restart. Fire-and-forget: the dashboard must never wait on it.
  const supervisor = new ServiceSupervisor();
  void ensureMemoryApi(supervisor).catch((err) =>
    log.warn({ error: err instanceof Error ? err.message : String(err) },
      'Memory API sidecar unavailable — continuing without it'),
  );

  // G2 — Memory-API bridge: sync the document corpus into the reasoning
  // engine and route document-grounded questions through its evidence-
  // ranked retrieval (falls back to built-in retrieval on any failure).
  const { startCorpusSync, queryMemoryApi } = await import('./server/memory-api-bridge.js');
  startCorpusSync(() =>
    (agent as unknown as { getDatabase?: () => { prepare(s: string): { all(...a: unknown[]): unknown[]; get(...a: unknown[]): unknown } } })
      .getDatabase?.() ?? null,
  );
  (agent as unknown as { setDocRetrievalAugmenter?: (fn: (q: string) => Promise<string | null>) => void })
    .setDocRetrievalAugmenter?.(async (query: string) => {
      const res = await queryMemoryApi(query);
      if (!res) return null;
      return `\n\n[DOCUMENT EVIDENCE — reasoning engine, ${res.evidenceCount} sources]\n${res.contextText}\n(Answer ONLY from the evidence above; cite [Cn] markers. If the evidence is insufficient, say so.)`;
    });

  // Auto-benchmark: refresh Ollama-vs-oMLX evidence every 6h so routing
  // promotions track real machine conditions instead of one stale run.
  const { startAutoBenchmark } = await import('./server/auto-benchmark.js');
  startAutoBenchmark(() =>
    (agent as unknown as { getProviderBenchmarkStore?: () => { record(r: Record<string, unknown>): unknown } | null })
      .getProviderBenchmarkStore?.() ?? null,
  );

  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  console.log(`AgentX Web UI running on http://${displayHost}:${port}`);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('Shutting down web server…');
    await supervisor.stopAll().catch(() => undefined);
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
