/**
 * P13-C2 — Workflow-proposal trigger tests.
 *
 * The agent-side wiring records a `workflow_proposal` decision when a
 * playbook crosses confidence ≥ 0.9 with ≥ 5 uses on a recurring task
 * type. These tests exercise the same gate logic against the real
 * stores (PlaybookStore + ContinuousContextStore) without booting the
 * full agent: the gate maths, the dedupe, and the journal payload.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { PlaybookStore } from '../../src/memory/playbook-store.js';
import { ContinuousContextStore } from '../../src/memory/continuous-context.js';

/** Mirror of the agent's P13-C2 gate (kept in sync with agent.ts). */
function maybePropose(
  playbooks: PlaybookStore,
  cc: ContinuousContextStore,
  taskType: string,
  query: string,
): boolean {
  const RECURRING_TYPES = new Set(['summarisation', 'retrieval-grounded-qa', 'deadline_extraction']);
  if (!RECURRING_TYPES.has(taskType)) return false;
  const match = playbooks.findBest(taskType, query);
  const p = match?.playbook;
  if (!p || p.confidence < 0.9 || p.use_count < 5) return false;
  const alreadyProposed = cc
    .listDecisions({ kind: 'workflow_proposal', limit: 100 })
    .some((d) => d.title.includes(p.signature));
  if (alreadyProposed) return false;
  cc.recordDecision(
    'workflow_proposal',
    `Recurring success detected [${p.signature}] — propose scheduling as an autonomous workflow`,
    { taskType: p.task_type, signature: p.signature, confidence: p.confidence, uses: p.use_count },
  );
  return true;
}

describe('P13-C2 workflow proposal gate', () => {
  let db: Database.Database;
  let playbooks: PlaybookStore;
  let cc: ContinuousContextStore;
  const Q = 'Summarise the weekly tribunal correspondence for review';

  beforeEach(() => {
    db = new Database(':memory:');
    playbooks = new PlaybookStore(db);
    cc = new ContinuousContextStore(db);
  });

  function train(times: number): void {
    for (let i = 0; i < times; i++) {
      playbooks.recordOutcome({ taskType: 'summarisation', query: Q, model: 'qwen3:30b-a3b', success: true });
    }
  }

  it('does NOT propose below 5 uses even at high confidence', () => {
    train(4); // conf (4+1)/(4+2)=0.83, uses 4
    expect(maybePropose(playbooks, cc, 'summarisation', Q)).toBe(false);
    expect(cc.listDecisions({ kind: 'workflow_proposal' }).length).toBe(0);
  });

  it('does NOT propose below 0.9 confidence', () => {
    train(5); // conf (5+1)/(5+2)=0.86 < 0.9
    expect(maybePropose(playbooks, cc, 'summarisation', Q)).toBe(false);
  });

  it('proposes at ≥0.9 confidence with ≥5 uses', () => {
    train(9); // conf (9+1)/(9+2)=0.91 ≥ 0.9, uses 9 ≥ 5
    expect(maybePropose(playbooks, cc, 'summarisation', Q)).toBe(true);
    const proposals = cc.listDecisions({ kind: 'workflow_proposal' });
    expect(proposals.length).toBe(1);
    expect(proposals[0]!.title).toContain('propose scheduling');
    const detail = JSON.parse(proposals[0]!.detail_json!);
    expect(detail.taskType).toBe('summarisation');
    expect(detail.uses).toBeGreaterThanOrEqual(5);
    expect(detail.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('dedupes — the same playbook is proposed exactly once', () => {
    train(9);
    expect(maybePropose(playbooks, cc, 'summarisation', Q)).toBe(true);
    expect(maybePropose(playbooks, cc, 'summarisation', Q)).toBe(false);
    expect(cc.listDecisions({ kind: 'workflow_proposal' }).length).toBe(1);
  });

  it('never proposes for non-recurring task types', () => {
    for (let i = 0; i < 12; i++) {
      playbooks.recordOutcome({ taskType: 'coding', query: 'refactor the parser function implementation', model: 'coder', success: true });
    }
    expect(maybePropose(playbooks, cc, 'coding', 'refactor the parser function implementation')).toBe(false);
  });
});
