/**
 * /api/workflows* — Batch 6A integration tests.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import Database from 'better-sqlite3';
import { createApiRouter } from '../../src/server/routes/api.js';
import { WorkflowRunStore } from '@agentx/core';

interface CallResult { status: number; body: Record<string, unknown>; }

function call(router: ReturnType<typeof createApiRouter>, method: string, url: string, body?: unknown): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : '';
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method, url, headers: data ? { 'content-type': 'application/json' } : {} });
    process.nextTick(() => {
      if (data) (req as unknown as { emit(e: string, ...a: unknown[]): void }).emit('data', Buffer.from(data, 'utf-8'));
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = [];
    let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(code: number) { status = code; return this as http.ServerResponse; },
      setHeader() { return this as http.ServerResponse; },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status, body: raw ? JSON.parse(raw) : {} }); } catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

function baseAgent(store: WorkflowRunStore): unknown {
  return {
    async chat() { return ''; },
    async chatStream() { /* */ },
    getConfig() { return { agent: { name: 'X', defaultProvider: 'ollama', model: 'm' }, providers: { ollama: { model: 'm' } } }; },
    getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
    getToolRegistry() { return { getDefinitions() { return []; } }; },
    getWorkflowRunStore: () => store,
  };
}

let tmpDir: string;
let db: Database.Database;
let store: WorkflowRunStore;
let router: ReturnType<typeof createApiRouter>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-wf-route-'));
  db = new Database(path.join(tmpDir, 'wf.db'));
  const sql = fs.readFileSync(path.join(__dirname, '../../../core/src/db/migrations/008_workflow_runs.sql'), 'utf-8');
  db.exec(sql);
  store = WorkflowRunStore.__createForTest(db);
  router = createApiRouter(baseAgent(store) as never);
}, 60_000);

afterEach(() => {
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
}, 60_000);

describe('GET /api/workflows', () => {
  it('returns summary + runs list', async () => {
    const a = store.start({ goal: 'g-a' });
    store.markSuccess(a.loopId, 'ok');
    store.start({ goal: 'g-b' });

    const r = await call(router, 'GET', '/api/workflows');
    expect(r.status).toBe(200);
    expect(r.body['available']).toBe(true);
    const runs = r.body['runs'] as Array<{ goal: string }>;
    expect(runs).toHaveLength(2);
    const summary = r.body['summary'] as Record<string, number>;
    expect(summary.succeeded).toBe(1);
    expect(summary.running).toBe(1);
  });

  it('filters by state query param', async () => {
    const a = store.start({ goal: 'g-a' });
    store.markSuccess(a.loopId, 'ok');
    store.start({ goal: 'g-b' });

    const r = await call(router, 'GET', '/api/workflows?state=succeeded');
    const runs = r.body['runs'] as Array<{ goal: string }>;
    expect(runs).toHaveLength(1);
    expect(runs[0]?.goal).toBe('g-a');
  });
});

describe('GET /api/workflows/:loopId', () => {
  it('returns run + events', async () => {
    const a = store.start({ goal: 'g' });
    store.updatePhase(a.loopId, 'executing');
    const r = await call(router, 'GET', `/api/workflows/${a.loopId}`);
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    const events = r.body['events'] as Array<{ eventKind: string }>;
    expect(events.length).toBeGreaterThanOrEqual(2);
    expect(events.map(e => e.eventKind)).toContain('start');
    expect(events.map(e => e.eventKind)).toContain('phase_change');
  });

  it('returns 404 for unknown loopId', async () => {
    const r = await call(router, 'GET', '/api/workflows/does-not-exist');
    expect(r.status).toBe(404);
  });
});

describe('POST /api/workflows/:loopId/pause + /resume', () => {
  it('round-trips pause then resume', async () => {
    const a = store.start({ goal: 'g' });
    const p = await call(router, 'POST', `/api/workflows/${a.loopId}/pause`, { reason: 'manual' });
    expect(p.status).toBe(200);
    expect(store.get(a.loopId)!.state).toBe('paused');

    const r = await call(router, 'POST', `/api/workflows/${a.loopId}/resume`, { from: 'paused' });
    expect(r.status).toBe(200);
    expect(store.get(a.loopId)!.state).toBe('running');
  });

  it('pause returns 404 for unknown id', async () => {
    const r = await call(router, 'POST', '/api/workflows/nope/pause', {});
    expect(r.status).toBe(404);
  });
});

describe('POST /api/workflows/:loopId/reject — Batch 7A approval reject', () => {
  it('marks the workflow failed with [rejected] prefix and preserves the audit trail', async () => {
    const a = store.start({ goal: 'g' });
    store.markAwaitingApproval(a.loopId, 'destructive db migration');
    expect(store.get(a.loopId)!.state).toBe('awaiting_approval');

    const r = await call(router, 'POST', `/api/workflows/${a.loopId}/reject`, { reason: 'too risky' });
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);

    const fresh = store.get(a.loopId)!;
    expect(fresh.state).toBe('failed');
    expect(fresh.failureReason).toContain('rejected');
    expect(fresh.failureReason).toContain('too risky');

    // Audit trail preserved: approval_request stays in event timeline.
    const events = store.getEvents(a.loopId);
    const kinds = events.map(e => e.eventKind);
    expect(kinds).toContain('approval_request');
    expect(kinds).toContain('failure');
  });

  it('returns 404 for unknown id', async () => {
    const r = await call(router, 'POST', '/api/workflows/does-not-exist/reject', {});
    expect(r.status).toBe(404);
  });
});
