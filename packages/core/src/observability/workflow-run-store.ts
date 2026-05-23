/**
 * WorkflowRunStore — Batch 6A durable workflow runtime persistence.
 *
 * Every workflow / autonomous loop registers its lifecycle here so the
 * dashboard can show real state and the engine can recover after restart.
 *
 * Schema (migration 008_workflow_runs.sql):
 *   - workflow_runs: one row per loop, current state + last update
 *   - workflow_events: append-only timeline of structured events
 *
 * Public surface:
 *   - start({loopId, goal, parentLoopId?, metadata?}) — INSERT new run
 *   - updatePhase(loopId, phase)
 *   - incrementRetry(loopId, reason)
 *   - markFailure(loopId, reason, repairAction?)
 *   - markSuccess(loopId, summary)
 *   - markPaused(loopId, reason)
 *   - markAwaitingApproval(loopId, repairAction)
 *   - resume(loopId, resumedFromState)
 *   - list({state?, limit?})
 *   - get(loopId)
 *   - getEvents(loopId, {limit?})
 *   - recoverIncomplete() — called at agent boot, marks any 'running' /
 *     'paused' / 'awaiting_approval' workflows from a prior process as
 *     'interrupted_by_restart' and emits a recovery event row. Returns
 *     the number of workflows transitioned so callers can log.
 *
 * Restart-durable: all state lives in SQLite. Engine restart → DB reopens
 * → recoverIncomplete() resolves orphaned runs.
 */
import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { createLogger } from '../logger.js';

const log = createLogger('observability:workflow-run-store');

export type WorkflowState =
  | 'running'
  | 'paused'
  | 'awaiting_approval'
  | 'succeeded'
  | 'failed'
  | 'interrupted_by_restart';

export type WorkflowEventKind =
  | 'start'
  | 'phase_change'
  | 'retry'
  | 'failure'
  | 'repair_attempt'
  | 'repair_outcome'
  | 'pause'
  | 'resume'
  | 'approval_request'
  | 'approval_granted'
  | 'approval_rejected'
  | 'success'
  | 'interrupted_by_restart'
  | 'recovered_after_restart';

export interface WorkflowRun {
  loopId: string;
  parentLoopId: string | null;
  goal: string;
  state: WorkflowState;
  executionPhase: string | null;
  retryCount: number;
  failureReason: string | null;
  repairAction: string | null;
  approvalRequired: boolean;
  resumedFromState: string | null;
  resultSummary: string | null;
  metadata: Record<string, unknown> | null;
  startedAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export interface WorkflowEvent {
  eventId: string;
  loopId: string;
  eventKind: WorkflowEventKind;
  detail: string | null;
  ts: number;
}

export class WorkflowRunStore {
  private db: Database.Database;
  private static singletonByDb = new WeakMap<Database.Database, WorkflowRunStore>();

  static get(db: Database.Database): WorkflowRunStore {
    let inst = WorkflowRunStore.singletonByDb.get(db);
    if (!inst) { inst = new WorkflowRunStore(db); WorkflowRunStore.singletonByDb.set(db, inst); }
    return inst;
  }

  /** Test-only factory binding to an arbitrary DB. */
  static __createForTest(db: Database.Database): WorkflowRunStore {
    return new WorkflowRunStore(db);
  }

  private constructor(db: Database.Database) { this.db = db; }

  start(args: { loopId?: string; goal: string; parentLoopId?: string; metadata?: Record<string, unknown> }): WorkflowRun {
    const now = Date.now();
    const loopId = args.loopId ?? `loop-${now}-${uuid().slice(0, 8)}`;
    this.db.prepare(`
      INSERT INTO workflow_runs (loop_id, parent_loop_id, goal, state, execution_phase, retry_count,
                                 approval_required, metadata_json, started_at, updated_at)
      VALUES (?, ?, ?, 'running', 'planning', 0, 0, ?, ?, ?)
    `).run(loopId, args.parentLoopId ?? null, args.goal, args.metadata ? JSON.stringify(args.metadata) : null, now, now);
    this._emit(loopId, 'start', JSON.stringify({ goal: args.goal, parentLoopId: args.parentLoopId ?? null }));
    return this.get(loopId)!;
  }

  updatePhase(loopId: string, phase: string): void {
    this.db.prepare(`UPDATE workflow_runs SET execution_phase = ?, updated_at = ? WHERE loop_id = ?`).run(phase, Date.now(), loopId);
    this._emit(loopId, 'phase_change', phase);
  }

  incrementRetry(loopId: string, reason: string): void {
    this.db.prepare(`UPDATE workflow_runs SET retry_count = retry_count + 1, updated_at = ?, failure_reason = ? WHERE loop_id = ?`).run(Date.now(), reason, loopId);
    this._emit(loopId, 'retry', reason);
  }

  markFailure(loopId: string, reason: string, repairAction?: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE workflow_runs SET state = 'failed', failure_reason = ?, repair_action = ?, updated_at = ?, completed_at = ? WHERE loop_id = ?
    `).run(reason, repairAction ?? null, now, now, loopId);
    this._emit(loopId, 'failure', JSON.stringify({ reason, repairAction: repairAction ?? null }));
  }

  markSuccess(loopId: string, summary: string): void {
    const now = Date.now();
    this.db.prepare(`UPDATE workflow_runs SET state = 'succeeded', result_summary = ?, updated_at = ?, completed_at = ? WHERE loop_id = ?`).run(summary, now, now, loopId);
    this._emit(loopId, 'success', summary);
  }

  markPaused(loopId: string, reason: string): void {
    this.db.prepare(`UPDATE workflow_runs SET state = 'paused', updated_at = ?, failure_reason = ? WHERE loop_id = ?`).run(Date.now(), reason, loopId);
    this._emit(loopId, 'pause', reason);
  }

  markAwaitingApproval(loopId: string, repairAction: string): void {
    this.db.prepare(`UPDATE workflow_runs SET state = 'awaiting_approval', approval_required = 1, repair_action = ?, updated_at = ? WHERE loop_id = ?`).run(repairAction, Date.now(), loopId);
    this._emit(loopId, 'approval_request', repairAction);
  }

  resume(loopId: string, resumedFromState: string): void {
    this.db.prepare(`UPDATE workflow_runs SET state = 'running', approval_required = 0, resumed_from_state = ?, updated_at = ? WHERE loop_id = ?`).run(resumedFromState, Date.now(), loopId);
    this._emit(loopId, 'resume', resumedFromState);
  }

  list(opts: { state?: WorkflowState; limit?: number } = {}): WorkflowRun[] {
    const limit = Math.max(1, Math.min(500, opts.limit ?? 100));
    const rows = opts.state
      ? this.db.prepare(`SELECT * FROM workflow_runs WHERE state = ? ORDER BY started_at DESC LIMIT ?`).all(opts.state, limit)
      : this.db.prepare(`SELECT * FROM workflow_runs ORDER BY started_at DESC LIMIT ?`).all(limit);
    return (rows as WorkflowRunRow[]).map(rowToRun);
  }

  get(loopId: string): WorkflowRun | null {
    const row = this.db.prepare(`SELECT * FROM workflow_runs WHERE loop_id = ?`).get(loopId) as WorkflowRunRow | undefined;
    return row ? rowToRun(row) : null;
  }

  getEvents(loopId: string, opts: { limit?: number } = {}): WorkflowEvent[] {
    const limit = Math.max(1, Math.min(1000, opts.limit ?? 200));
    const rows = this.db.prepare(`SELECT * FROM workflow_events WHERE loop_id = ? ORDER BY ts ASC LIMIT ?`).all(loopId, limit) as WorkflowEventRow[];
    return rows.map((r) => ({
      eventId: r.event_id,
      loopId: r.loop_id,
      eventKind: r.event_kind as WorkflowEventKind,
      detail: r.detail,
      ts: r.ts,
    }));
  }

  /** Called at agent boot. Any workflow left in a non-terminal state from
   *  a prior process is marked interrupted_by_restart and emits a recovery
   *  event so the operator can see what was lost. Returns the count. */
  recoverIncomplete(): number {
    const incomplete = this.db.prepare(`
      SELECT loop_id, state FROM workflow_runs
      WHERE state IN ('running', 'paused', 'awaiting_approval')
    `).all() as Array<{ loop_id: string; state: string }>;
    if (incomplete.length === 0) return 0;
    const now = Date.now();
    const update = this.db.prepare(`UPDATE workflow_runs SET state = 'interrupted_by_restart', updated_at = ?, completed_at = ? WHERE loop_id = ?`);
    const recoverEvent = this.db.prepare(`INSERT INTO workflow_events (event_id, loop_id, event_kind, detail, ts) VALUES (?, ?, 'interrupted_by_restart', ?, ?)`);
    const tx = this.db.transaction(() => {
      for (const r of incomplete) {
        update.run(now, now, r.loop_id);
        recoverEvent.run(uuid(), r.loop_id, JSON.stringify({ prev_state: r.state }), now);
      }
    });
    tx();
    log.info({ count: incomplete.length }, 'Recovered interrupted workflows after restart');
    return incomplete.length;
  }

  /** Batch 8E — workflow-success-aware routing input.
   *  Computes a recent-window success rate from terminal workflow_runs
   *  rows (succeeded vs failed/interrupted). Returns null when there
   *  aren't enough completed runs to be statistically meaningful. */
  recentReliability(opts: { window?: number; minSamples?: number } = {}): { totalCompleted: number; successRate: number } | null {
    const window = Math.max(1, Math.min(500, opts.window ?? 50));
    const minSamples = Math.max(1, opts.minSamples ?? 5);
    const rows = this.db.prepare(`
      SELECT state FROM workflow_runs
      WHERE state IN ('succeeded', 'failed', 'interrupted_by_restart')
      ORDER BY started_at DESC
      LIMIT ?
    `).all(window) as Array<{ state: string }>;
    if (rows.length < minSamples) return null;
    const successes = rows.filter((r) => r.state === 'succeeded').length;
    return { totalCompleted: rows.length, successRate: successes / rows.length };
  }

  /** Summary counts by state — feeds the Workflows dashboard panel. */
  summary(): Record<WorkflowState, number> {
    const rows = this.db.prepare(`SELECT state, COUNT(*) AS n FROM workflow_runs GROUP BY state`).all() as Array<{ state: string; n: number }>;
    const out: Record<string, number> = {
      running: 0, paused: 0, awaiting_approval: 0, succeeded: 0, failed: 0, interrupted_by_restart: 0,
    };
    for (const r of rows) out[r.state] = r.n;
    return out as Record<WorkflowState, number>;
  }

  private _emit(loopId: string, kind: WorkflowEventKind, detail: string | null): void {
    try {
      this.db.prepare(`INSERT INTO workflow_events (event_id, loop_id, event_kind, detail, ts) VALUES (?, ?, ?, ?, ?)`)
        .run(uuid(), loopId, kind, detail, Date.now());
    } catch (e) {
      log.error({ loopId, kind, error: e instanceof Error ? e.message : String(e) }, 'workflow_event insert failed');
    }
  }
}

// ── internal row shapes ────────────────────────────────────────────────
interface WorkflowRunRow {
  loop_id: string;
  parent_loop_id: string | null;
  goal: string;
  state: string;
  execution_phase: string | null;
  retry_count: number;
  failure_reason: string | null;
  repair_action: string | null;
  approval_required: number;
  resumed_from_state: string | null;
  result_summary: string | null;
  metadata_json: string | null;
  started_at: number;
  updated_at: number;
  completed_at: number | null;
}
interface WorkflowEventRow {
  event_id: string;
  loop_id: string;
  event_kind: string;
  detail: string | null;
  ts: number;
}

function rowToRun(r: WorkflowRunRow): WorkflowRun {
  return {
    loopId: r.loop_id,
    parentLoopId: r.parent_loop_id,
    goal: r.goal,
    state: r.state as WorkflowState,
    executionPhase: r.execution_phase,
    retryCount: r.retry_count,
    failureReason: r.failure_reason,
    repairAction: r.repair_action,
    approvalRequired: !!r.approval_required,
    resumedFromState: r.resumed_from_state,
    resultSummary: r.result_summary,
    metadata: r.metadata_json ? safeParse(r.metadata_json) : null,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    completedAt: r.completed_at,
  };
}
function safeParse(s: string): Record<string, unknown> | null {
  try { return JSON.parse(s); } catch { return null; }
}
