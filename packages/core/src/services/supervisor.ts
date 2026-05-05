/**
 * ServiceSupervisor — manages spawning, health-checking, and auto-restarting
 * of child processes (e.g. the Python Memory API).
 *
 * Design:
 *   - If the port is already occupied and the health endpoint responds,
 *     adopt the external process (don't spawn a duplicate).
 *   - If the port is free, spawn the process and wait for it to become healthy.
 *   - Periodically poll the health endpoint; after N consecutive failures, restart.
 *   - On shutdown, kill any child processes we spawned (not adopted ones).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createLogger } from '../logger.js';
import { isPortAvailable, waitForPort } from '../ports.js';

const log = createLogger('services:supervisor');

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ServiceDefinition {
  /** Unique service name (e.g. 'memory-api') */
  name: string;
  /** Executable command (e.g. 'python3') */
  command: string;
  /** Command arguments */
  args: string[];
  /** Working directory for the spawned process */
  cwd?: string;
  /** Port the service listens on */
  port: number;
  /** Full URL of the health endpoint (e.g. 'http://127.0.0.1:8100/health') */
  healthUrl: string;
  /** How often to poll health (ms) */
  healthIntervalMs: number;
  /** Max time to wait for the port after spawn (ms) */
  startTimeoutMs: number;
  /** Max auto-restarts before giving up */
  maxRestarts: number;
  /** Base backoff between restarts (ms), doubles each attempt */
  restartBackoffMs: number;
  /** Extra environment variables for the child process */
  env?: Record<string, string>;
  /** If true, startup failure doesn't throw */
  optional?: boolean;
}

export interface ServiceStatus {
  name: string;
  running: boolean;
  healthy: boolean;
  pid?: number;
  adopted: boolean;
  restartCount: number;
  lastHealthCheck?: Date;
}

interface ManagedService {
  def: ServiceDefinition;
  child: ChildProcess | null;
  adopted: boolean;
  healthy: boolean;
  restartCount: number;
  consecutiveFailures: number;
  lastHealthCheck?: Date;
  healthInterval?: ReturnType<typeof setInterval>;
  restarting: boolean;
}

// ─── ServiceSupervisor ───────────────────────────────────────────────────────

export class ServiceSupervisor extends EventEmitter {
  private services = new Map<string, ManagedService>();

  /**
   * Start (or adopt) a service.
   *
   * 1. If the port is already in use AND the health endpoint responds → adopt.
   * 2. If the port is free → spawn child process → waitForPort → verify health.
   * 3. Start periodic health monitoring.
   *
   * Returns true if the service is running and healthy.
   */
  async startService(def: ServiceDefinition): Promise<boolean> {
    const portFree = await isPortAvailable(def.port);

    if (!portFree) {
      // Something is already on this port — check if it's our service
      const healthy = await this.checkHealth(def.healthUrl);
      if (healthy) {
        log.info({ service: def.name, port: def.port }, 'Adopted existing healthy service');
        const managed: ManagedService = {
          def,
          child: null,
          adopted: true,
          healthy: true,
          restartCount: 0,
          consecutiveFailures: 0,
          lastHealthCheck: new Date(),
          restarting: false,
        };
        this.services.set(def.name, managed);
        this.startHealthMonitor(managed);
        this.emit('service:started', { name: def.name, adopted: true });
        this.emit('service:healthy', { name: def.name });
        return true;
      }

      // Port occupied but health fails — can't start
      log.error(
        { service: def.name, port: def.port },
        'Port is in use but health check failed — cannot start service',
      );
      if (def.optional) return false;
      throw new Error(`Port ${def.port} is in use but ${def.name} health check failed`);
    }

    // Port is free — spawn the child process
    return this.spawnService(def);
  }

  /**
   * Stop a single service. Only kills child processes we spawned (not adopted).
   */
  async stopService(name: string): Promise<void> {
    const managed = this.services.get(name);
    if (!managed) return;

    this.clearHealthMonitor(managed);

    if (managed.child && !managed.adopted) {
      log.info({ service: name, pid: managed.child.pid }, 'Stopping service');
      managed.child.removeAllListeners('exit');
      managed.child.kill('SIGTERM');

      // Give it 5s to exit gracefully, then SIGKILL
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          if (managed.child && !managed.child.killed) {
            managed.child.kill('SIGKILL');
          }
          resolve();
        }, 5_000);

        managed.child!.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    this.services.delete(name);
    this.emit('service:stopped', { name });
    log.info({ service: name }, 'Service stopped');
  }

  /**
   * Stop all managed services.
   */
  async stopAll(): Promise<void> {
    const names = [...this.services.keys()];
    for (const name of names) {
      await this.stopService(name);
    }
  }

  /**
   * Get the current status of a service.
   */
  getStatus(name: string): ServiceStatus | null {
    const managed = this.services.get(name);
    if (!managed) return null;

    return {
      name: managed.def.name,
      running: managed.adopted || (managed.child != null && !managed.child.killed),
      healthy: managed.healthy,
      pid: managed.child?.pid,
      adopted: managed.adopted,
      restartCount: managed.restartCount,
      lastHealthCheck: managed.lastHealthCheck,
    };
  }

  // ─── Private ─────────────────────────────────────────────────────────────

  private async spawnService(def: ServiceDefinition): Promise<boolean> {
    log.info(
      { service: def.name, command: def.command, args: def.args, cwd: def.cwd },
      'Spawning service',
    );

    let child: ChildProcess;
    try {
      child = spawn(def.command, def.args, {
        cwd: def.cwd,
        env: { ...process.env, ...def.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ service: def.name, error: msg }, 'Failed to spawn service');
      if (def.optional) return false;
      throw new Error(`Failed to spawn ${def.name}: ${msg}`);
    }

    // Pipe child stdout/stderr to our logger
    child.stdout?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) log.debug({ service: def.name }, line);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line) log.warn({ service: def.name }, line);
    });

    // Handle immediate spawn failure
    const spawnError = await new Promise<Error | null>((resolve) => {
      child.once('error', (err) => resolve(err));
      // If no error after 500ms, assume spawn succeeded
      setTimeout(() => resolve(null), 500);
    });

    if (spawnError) {
      log.error(
        { service: def.name, error: spawnError.message },
        'Service process failed to start',
      );
      if (def.optional) return false;
      throw new Error(`${def.name} failed to start: ${spawnError.message}`);
    }

    // Wait for the port to become connectable
    try {
      await waitForPort(def.port, def.startTimeoutMs);
    } catch {
      log.error(
        { service: def.name, port: def.port, timeout: def.startTimeoutMs },
        'Service did not start listening in time',
      );
      child.kill('SIGTERM');
      if (def.optional) return false;
      throw new Error(`${def.name} did not start on port ${def.port} within ${def.startTimeoutMs}ms`);
    }

    // Verify health
    const healthy = await this.checkHealth(def.healthUrl);
    if (!healthy) {
      log.error({ service: def.name }, 'Service started but health check failed');
      child.kill('SIGTERM');
      if (def.optional) return false;
      throw new Error(`${def.name} started but health check failed`);
    }

    const managed: ManagedService = {
      def,
      child,
      adopted: false,
      healthy: true,
      restartCount: 0,
      consecutiveFailures: 0,
      lastHealthCheck: new Date(),
      restarting: false,
    };
    this.services.set(def.name, managed);

    // Listen for unexpected exit
    child.once('exit', (code, signal) => {
      log.warn(
        { service: def.name, code, signal },
        'Service process exited unexpectedly',
      );
      managed.healthy = false;
      this.emit('service:unhealthy', { name: def.name, reason: `exited (code=${code})` });
      void this.restartService(managed);
    });

    this.startHealthMonitor(managed);
    this.emit('service:started', { name: def.name, pid: child.pid, adopted: false });
    this.emit('service:healthy', { name: def.name });

    log.info(
      { service: def.name, pid: child.pid, port: def.port },
      'Service started and healthy',
    );

    return true;
  }

  private async restartService(managed: ManagedService): Promise<void> {
    if (managed.restarting) return;
    managed.restarting = true;

    const { def } = managed;

    if (managed.restartCount >= def.maxRestarts) {
      log.error(
        { service: def.name, restarts: managed.restartCount },
        'Max restarts exceeded — giving up',
      );
      this.emit('service:failed', {
        name: def.name,
        reason: `Max restarts (${def.maxRestarts}) exceeded`,
      });
      managed.restarting = false;
      return;
    }

    managed.restartCount++;
    const delay = def.restartBackoffMs * Math.pow(2, managed.restartCount - 1);

    log.info(
      { service: def.name, attempt: managed.restartCount, delayMs: delay },
      'Restarting service after backoff',
    );
    this.emit('service:restarting', { name: def.name, attempt: managed.restartCount });

    // Clean up old child
    this.clearHealthMonitor(managed);
    if (managed.child && !managed.child.killed) {
      managed.child.removeAllListeners('exit');
      managed.child.kill('SIGTERM');
    }

    await new Promise((r) => setTimeout(r, delay));

    try {
      const success = await this.spawnService(def);
      if (!success) {
        managed.restarting = false;
        // spawnService updates the map entry, so get the fresh one
        return;
      }
    } catch (err) {
      log.error(
        { service: def.name, error: err instanceof Error ? err.message : String(err) },
        'Restart failed',
      );
      managed.restarting = false;
      // Try again if under limit
      void this.restartService(managed);
      return;
    }

    managed.restarting = false;
  }

  private startHealthMonitor(managed: ManagedService): void {
    this.clearHealthMonitor(managed);

    managed.healthInterval = setInterval(async () => {
      const healthy = await this.checkHealth(managed.def.healthUrl);
      managed.lastHealthCheck = new Date();

      if (healthy) {
        if (!managed.healthy) {
          log.info({ service: managed.def.name }, 'Service recovered');
          this.emit('service:healthy', { name: managed.def.name });
        }
        managed.healthy = true;
        managed.consecutiveFailures = 0;
      } else {
        managed.consecutiveFailures++;
        managed.healthy = false;

        log.warn(
          { service: managed.def.name, failures: managed.consecutiveFailures },
          'Health check failed',
        );
        this.emit('service:unhealthy', {
          name: managed.def.name,
          failures: managed.consecutiveFailures,
        });

        // After 3 consecutive failures, attempt restart (only for spawned processes)
        if (managed.consecutiveFailures >= 3 && !managed.adopted) {
          log.warn(
            { service: managed.def.name },
            '3 consecutive health failures — triggering restart',
          );
          void this.restartService(managed);
        }
      }
    }, managed.def.healthIntervalMs);
  }

  private clearHealthMonitor(managed: ManagedService): void {
    if (managed.healthInterval) {
      clearInterval(managed.healthInterval);
      managed.healthInterval = undefined;
    }
  }

  private async checkHealth(url: string): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);
      try {
        const res = await fetch(url, { signal: controller.signal });
        return res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return false;
    }
  }
}
