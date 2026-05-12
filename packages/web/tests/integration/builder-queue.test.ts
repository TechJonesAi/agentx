/**
 * Tier 3 Builder Batch 2 — queue cancel/clear + GET queue upgrade.
 *
 * Tests use a real BuildQueueManager + IdleManager (both are silly-lifted
 * self-contained classes). No BuilderV2, no LLM, no I/O. Queue executes
 * are hanging promises that never resolve, so cancel/clear can act on
 * them without invoking the runner (which doesn't exist on this branch).
 *
 * Coverage:
 *   - cancel on empty queue → { cancelled: false }
 *   - clear on empty queue → { cleared: 0 }
 *   - clear with queued items → { cleared: N }, queue becomes empty,
 *     each submit() promise rejects
 *   - cancel with running build → { cancelled: true }, state reflects cancel
 *   - GET /api/builder/queue returns silly-compatible shape with idle
 *   - routes no longer return 501 shim envelope
 */
import { describe, it, expect } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';
import { BuildQueueManager, IdleManager } from '@agentx/core';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function call(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method, url, headers: {} });
    process.nextTick(() => {
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
        try { resolve({ status, body: raw ? JSON.parse(raw) : {}, raw }); }
        catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

function fakeAgent(opts: { queue?: BuildQueueManager; idle?: IdleManager } = {}): unknown {
  const queue = opts.queue ?? new BuildQueueManager();
  const idle = opts.idle ?? new IdleManager();
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    getBuildQueue: () => queue,
    getIdleManager: () => idle,
    getConfig() {
      return {
        agent: { name: 'X', defaultProvider: 'anthropic', model: 'claude-sonnet-4' },
        providers: {
          anthropic: { model: 'claude-sonnet-4', maxTokens: 4096 },
          openai: { model: 'gpt-4o', maxTokens: 4096 },
          ollama: { model: 'llama3', baseUrl: 'http://localhost:11434' },
        },
      };
    },
    getSessionStore() { return null; },
    getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
    getToolRegistry() { return { getDefinitions() { return []; } }; },
  };
}

describe('Tier 3 Builder Batch 2 — queue routes', () => {
  describe('POST /api/builder/queue/cancel', () => {
    it('returns { cancelled: false } on empty queue', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'POST', '/api/builder/queue/cancel');
      expect(r.status).toBe(200);
      expect(r.body['cancelled']).toBe(false);
      const state = r.body['state'] as Record<string, unknown>;
      expect(state['running']).toBeNull();
      expect(state['queued']).toEqual([]);
      expect(r.body['available']).toBeUndefined(); // not a shim
    });

    it('returns { cancelled: true } when a build is running', async () => {
      const queue = new BuildQueueManager();
      // Submit a hanging execute — promise never resolves. We do NOT await
      // queue.submit; we await one tick so it transitions to "running".
      const submitP = queue.submit({
        id: 'build-1',
        appName: 'demo',
        prompt: 'demo',
        workspace: '/tmp/demo',
        execute: () => new Promise<unknown>(() => { /* hang */ }),
      });
      // Silence "unhandled rejection" warning when cancel rejects this later.
      submitP.catch(() => { /* */ });
      // Wait a microtask so startBuild promotes the entry to currentBuild
      await Promise.resolve();
      await Promise.resolve();

      const router = createApiRouter(fakeAgent({ queue }) as never);
      const r = await call(router, 'POST', '/api/builder/queue/cancel');
      expect(r.status).toBe(200);
      expect(r.body['cancelled']).toBe(true);
      const state = r.body['state'] as Record<string, unknown>;
      // The cancelCurrent() implementation marks status='cancelled' but
      // leaves currentBuild in place until the runner observes it. We
      // assert the running entry's id matches what we submitted.
      expect(state['running']).toMatchObject({ id: 'build-1', appName: 'demo' });
    });
  });

  describe('POST /api/builder/queue/clear', () => {
    it('returns { cleared: 0 } on empty queue', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'POST', '/api/builder/queue/clear');
      expect(r.status).toBe(200);
      expect(r.body['cleared']).toBe(0);
    });

    it('rejects N queued submits when called with N pending', async () => {
      const queue = new BuildQueueManager();
      // The first submit becomes "running" (hangs). Subsequent submits
      // go into the queue. Track their rejection reasons.
      const reasons: string[] = [];
      const submits: Promise<unknown>[] = [];
      // Hanging running build — never resolves
      submits.push(queue.submit({
        id: 'b-running', appName: 'a0', prompt: 'p', workspace: '/tmp',
        execute: () => new Promise<unknown>(() => { /* hang */ }),
      }));
      submits[0].catch((e) => reasons.push('running:' + (e as Error).message));
      // Two queued builds — these will be cleared
      for (let i = 1; i <= 2; i++) {
        const p = queue.submit({
          id: `b-${i}`, appName: `a${i}`, prompt: 'p', workspace: '/tmp',
          execute: () => Promise.resolve('ok'),
        });
        p.catch((e) => reasons.push(`queued${i}:` + (e as Error).message));
        submits.push(p);
      }
      // Yield a microtask so the running entry settles into currentBuild.
      await Promise.resolve();
      await Promise.resolve();

      const router = createApiRouter(fakeAgent({ queue }) as never);
      const r = await call(router, 'POST', '/api/builder/queue/clear');
      expect(r.status).toBe(200);
      expect(r.body['cleared']).toBe(2);
      // Each queued submit promise has now rejected with the documented message.
      // Wait for those rejections to propagate.
      await new Promise((res) => setTimeout(res, 5));
      expect(reasons).toContain('queued1:Build cancelled — queue cleared');
      expect(reasons).toContain('queued2:Build cancelled — queue cleared');
      // Running build is untouched
      const state = r.body['state'] as Record<string, unknown>;
      expect(state['running']).toMatchObject({ id: 'b-running' });
      expect(state['queued']).toEqual([]);
    });
  });

  describe('GET /api/builder/queue (upgrade)', () => {
    it('returns silly-compatible shape on a fresh queue', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'GET', '/api/builder/queue');
      expect(r.status).toBe(200);
      // silly-compatible shape: running, queued, completed, maxConcurrent, idle
      expect(r.body).toHaveProperty('running', null);
      expect(r.body).toHaveProperty('queued');
      expect(Array.isArray(r.body['queued'])).toBe(true);
      expect((r.body['queued'] as unknown[])).toEqual([]);
      expect(r.body).toHaveProperty('completed');
      expect(Array.isArray(r.body['completed'])).toBe(true);
      expect(r.body).toHaveProperty('maxConcurrent', 1);
      expect(r.body).toHaveProperty('idle');
      const idle = r.body['idle'] as Record<string, unknown>;
      expect(idle).toHaveProperty('state', 'active');
      expect(typeof idle['lastActivityAt']).toBe('number');
      expect(typeof idle['idleTimeoutMs']).toBe('number');
      // Not the previous placeholder shape
      expect(r.body['available']).toBeUndefined();
      expect(r.body['reason']).toBeUndefined();
    });

    it('reflects a running build in the response', async () => {
      const queue = new BuildQueueManager();
      const submitP = queue.submit({
        id: 'q-1', appName: 'demo', prompt: 'p', workspace: '/tmp/w',
        execute: () => new Promise<unknown>(() => { /* hang */ }),
      });
      submitP.catch(() => { /* */ });
      await Promise.resolve(); await Promise.resolve();
      const router = createApiRouter(fakeAgent({ queue }) as never);
      const r = await call(router, 'GET', '/api/builder/queue');
      expect(r.status).toBe(200);
      expect(r.body['running']).toMatchObject({ id: 'q-1', appName: 'demo', workspace: '/tmp/w' });
    });
  });

  describe('Regressions', () => {
    it('cancel route no longer returns the 501 shim envelope', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'POST', '/api/builder/queue/cancel');
      expect(r.status).toBe(200);
      expect(r.body['reason']).not.toBe('not implemented on this build');
    });

    it('clear route no longer returns the 501 shim envelope', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'POST', '/api/builder/queue/clear');
      expect(r.status).toBe(200);
      expect(r.body['reason']).not.toBe('not implemented on this build');
    });
  });
});
