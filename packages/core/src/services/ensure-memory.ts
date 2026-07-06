/**
 * Memory API service definition and launcher.
 *
 * Encapsulates the specific configuration for starting the Python
 * Memory API (FastAPI + Uvicorn) as a managed service.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogger } from '../logger.js';
import type { ServiceDefinition } from './supervisor.js';
import type { ServiceSupervisor } from './supervisor.js';

const log = createLogger('services:ensure-memory');

// ─── Path resolution ─────────────────────────────────────────────────────────

/**
 * Resolve the path to packages/memory-core/src.
 * Walks up from this file's location (packages/core/src/services/) to the
 * monorepo root, then looks for packages/memory-core/src.
 */
function resolveMemoryCorePath(): string | null {
  const thisDir = path.dirname(fileURLToPath(import.meta.url));

  // Walk up to find the monorepo root (contains packages/ dir)
  let dir = thisDir;
  for (let i = 0; i < 10; i++) {
    const packagesDir = path.join(dir, 'packages', 'memory-core', 'src');
    if (fs.existsSync(packagesDir)) {
      return packagesDir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }

  // Also check via environment variable
  const envPath = process.env['AGENTX_MEMORY_CORE_PATH'];
  if (envPath && fs.existsSync(envPath)) {
    return envPath;
  }

  return null;
}

// ─── Service definition ──────────────────────────────────────────────────────

export interface MemoryServiceConfig {
  enabled?: boolean;
  port?: number;
  host?: string;
  healthIntervalMs?: number;
  startTimeoutMs?: number;
  maxRestarts?: number;
  restartBackoffMs?: number;
}

/**
 * Build a ServiceDefinition for the Python Memory API.
 */
export function getMemoryServiceDefinition(
  config?: MemoryServiceConfig,
): ServiceDefinition {
  const port = Number(process.env['AGENTX_MEMORY_API_PORT'] ?? config?.port ?? 8100);
  const host = process.env['AGENTX_MEMORY_API_HOST'] ?? config?.host ?? '127.0.0.1';

  const cwd = resolveMemoryCorePath();

  // Bare 'python3' can resolve to Xcode's Python 3.9, which cannot evaluate
  // modern type annotations (list[str] | None) — prefer Homebrew's python3.
  const python =
    process.env['AGENTX_MEMORY_PYTHON'] ??
    (fs.existsSync('/opt/homebrew/bin/python3') ? '/opt/homebrew/bin/python3' : 'python3');

  return {
    name: 'memory-api',
    command: python,
    args: [
      '-m', 'uvicorn',
      'agentx_memory.api.server:app',
      '--host', host,
      '--port', String(port),
    ],
    cwd: cwd ?? undefined,
    port,
    healthUrl: `http://${host}:${port}/health`,
    healthIntervalMs: config?.healthIntervalMs ?? 30_000,
    startTimeoutMs: config?.startTimeoutMs ?? 20_000,
    maxRestarts: config?.maxRestarts ?? 5,
    restartBackoffMs: config?.restartBackoffMs ?? 2_000,
    env: {
      AGENTX_MEMORY_API_HOST: host,
      AGENTX_MEMORY_API_PORT: String(port),
    },
    optional: false,
  };
}

/**
 * Ensure the Memory API is running. If an external instance is already
 * healthy on the configured port, adopt it instead of spawning a duplicate.
 *
 * @returns true if the memory API is running and healthy
 */
export async function ensureMemoryApi(
  supervisor: ServiceSupervisor,
  servicesConfig?: MemoryServiceConfig,
): Promise<boolean> {
  // Check if explicitly disabled
  if (servicesConfig?.enabled === false) {
    log.info('Memory API auto-start is disabled by config');
    return false;
  }

  const def = getMemoryServiceDefinition(servicesConfig);

  // Verify python3 is available before attempting spawn
  if (!def.cwd) {
    log.warn(
      'Could not resolve packages/memory-core path — Memory API may fail to start. ' +
      'Set AGENTX_MEMORY_CORE_PATH to the memory-core/src directory.',
    );
  }

  try {
    const started = await supervisor.startService(def);
    if (started) {
      log.info({ port: def.port }, 'Memory API is running and healthy');
    }
    return started;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ error: msg }, 'Failed to start Memory API — memory features will be degraded');
    return false;
  }
}
