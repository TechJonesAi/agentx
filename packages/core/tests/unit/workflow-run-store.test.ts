/**
 * WorkflowRunStore — Batch 6A durable workflow persistence.
 *
 * Covers the full lifecycle (start, phase, retry, success, failure,
 * pause, resume, awaiting_approval), summary counts, event timeline,
 * and the recoverIncomplete() restart-recovery path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { WorkflowRunStore } from '../../src/observability/workflow-run-store.js';

let tmpDir: string;
let db: Database.Database;
let store: WorkflowRunStore;

function applyMigration(d: Database.Database): void {
  const sql = fs.readFileSync(
    path.join(__dirname, '../../src/db/migrations/008_workflow_runs.sql'),
    'utf-8',
  );
  d.exec(sql);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-wfrun-'));
  db = new Database(path.join(tmpDir, 'wf.db'));
  applyMigration(db);
  store = WorkflowRunStore.__createForTest(db);
}, 60_000);

afterEach(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
}, 60_000);

describe('WorkflowRunStore — start + lifecycle', () => {
  it('start() persists a running row and emits a start event', () => {
    const run = store.start({ goal: 'do thing' });
    expect(run.loopId).toMatch(/^loop-/);
    expect(run.state).toBe('running');
    expect(run.executionPhase).toBe('planning');
    expect(run.retryCount).toBe(0);

    const events = store.getEvents(run.loopId);
    expect(events).toHaveLength(1);
    expect(events[0]?.eventKind).toBe('start');
  });

  it('updatePhase + incrementRetry are persisted and journalled', () => {
    const run = store.start({ goal: 'g' });
    store.updatePhase(run.loopId, 'executing');
    store.incrementRetry(run.loopId, 'transient failure');

    const fresh = store.get(run.loopId)!;
    expect(fresh.executionPhase).toBe('executing');
    expect(fresh.retryCount).toBe(1);
    expect(fresh.failureReason).toBe('transient failure');

    const kinds = store.getEvents(run.loopId).map(e => e.eventKind);
    expect(kinds).toContain('phase_change');
    expect(kinds).toContain('retry');
  });

  it('markSuccess transitions to succeeded + sets completedAt', () => {
    const run = store.start({ goal: 'g' });
    store.markSuccess(run.loopId, 'great');
    const fresh = store.get(run.loopId)!;
    expect(fresh.state).toBe('succeeded');
    expect(fresh.resultSummary).toBe('great');
    expect(fresh.completedAt).not.toBeNull();
  });

  it('markFailure transitions to failed + records repair action', () => {
    const run = store.start({ goal: 'g' });
    store.markFailure(run.loopId, 'oops', 'restart subsystem');
    const fresh = store.get(run.loopId)!;
    expect(fresh.state).toBe('failed');
    expect(fresh.failureReason).toBe('oops');
    expect(fresh.repairAction).toBe('restart subsystem');
  });

  it('pause + resume round-trip', () => {
    const run = store.start({ goal: 'g' });
    store.markPaused(run.loopId, 'awaiting input');
    expect(store.get(run.loopId)!.state).toBe('paused');
    store.resume(run.loopId, 'paused');
    const fresh = store.get(run.loopId)!;
    expect(fresh.state).toBe('running');
    expect(fresh.resumedFromState).toBe('paused');
  });

  it('markAwaitingApproval sets approvalRequired + repairAction', () => {
    const run = store.start({ goal: 'g' });
    store.markAwaitingApproval(run.loopId, 'destructive db migration');
    const fresh = store.get(run.loopId)!;
    expect(fresh.state).toBe('awaiting_approval');
    expect(fresh.approvalRequired).toBe(true);
    expect(fresh.repairAction).toBe('destructive db migration');
  });
});

describe('WorkflowRunStore — list + summary', () => {
  it('list filters by state and limits results', () => {
    const a = store.start({ goal: 'a' });
    const b = store.start({ goal: 'b' });
    store.markSuccess(a.loopId, 'ok');
    expect(store.list({ state: 'running' }).map(r => r.loopId)).toEqual([b.loopId]);
    expect(store.list({ state: 'succeeded' }).map(r => r.loopId)).toEqual([a.loopId]);
    expect(store.list({ limit: 1 })).toHaveLength(1);
  });

  it('summary counts every state slot', () => {
    const a = store.start({ goal: 'a' });
    const b = store.start({ goal: 'b' });
    store.markSuccess(a.loopId, 'ok');
    store.markFailure(b.loopId, 'bad');
    const s = store.summary();
    expect(s.succeeded).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.running).toBe(0);
  });
});

describe('WorkflowRunStore — recoverIncomplete (restart durability)', () => {
  it('flips orphaned running/paused/awaiting_approval rows to interrupted_by_restart', () => {
    const a = store.start({ goal: 'still running' });
    const b = store.start({ goal: 'paused' });
    const c = store.start({ goal: 'awaiting approval' });
    const d = store.start({ goal: 'already done' });
    store.markPaused(b.loopId, 'wait');
    store.markAwaitingApproval(c.loopId, 'repair');
    store.markSuccess(d.loopId, 'ok');

    const count = store.recoverIncomplete();
    expect(count).toBe(3);
    expect(store.get(a.loopId)!.state).toBe('interrupted_by_restart');
    expect(store.get(b.loopId)!.state).toBe('interrupted_by_restart');
    expect(store.get(c.loopId)!.state).toBe('interrupted_by_restart');
    expect(store.get(d.loopId)!.state).toBe('succeeded');

    // Every recovered run has an interrupted_by_restart event row.
    for (const id of [a.loopId, b.loopId, c.loopId]) {
      const evs = store.getEvents(id);
      expect(evs.map(e => e.eventKind)).toContain('interrupted_by_restart');
    }
  });

  it('returns 0 when no incomplete runs exist', () => {
    expect(store.recoverIncomplete()).toBe(0);
  });

  it('SURVIVES restart: re-opening the same DB file reproduces state', () => {
    const a = store.start({ goal: 'persistent' });
    store.updatePhase(a.loopId, 'executing');
    store.incrementRetry(a.loopId, 'retry-1');
    db.close();

    // Re-open. New process, same file.
    const db2 = new Database(path.join(tmpDir, 'wf.db'));
    const store2 = WorkflowRunStore.__createForTest(db2);

    const fresh = store2.get(a.loopId)!;
    expect(fresh.goal).toBe('persistent');
    expect(fresh.executionPhase).toBe('executing');
    expect(fresh.retryCount).toBe(1);
    expect(fresh.state).toBe('running');

    const recovered = store2.recoverIncomplete();
    expect(recovered).toBe(1);
    expect(store2.get(a.loopId)!.state).toBe('interrupted_by_restart');

    db2.close();
    // Swap db reference so afterEach close is benign.
    db = new Database(path.join(tmpDir, 'wf.db'));
  });
});
