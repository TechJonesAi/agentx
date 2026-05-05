/**
 * AutomationRunStore — Real implementation.
 *
 * In-memory store for automation runs and their steps.
 * Each run tracks: policy, runbook tasks, status, step history.
 */

import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';

const log = createLogger('services:automation-run-store');

export interface RunbookTask {
  description: string;
  tool: string;
  args: Record<string, unknown>;
}

export interface Runbook {
  title: string;
  tasks: RunbookTask[];
}

export type RunStatus = 'pending' | 'running' | 'paused' | 'completed' | 'failed' | 'killed';

export interface AutomationRun {
  id: string;
  policyId: string;
  runbook: Runbook;
  status: RunStatus;
  currentTaskIndex: number;
  startedAt: number | null;
  finishedAt: number | null;
  summary: RunSummary | null;
  errorMessage: string | null;
  createdAt: number;
}

export interface RunStep {
  id: string;
  runId: string;
  taskIndex: number;
  stepNumber: number;
  toolName: string;
  args: Record<string, unknown>;
  result: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'blocked';
  durationMs: number | null;
  errorMessage: string | null;
  createdAt: number;
}

export interface RunSummary {
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  blockedSteps: number;
  totalDurationMs: number;
  outcome: 'success' | 'partial' | 'failed';
}

export class RealAutomationRunStore {
  private runs = new Map<string, AutomationRun>();
  private steps = new Map<string, RunStep[]>(); // runId → steps

  constructor() {
    log.info('AutomationRunStore initialized (in-memory)');
  }

  /** Create a new run from a policy and runbook. */
  createRun(policyId: string, runbook: Runbook): AutomationRun {
    const now = Date.now();
    const run: AutomationRun = {
      id: uuid(),
      policyId,
      runbook,
      status: 'pending',
      currentTaskIndex: 0,
      startedAt: null,
      finishedAt: null,
      summary: null,
      errorMessage: null,
      createdAt: now,
    };
    this.runs.set(run.id, run);
    this.steps.set(run.id, []);
    log.info({ runId: run.id, policyId, taskCount: runbook.tasks.length }, 'Run created');
    return run;
  }

  /** Get a run by ID. */
  getRun(runId: string): AutomationRun | null {
    return this.runs.get(runId) ?? null;
  }

  /** List all runs, optionally filtered by status. */
  listRuns(filter?: { status?: RunStatus }): AutomationRun[] {
    const all = Array.from(this.runs.values());
    if (!filter?.status) return all;
    return all.filter((r) => r.status === filter.status);
  }

  /** Delete a run and its steps. */
  deleteRun(runId: string): boolean {
    const deleted = this.runs.delete(runId);
    this.steps.delete(runId);
    if (deleted) log.info({ runId }, 'Run deleted');
    return deleted;
  }

  /** Update run status with optional metadata. */
  updateRunStatus(runId: string, status: RunStatus, metadata?: Record<string, unknown>): void {
    const run = this.runs.get(runId);
    if (!run) return;
    run.status = status;
    if (metadata?.errorMessage) run.errorMessage = metadata.errorMessage as string;
    if (metadata?.finishedAt) run.finishedAt = metadata.finishedAt as number;
    if (status === 'running' && !run.startedAt) run.startedAt = Date.now();
    if (status === 'completed' || status === 'failed' || status === 'killed') {
      run.finishedAt = run.finishedAt ?? Date.now();
    }
    log.info({ runId, status }, 'Run status updated');
  }

  /** Add a step to a run. */
  addStep(step: RunStep): void {
    const runSteps = this.steps.get(step.runId);
    if (runSteps) {
      runSteps.push(step);
    } else {
      this.steps.set(step.runId, [step]);
    }
  }

  /** Get all steps for a run. */
  getSteps(runId: string): RunStep[] {
    return this.steps.get(runId) ?? [];
  }

  /** Update a step's result and status. */
  updateStep(runId: string, stepId: string, update: Partial<RunStep>): void {
    const runSteps = this.steps.get(runId);
    if (!runSteps) return;
    const step = runSteps.find((s) => s.id === stepId);
    if (!step) return;
    Object.assign(step, update);
  }

  /** Save (upsert) a run. Used by the engine to persist state. */
  save(run: AutomationRun): void {
    this.runs.set(run.id, run);
  }

  /** Build summary for a completed run. */
  buildSummary(runId: string): RunSummary {
    const runSteps = this.getSteps(runId);
    const completed = runSteps.filter((s) => s.status === 'completed').length;
    const failed = runSteps.filter((s) => s.status === 'failed').length;
    const blocked = runSteps.filter((s) => s.status === 'blocked').length;
    const totalDuration = runSteps.reduce((acc, s) => acc + (s.durationMs ?? 0), 0);
    const outcome = failed === 0 && blocked === 0 ? 'success' :
                    completed > 0 ? 'partial' : 'failed';
    return {
      totalSteps: runSteps.length,
      completedSteps: completed,
      failedSteps: failed,
      blockedSteps: blocked,
      totalDurationMs: totalDuration,
      outcome,
    };
  }
}
