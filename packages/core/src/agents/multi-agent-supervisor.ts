/**
 * Multi-Agent Build Supervisor — Phase 8 + 8.1
 *
 * Coordinates specialist workers for complex build tasks.
 * Each worker runs in an ISOLATED session with its own context.
 * The supervisor controls the execution loop — workers do not drive each other.
 *
 * Architecture:
 *   User prompt → Supervisor decomposes into work packets
 *   → Each packet assigned to a specialist worker
 *   → Each worker gets its own sessionId (isolated context)
 *   → Workers execute via tool calls (shell, file creation)
 *   → Supervisor evaluates each result and decides next step
 *   → Failed workers trigger fix_worker automatically
 *   → Results merged into shared workspace
 *   → All steps logged for Projects visibility
 */

import { createLogger } from '../logger.js';
import { eventBus } from '../agent-loop/event-bus.js';

const log = createLogger('agents:multi-agent-supervisor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WorkerRole = 'architect' | 'scaffold' | 'ui' | 'service' | 'test' | 'fix';

/** Allowed write directories per worker role */
const WORKER_SCOPE: Record<WorkerRole, string[]> = {
  architect: [],                                    // No file creation
  scaffold: ['/', 'Sources/', 'Package.swift'],     // Root structure
  service: ['Models/', 'Services/', 'Sources/'],    // Data layer
  ui: ['Views/', 'Navigation/', 'Components/', 'Sources/'], // UI layer
  test: ['Tests/', 'Sources/'],                     // Test files
  fix: ['Models/', 'Services/', 'Views/', 'Navigation/', 'Sources/'], // Fix anything
};

export interface WorkPacket {
  id: string;
  role: WorkerRole;
  description: string;
  dependencies: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: string;
  filesCreated?: string[];
  error?: string;
  workerSessionId?: string;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
  retryCount: number;
  /** Allowed write scope directories for this worker */
  allowedScopes?: string[];
}

export interface SupervisorPlan {
  goalId: string;
  goal: string;
  workspace: string;
  appName: string;
  packets: WorkPacket[];
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  completedAt?: number;
  durationMs?: number;
  supervisorLog: SupervisorLogEntry[];
  cancelled?: boolean;
}

/** Execution control limits */
export interface ExecutionLimits {
  maxWorkerTimeoutMs: number;      // Per-worker timeout (default: 120s)
  maxPlanDurationMs: number;       // Total plan timeout (default: 600s / 10 min)
  maxConcurrentWorkers: number;    // Concurrency cap (default: 2, safe parallelism)
  modelCooldownMs: number;         // Unload heavy models after idle (default: 0, immediate)
}

const DEFAULT_LIMITS: ExecutionLimits = {
  maxWorkerTimeoutMs: 120_000,
  maxPlanDurationMs: 600_000,
  maxConcurrentWorkers: 2,
  modelCooldownMs: 60_000,
};

export interface SupervisorLogEntry {
  timestamp: number;
  action: string;
  role?: WorkerRole;
  packetId?: string;
  detail: string;
}

/**
 * Worker executor function signature.
 * Must accept a prompt AND a unique sessionId for worker isolation.
 */
export type WorkerExecutor = (
  prompt: string,
  workspace: string,
  workerSessionId: string,
) => Promise<string>;

// ---------------------------------------------------------------------------
// Worker Role System Prompts
// ---------------------------------------------------------------------------

const WORKER_SYSTEM_PROMPTS: Record<WorkerRole, string> = {
  architect: [
    'You are an Architecture Worker. Your job is to:',
    '1. Define the project structure (folders, key files)',
    '2. Identify major components/modules',
    '3. Define data models',
    '4. List file dependencies',
    'Output a clear, actionable architecture document.',
    'Do NOT create files yet — just plan the structure.',
  ].join('\n'),

  scaffold: [
    'You are a Scaffold Worker. Your job is to:',
    '1. Create the project directory structure',
    '2. Create entry point / main app files',
    '3. Set up configuration files',
    'Use the shell tool to create directories and files.',
    'Create one file per tool call for reliability.',
    'Use printf to write file content.',
  ].join('\n'),

  ui: [
    'You are a UI Worker. Your job is to:',
    '1. Create all view/screen files',
    '2. Implement navigation flow',
    '3. Create reusable UI components',
    'Use the shell tool to create files.',
    'Focus on UI structure, not business logic.',
    'Use printf to write file content.',
  ].join('\n'),

  service: [
    'You are a Service/Logic Worker. Your job is to:',
    '1. Create data models',
    '2. Create service/manager classes',
    '3. Implement business logic',
    '4. Create mock/stub APIs if needed',
    'Use the shell tool to create files.',
    'Use printf to write file content.',
  ].join('\n'),

  test: [
    'You are a Test Worker. Your job is to:',
    '1. List all files in the workspace',
    '2. Check each file exists and has content',
    '3. Report any missing files or empty stubs',
    '4. Verify project structure is complete',
    'Use the shell tool to inspect the workspace.',
    'Report a clear pass/fail verdict.',
  ].join('\n'),

  fix: [
    'You are a Fix Worker. Your job is to:',
    '1. Read the error/issue report carefully',
    '2. Identify the exact file(s) that need fixing',
    '3. Read the current file content',
    '4. Write the corrected version',
    '5. Verify the fix by reading the file again',
    'Use the shell tool to read and overwrite files.',
    'Use printf to write file content.',
  ].join('\n'),
};

const MAX_FIX_RETRIES = 2;

// ---------------------------------------------------------------------------
// MultiAgentBuildSupervisor
// ---------------------------------------------------------------------------

export class MultiAgentBuildSupervisor {
  private plans: Map<string, SupervisorPlan> = new Map();
  private workerExecutor: WorkerExecutor | null = null;
  private limits: ExecutionLimits;
  private scopeSetter: ((scope: { workspace: string; allowedScopes: string[] } | null) => void) | null = null;
  private cancelledPlans: Set<string> = new Set();
  private modelCooldownTimer: ReturnType<typeof setTimeout> | null = null;
  private onModelCooldown: (() => void) | null = null;

  constructor(limits?: Partial<ExecutionLimits>) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
  }

  /**
   * Set the executor function that workers use to run LLM + tool calls.
   * The executor MUST accept a workerSessionId for isolation.
   */
  setWorkerExecutor(executor: WorkerExecutor): void {
    this.workerExecutor = executor;
  }

  /**
   * Set callback for enforcing worker file scope on the sandbox.
   * Called with scope before worker starts, null after worker finishes.
   */
  setScopeSetter(setter: (scope: { workspace: string; allowedScopes: string[] } | null) => void): void {
    this.scopeSetter = setter;
  }

  /**
   * Set callback for model cooldown/unload after tasks complete.
   */
  setModelCooldownCallback(callback: () => void): void {
    this.onModelCooldown = callback;
  }

  /**
   * Cancel a running plan. No new workers will start.
   * Currently executing worker will finish but no more will be dispatched.
   */
  cancelPlan(goalId: string): boolean {
    const plan = this.plans.get(goalId);
    if (!plan) return false;
    if (plan.status !== 'executing') return false;

    this.cancelledPlans.add(goalId);
    plan.cancelled = true;
    plan.status = 'cancelled';
    plan.completedAt = Date.now();
    plan.durationMs = plan.completedAt - plan.createdAt;

    // Mark pending packets as cancelled
    for (const packet of plan.packets) {
      if (packet.status === 'pending') {
        packet.status = 'failed';
        packet.error = 'Plan cancelled by user';
      }
    }

    this.addLog(plan, 'plan_cancelled', 'Plan cancelled by user — no new workers will start');
    log.info({ goalId }, 'Supervisor: plan cancelled');
    eventBus.emit('multiagent.plan_cancelled', { goalId });
    return true;
  }

  /**
   * Cancel ALL running plans.
   */
  cancelAll(): number {
    let cancelled = 0;
    for (const [goalId, plan] of this.plans) {
      if (plan.status === 'executing') {
        if (this.cancelPlan(goalId)) cancelled++;
      }
    }
    log.info({ cancelled }, 'Supervisor: all plans cancelled');
    return cancelled;
  }

  /**
   * Check if a plan has been cancelled.
   */
  isCancelled(goalId: string): boolean {
    return this.cancelledPlans.has(goalId);
  }

  /**
   * Get all plans with their current status.
   */
  getRunningPlans(): SupervisorPlan[] {
    return Array.from(this.plans.values()).filter(p => p.status === 'executing');
  }

  /**
   * Get execution limits.
   */
  getLimits(): ExecutionLimits {
    return { ...this.limits };
  }

  /**
   * Decompose a build goal into work packets.
   */
  createPlan(goal: string, appName: string, workspace: string): SupervisorPlan {
    const goalId = `goal-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const packets = this.decompose(goal, goalId, appName);

    const plan: SupervisorPlan = {
      goalId,
      goal,
      workspace,
      appName,
      packets,
      status: 'planning',
      createdAt: Date.now(),
      supervisorLog: [{
        timestamp: Date.now(),
        action: 'plan_created',
        detail: `Decomposed into ${packets.length} work packets: ${packets.map(p => p.role).join(', ')}`,
      }],
    };

    this.plans.set(goalId, plan);

    log.info({
      goalId, appName, workspace,
      packetCount: packets.length,
      roles: packets.map(p => p.role),
    }, 'Multi-agent build plan created');

    eventBus.emit('multiagent.plan_created', {
      goalId, packetCount: packets.length,
      roles: packets.map(p => p.role),
    });

    return plan;
  }

  /**
   * High-level entry point for AgentLoopEngine orchestrator delegation.
   * Creates a plan from a goal description and executes it end-to-end.
   * Returns a summary string suitable for the loop's finalOutcome.
   */
  async executeGoal(description: string, sessionId?: string): Promise<string> {
    // Extract app name from description (first few meaningful words)
    const appName = description
      .replace(/^build\s+(a\s+)?/i, '')
      .split(/\s+/)
      .slice(0, 3)
      .join('-')
      .replace(/[^a-zA-Z0-9-]/g, '')
      .toLowerCase() || 'app';

    const workspace = process.env['AGENTX_TRUSTED_WORKSPACE']
      ?? `${process.env['HOME']}/Projects/AGENTX_APPS`;
    const buildPath = `${workspace}/${appName}`;

    log.info({ appName, workspace: buildPath, sessionId }, 'Multi-agent supervisor: executeGoal activated');

    const plan = this.createPlan(description, appName, buildPath);
    const result = await this.executePlan(plan.goalId);

    const completed = result.packets.filter(p => p.status === 'completed').length;
    const failed = result.packets.filter(p => p.status === 'failed').length;
    const total = result.packets.length;

    const summary = `Multi-agent build ${result.status}: ${completed}/${total} workers completed` +
      (failed > 0 ? `, ${failed} failed` : '') +
      ` (${result.durationMs ?? 0}ms). Roles: ${result.packets.map(p => `${p.role}:${p.status}`).join(', ')}`;

    log.info({ goalId: result.goalId, status: result.status, completed, failed, total }, summary);

    if (result.status === 'failed') {
      throw new Error(summary);
    }

    return summary;
  }

  /**
   * Execute a plan with supervisor-controlled loop.
   * Each worker gets an ISOLATED session. Supervisor evaluates each result.
   */
  async executePlan(goalId: string): Promise<SupervisorPlan> {
    const plan = this.plans.get(goalId);
    if (!plan) throw new Error(`Plan ${goalId} not found`);
    if (!this.workerExecutor) throw new Error('Worker executor not set');

    plan.status = 'executing';
    plan.cancelled = false;
    this.cancelledPlans.delete(goalId);
    this.addLog(plan, 'execution_started', `Starting execution of ${plan.packets.length} packets`);

    // Clear any pending model cooldown since we're about to use models
    if (this.modelCooldownTimer) {
      clearTimeout(this.modelCooldownTimer);
      this.modelCooldownTimer = null;
    }

    log.info({ goalId, packetCount: plan.packets.length, limits: this.limits }, 'Supervisor: execution started');
    eventBus.emit('multiagent.execution_started', { goalId });

    const planStart = Date.now();

    // Process packets with safe parallelism — run independent workers concurrently
    const processed = new Set<string>();
    let progress = true;

    while (progress) {
      progress = false;

      // ── CANCELLATION CHECK ──
      if (this.isCancelled(goalId)) {
        this.addLog(plan, 'cancelled_mid_execution', 'Plan cancelled — stopping all workers');
        log.info({ goalId }, 'Supervisor: plan cancelled mid-execution');
        break;
      }

      // ── PLAN DURATION CHECK ──
      if (Date.now() - planStart > this.limits.maxPlanDurationMs) {
        plan.status = 'failed';
        this.addLog(plan, 'plan_timeout', `Plan exceeded max duration (${this.limits.maxPlanDurationMs}ms)`);
        log.warn({ goalId, elapsed: Date.now() - planStart }, 'Supervisor: plan timed out');
        break;
      }

      // Find all ready packets (dependencies met, not yet processed)
      const readyPackets = plan.packets.filter(p =>
        p.status === 'pending' &&
        !processed.has(p.id) &&
        p.dependencies.every(depId => {
          const dep = plan.packets.find(d => d.id === depId);
          return dep?.status === 'completed';
        })
      );

      // Check for blocked packets (deps failed)
      for (const p of plan.packets.filter(pk => pk.status === 'pending' && !processed.has(pk.id))) {
        const depsFailed = p.dependencies.some(depId => {
          const dep = plan.packets.find(d => d.id === depId);
          return dep?.status === 'failed';
        });
        if (depsFailed) {
          p.status = 'failed';
          p.error = 'Dependencies not met — predecessor failed';
          processed.add(p.id);
          this.addLog(plan, 'worker_skipped', `Skipping ${p.role} — dependencies not met`, p.role, p.id);
          progress = true;
        }
      }

      if (readyPackets.length === 0) {
        // Check if there are still pending packets waiting for running deps
        const stillRunning = plan.packets.some(p => p.status === 'running');
        if (!stillRunning) break; // Nothing more to do
        // Wait briefly for running workers
        await new Promise(r => setTimeout(r, 100));
        continue;
      }

      // Run ready packets in parallel (bounded by maxConcurrentWorkers)
      const batch = readyPackets.slice(0, this.limits.maxConcurrentWorkers);

      if (batch.length > 1) {
        this.addLog(plan, 'parallel_batch', `Running ${batch.length} workers in parallel: ${batch.map(p => p.role).join(', ')}`);
        log.info({ goalId, parallel: batch.map(p => p.role) }, 'Supervisor: parallel batch started');
      }

      // Execute batch
      const results = await Promise.allSettled(
        batch.map(async (packet) => {
          processed.add(packet.id);
          await this.executeWorkerWithTimeout(packet, plan);

          // Fix loop for failed workers
          if (packet.status === 'failed' && packet.retryCount < MAX_FIX_RETRIES && packet.role !== 'fix') {
            this.addLog(plan, 'fix_triggered', `Worker ${packet.role} failed — triggering fix worker`, packet.role, packet.id);
            const fixPacket = this.createFixPacket(packet, plan);
            plan.packets.push(fixPacket);
            processed.add(fixPacket.id);
            await this.executeWorkerWithTimeout(fixPacket, plan);

            if (fixPacket.status === 'completed') {
              packet.retryCount++;
              packet.status = 'pending';
              processed.delete(packet.id); // Allow retry
              this.addLog(plan, 'retry_after_fix', `Retrying ${packet.role} after fix (attempt ${packet.retryCount})`, packet.role, packet.id);
            }
          }
        })
      );

      progress = true;
    }

    // Determine final status
    const completedCount = plan.packets.filter(p => p.status === 'completed').length;
    const failedCount = plan.packets.filter(p => p.status === 'failed').length;
    const totalNonFix = plan.packets.filter(p => p.role !== 'fix').length;

    // Don't override cancelled status (cancellation can happen asynchronously)
    if ((plan.status as string) !== 'cancelled') {
      plan.status = completedCount >= totalNonFix ? 'completed' : (completedCount > 0 ? 'completed' : 'failed');
    }
    plan.completedAt = Date.now();
    plan.durationMs = plan.completedAt - plan.createdAt;

    this.addLog(plan, 'execution_completed', `Finished: ${completedCount} completed, ${failedCount} failed, duration ${plan.durationMs}ms`);

    log.info({
      goalId, status: plan.status,
      completed: completedCount, failed: failedCount,
      durationMs: plan.durationMs,
    }, 'Supervisor: execution finished');

    eventBus.emit('multiagent.execution_completed', {
      goalId, status: plan.status,
      completed: completedCount, failed: failedCount,
      durationMs: plan.durationMs,
      log: plan.supervisorLog,
    });

    // ── Model cooldown: schedule heavy model unload after idle ──
    this.scheduleModelCooldown();

    return plan;
  }

  /**
   * Execute a worker with timeout enforcement.
   */
  private async executeWorkerWithTimeout(packet: WorkPacket, plan: SupervisorPlan): Promise<void> {
    const timeoutMs = this.limits.maxWorkerTimeoutMs;

    try {
      await Promise.race([
        this.executeWorker(packet, plan),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Worker ${packet.role} timed out after ${timeoutMs}ms`)), timeoutMs)
        ),
      ]);
    } catch (error) {
      if (error instanceof Error && error.message.includes('timed out')) {
        packet.status = 'failed';
        packet.error = error.message;
        this.addLog(plan, 'worker_timeout', `Worker ${packet.role} timed out after ${timeoutMs}ms`, packet.role, packet.id);
        log.warn({ packetId: packet.id, role: packet.role, timeoutMs }, 'Supervisor: worker timed out');
      }
    }
  }

  /**
   * Trigger immediate model cooldown after all tasks complete.
   * No delay — unload immediately when idle.
   */
  private scheduleModelCooldown(): void {
    if (this.modelCooldownTimer) clearTimeout(this.modelCooldownTimer);

    if (this.onModelCooldown && this.getRunningPlans().length === 0) {
      // Immediate unload — no delay
      log.info('Model cooldown: triggering immediate unload (system idle)');
      this.onModelCooldown();
    }
  }

  /**
   * Execute a single worker in an isolated session.
   */
  private async executeWorker(packet: WorkPacket, plan: SupervisorPlan): Promise<void> {
    if (!this.workerExecutor) return;

    // Create isolated session ID for this worker
    const workerSessionId = `worker-${packet.role}-${packet.id}-${Date.now()}`;
    packet.workerSessionId = workerSessionId;
    packet.status = 'running';
    packet.startedAt = Date.now();

    const workerPrompt = this.buildWorkerPrompt(packet, plan);

    this.addLog(plan, 'worker_started', `${packet.role} worker started (session: ${workerSessionId})`, packet.role, packet.id);

    log.info({
      packetId: packet.id, role: packet.role,
      workerSessionId,
      description: packet.description.slice(0, 60),
    }, 'Supervisor: worker started (isolated session)');

    eventBus.emit('multiagent.worker_started', {
      goalId: plan.goalId, packetId: packet.id,
      role: packet.role, workerSessionId,
    });

    // Set per-session worker scope constraint BEFORE execution (parallel-safe)
    if (packet.allowedScopes && packet.allowedScopes.length > 0) {
      const { setWorkerScopeForSession } = require('../security/sandbox.js');
      setWorkerScopeForSession(workerSessionId, { workspace: plan.workspace, allowedScopes: packet.allowedScopes });
    }

    try {
      const result = await this.workerExecutor(workerPrompt, plan.workspace, workerSessionId);
      packet.status = 'completed';
      packet.result = result;
      packet.completedAt = Date.now();
      packet.durationMs = packet.completedAt - (packet.startedAt ?? 0);

      this.addLog(plan, 'worker_completed', `${packet.role} worker completed in ${packet.durationMs}ms`, packet.role, packet.id);

      log.info({
        packetId: packet.id, role: packet.role,
        durationMs: packet.durationMs,
      }, 'Supervisor: worker completed');

      eventBus.emit('multiagent.worker_completed', {
        goalId: plan.goalId, packetId: packet.id,
        role: packet.role, durationMs: packet.durationMs,
      });
    } catch (error) {
      packet.status = 'failed';
      packet.error = error instanceof Error ? error.message : String(error);
      packet.completedAt = Date.now();
      packet.durationMs = packet.completedAt - (packet.startedAt ?? 0);

      this.addLog(plan, 'worker_failed', `${packet.role} worker failed: ${packet.error}`, packet.role, packet.id);

      log.error({
        packetId: packet.id, role: packet.role,
        error: packet.error, durationMs: packet.durationMs,
      }, 'Supervisor: worker failed');

      eventBus.emit('multiagent.worker_failed', {
        goalId: plan.goalId, packetId: packet.id,
        role: packet.role, error: packet.error,
      });
    } finally {
      // Clear per-session worker scope (parallel-safe)
      const { clearWorkerScopeForSession } = require('../security/sandbox.js');
      clearWorkerScopeForSession(workerSessionId);
    }
  }

  getPlan(goalId: string): SupervisorPlan | undefined {
    return this.plans.get(goalId);
  }

  getAllPlans(): SupervisorPlan[] {
    return Array.from(this.plans.values());
  }

  /**
   * Get a structured view of all plans for Projects UI.
   */
  getProjectsView(): Array<{
    goalId: string; appName: string; status: string;
    workers: Array<{ role: string; status: string; durationMs?: number }>;
    durationMs?: number;
  }> {
    return this.getAllPlans().map(plan => ({
      goalId: plan.goalId,
      appName: plan.appName,
      status: plan.status,
      workers: plan.packets.map(p => ({
        role: p.role,
        status: p.status,
        durationMs: p.durationMs,
      })),
      durationMs: plan.durationMs,
    }));
  }

  getDiagnostics(): Record<string, unknown> {
    const all = this.getAllPlans();
    return {
      totalPlans: all.length,
      executing: all.filter(p => p.status === 'executing').length,
      completed: all.filter(p => p.status === 'completed').length,
      failed: all.filter(p => p.status === 'failed').length,
      totalPackets: all.reduce((sum, p) => sum + p.packets.length, 0),
      totalFixAttempts: all.reduce((sum, p) => sum + p.packets.filter(pk => pk.role === 'fix').length, 0),
      hasExecutor: this.workerExecutor !== null,
    };
  }

  // ── Private helpers ────────────────────────────────────────────────

  private addLog(plan: SupervisorPlan, action: string, detail: string, role?: WorkerRole, packetId?: string): void {
    plan.supervisorLog.push({ timestamp: Date.now(), action, role, packetId, detail });
  }

  /**
   * Validate that a file path is within the worker's allowed scope.
   * Returns true if the path is allowed for this worker role.
   */
  validateFileScope(filePath: string, role: WorkerRole, workspace: string): boolean {
    const scopes = WORKER_SCOPE[role];
    if (!scopes || scopes.length === 0) return true; // No restrictions (e.g., architect)
    if (scopes.includes('/')) return true; // Root access allowed (scaffold)

    // Normalize path relative to workspace
    const relative = filePath.startsWith(workspace)
      ? filePath.slice(workspace.length).replace(/^\//, '')
      : filePath;

    // Check if relative path starts with any allowed scope
    return scopes.some(scope => relative.startsWith(scope) || relative.includes(`/${scope}`));
  }

  private decompose(goal: string, goalId: string, appName: string): WorkPacket[] {
    const lower = goal.toLowerCase();
    const packets: WorkPacket[] = [];
    let seq = 0;
    const pid = () => `${goalId}-wp${++seq}`;

    // Step 1: Architecture (always first)
    const archId = pid();
    packets.push({
      id: archId, role: 'architect',
      description: `Design the architecture for ${appName}: ${goal}`,
      dependencies: [], status: 'pending', retryCount: 0,
      allowedScopes: WORKER_SCOPE.architect,
    });

    // Step 2: Scaffold (depends on architecture)
    const scaffoldId = pid();
    packets.push({
      id: scaffoldId, role: 'scaffold',
      description: `Create project structure and entry points for ${appName}`,
      dependencies: [archId], status: 'pending', retryCount: 0,
      allowedScopes: WORKER_SCOPE.scaffold,
    });

    // Step 3+4: Services and UI — PARALLELIZABLE (both depend on scaffold, not each other)
    let serviceId: string | null = null;
    let uiId: string | null = null;

    if (lower.includes('login') || lower.includes('auth') || lower.includes('api') ||
        lower.includes('service') || lower.includes('data') || lower.includes('model') ||
        lower.includes('chat') || lower.includes('match') || lower.includes('profile')) {
      serviceId = pid();
      packets.push({
        id: serviceId, role: 'service',
        description: `Create data models and services for ${appName}: ${this.extractFeatures(goal)}. Write ONLY to Models/ and Services/ directories.`,
        dependencies: [scaffoldId], status: 'pending', retryCount: 0,
        allowedScopes: WORKER_SCOPE.service,
      });
    }

    if (lower.includes('ui') || lower.includes('view') || lower.includes('screen') ||
        lower.includes('page') || lower.includes('profile') || lower.includes('swipe') ||
        lower.includes('login') || lower.includes('setting') || lower.includes('app')) {
      uiId = pid();
      packets.push({
        id: uiId, role: 'ui',
        description: `Create UI views and screens for ${appName}: ${this.extractFeatures(goal)}. Write ONLY to Views/ and Navigation/ directories.`,
        dependencies: [scaffoldId], status: 'pending', retryCount: 0,
        allowedScopes: WORKER_SCOPE.ui,
      });
    }

    // Step 5: Test (depends on ALL preceding workers)
    const testDeps = [serviceId, uiId].filter(Boolean) as string[];
    if (testDeps.length === 0) testDeps.push(scaffoldId);
    const lastId = testDeps[testDeps.length - 1];
    packets.push({
      id: pid(), role: 'test',
      description: `Verify and test the ${appName} workspace — check all files exist and are valid`,
      dependencies: testDeps, status: 'pending', retryCount: 0,  // depends on ALL parallel workers
    });

    return packets;
  }

  private extractFeatures(goal: string): string {
    const features = [];
    const lower = goal.toLowerCase();
    if (lower.includes('login') || lower.includes('auth')) features.push('authentication');
    if (lower.includes('profile')) features.push('profile management');
    if (lower.includes('photo') || lower.includes('image')) features.push('photo upload');
    if (lower.includes('swipe') || lower.includes('match')) features.push('swipe/match');
    if (lower.includes('chat') || lower.includes('message')) features.push('messaging');
    if (lower.includes('setting')) features.push('settings');
    if (lower.includes('register') || lower.includes('sign up')) features.push('registration');
    return features.length > 0 ? features.join(', ') : 'all requested features';
  }

  private buildWorkerPrompt(packet: WorkPacket, plan: SupervisorPlan): string {
    const rolePrompt = WORKER_SYSTEM_PROMPTS[packet.role];

    // Gather context from completed predecessor packets
    const context = packet.dependencies
      .map(depId => plan.packets.find(p => p.id === depId))
      .filter(p => p?.status === 'completed' && p.result)
      .map(p => `[${p!.role} output]\n${p!.result!.slice(0, 2000)}`)
      .join('\n\n');

    return [
      `[WORKER ROLE: ${packet.role.toUpperCase()}]`,
      rolePrompt,
      '',
      `Project: ${plan.appName}`,
      `Workspace: ${plan.workspace}`,
      `Task: ${packet.description}`,
      '',
      context ? `--- Context from previous workers ---\n${context}\n--- End context ---` : '',
      '',
      `IMPORTANT:`,
      `- Write ALL files to ${plan.workspace}/`,
      `- Use printf or echo to create files via shell tool`,
      `- Create one file per tool call`,
      `- Report what you created when done`,
      packet.allowedScopes && packet.allowedScopes.length > 0
        ? `- FILE SCOPE: You may ONLY write to these directories: ${packet.allowedScopes.join(', ')}. Do NOT write outside your assigned scope.`
        : '',
    ].filter(Boolean).join('\n');
  }

  private createFixPacket(failedPacket: WorkPacket, plan: SupervisorPlan): WorkPacket {
    return {
      id: `${failedPacket.id}-fix-${failedPacket.retryCount + 1}`,
      role: 'fix',
      description: `Fix failure in ${failedPacket.role} worker for ${plan.appName}: ${failedPacket.error ?? 'unknown error'}. Workspace: ${plan.workspace}`,
      dependencies: [],
      status: 'pending',
      retryCount: 0,
    };
  }
}
