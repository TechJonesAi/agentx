/**
 * WorkflowRunStore.recentReliability — Batch 8E telemetry-orchestration
 * input. Computes success rate from terminal runs and returns null when
 * not enough samples exist.
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
  const sql = fs.readFileSync(path.join(__dirname, '../../src/db/migrations/008_workflow_runs.sql'), 'utf-8');
  d.exec(sql);
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-wf-rel-'));
  db = new Database(path.join(tmpDir, 'wf.db'));
  applyMigration(db);
  store = WorkflowRunStore.__createForTest(db);
}, 60_000);

afterEach(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
}, 60_000);

// Windows IO budget — better-sqlite3 INSERTs are ~30× slower on Windows
// CI runners (each create takes ~300ms vs ~10ms on Unix). The window
// test inserts 40 rows and exceeded the default 10s testTimeout. Bump
// to the existing IO budget the project uses for similar tests.
const SLOW_IO_TIMEOUT_MS = 60_000;

describe('WorkflowRunStore.recentReliability', () => {
  it('returns null when fewer than minSamples completed runs exist', () => {
    for (let i = 0; i < 4; i++) {
      const r = store.start({ goal: `g${i}` });
      store.markSuccess(r.loopId, 'ok');
    }
    expect(store.recentReliability({ minSamples: 5 })).toBeNull();
  });

  it('computes successRate over completed runs only', () => {
    for (let i = 0; i < 4; i++) {
      const r = store.start({ goal: `s${i}` });
      store.markSuccess(r.loopId, 'ok');
    }
    for (let i = 0; i < 6; i++) {
      const r = store.start({ goal: `f${i}` });
      store.markFailure(r.loopId, 'boom');
    }
    const stillRunning = store.start({ goal: 'still-running' });
    expect(stillRunning).toBeTruthy();

    const rel = store.recentReliability({ minSamples: 5 });
    expect(rel).not.toBeNull();
    expect(rel?.totalCompleted).toBe(10);
    expect(rel?.successRate).toBeCloseTo(0.4, 5);
  });

  it('respects the window when more runs exist than the window size', () => {
    for (let i = 0; i < 30; i++) {
      const r = store.start({ goal: `f${i}` });
      store.markFailure(r.loopId, 'old-failure');
    }
    for (let i = 0; i < 10; i++) {
      const r = store.start({ goal: `s${i}` });
      store.markSuccess(r.loopId, 'recent-success');
    }
    // Most recent 10 runs are all succeeded.
    const rel = store.recentReliability({ window: 10, minSamples: 5 });
    expect(rel?.totalCompleted).toBe(10);
    expect(rel?.successRate).toBe(1);
  }, SLOW_IO_TIMEOUT_MS);

  it('counts interrupted_by_restart as a failure (terminal non-success)', () => {
    const a = store.start({ goal: 'a' });
    store.markSuccess(a.loopId, 'ok');
    // Three runs left orphaned then recovered.
    for (let i = 0; i < 3; i++) store.start({ goal: `orphan${i}` });
    store.recoverIncomplete();
    // Three more clean successes.
    for (let i = 0; i < 3; i++) {
      const r = store.start({ goal: `s${i}` });
      store.markSuccess(r.loopId, 'ok');
    }
    const rel = store.recentReliability({ minSamples: 5 });
    expect(rel?.totalCompleted).toBe(7);
    expect(rel?.successRate).toBeCloseTo(4 / 7, 5);
  });
});
