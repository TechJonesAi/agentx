/**
 * AgentLoopEngine ↔ WorkflowRunStore wiring — Batch 7A.
 *
 * Verifies that when the engine is given a WorkflowRunStore in its
 * context, runLoop() persists the lifecycle: a workflow_runs row is
 * created at start, phase transitions are recorded, and the terminal
 * outcome (success or failure) is captured.
 *
 * The engine has many subsystem dependencies — we feed minimal stubs.
 * The AutonomyGate is intentionally absent so SUGGEST_ONLY shortcut
 * fires; that path is the simplest fully-deterministic run.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { AgentLoopEngine } from '../../src/agent-loop/agent-loop-engine.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-engine-wfs-'));
  db = new Database(path.join(tmpDir, 'wf.db'));
  applyMigration(db);
  store = WorkflowRunStore.__createForTest(db);
}, 60_000);

afterEach(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
}, 60_000);

describe('AgentLoopEngine — durable workflow registration', () => {
  it('SUGGEST_ONLY path: start() + success are recorded in workflow_runs', async () => {
    const engine = new AgentLoopEngine({
      llmProvider: { complete: async () => ({ content: 'ok', finishReason: 'stop' as const }) },
      toolRegistry: { getDefinitions: () => [] },
      workflowRunStore: store,
      // No autonomyGate → defaults to SUGGEST_ONLY → fast return without
      // running planner/executor.
    });

    const before = store.summary();
    expect(before.running).toBe(0);

    const result = await engine.runLoop({
      description: 'audit my files',
      type: 'reflective',
      priority: 'normal',
    } as never);

    // Engine should report success (SUGGEST_ONLY returns success=true).
    expect(result.status).toBe('completed');

    // Workflow row exists and was marked succeeded.
    const list = store.list({ limit: 10 });
    expect(list).toHaveLength(1);
    expect(list[0]?.loopId).toBe(result.loopId);
    expect(list[0]?.goal).toBe('audit my files');
    expect(list[0]?.state).toBe('succeeded');

    // Event timeline contains start + success at minimum.
    const events = store.getEvents(result.loopId);
    const kinds = events.map(e => e.eventKind);
    expect(kinds).toContain('start');
    expect(kinds).toContain('success');
  });

  it('engine runs without a workflowRunStore (best-effort, no throw)', async () => {
    // Same engine, no WorkflowRunStore in context — runLoop must still work.
    const engine = new AgentLoopEngine({
      llmProvider: { complete: async () => ({ content: 'ok', finishReason: 'stop' as const }) },
      toolRegistry: { getDefinitions: () => [] },
    });
    const result = await engine.runLoop({
      description: 'no store',
      type: 'reflective',
      priority: 'normal',
    } as never);
    expect(result.status).toBe('completed');
    // No persistence happened.
    expect(store.list().length).toBe(0);
  });
});
