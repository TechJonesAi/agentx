/**
 * /api/builder/queue/events — SSE stream of build queue state.
 *
 * Tests run against a fake agent with a real BuildQueueManager so the
 * SSE handler exercises the actual getState() diff loop. We capture
 * res.write() chunks, parse the SSE events, and assert sequencing.
 */
import { describe, it, expect, vi } from 'vitest';
import * as http from 'node:http';
import { EventEmitter } from 'node:events';
import { createApiRouter } from '../../src/server/routes/api.js';
import { BuildQueueManager, IdleManager } from '@agentx/core';

interface SseHandle {
  chunks: string[];
  status: number;
  end(): void;
  emit(event: 'close' | 'error'): void;
}

/** Open the SSE route and capture writes. Caller closes via .end(). */
function openSse(
  router: ReturnType<typeof createApiRouter>,
  url: string,
): { handle: SseHandle; done: Promise<void> } {
  const req = new http.IncomingMessage(null as unknown as never);
  const reqEmitter = new EventEmitter();
  Object.assign(req, {
    method: 'GET', url, headers: {},
    on: (event: string, fn: (...a: unknown[]) => void) => reqEmitter.on(event, fn),
  });
  // The SSE handler subscribes on req.on('close') for cleanup — never emit
  // 'end' for this kind of stream; let the test signal close.
  let resolveDone: () => void = () => {};
  const done = new Promise<void>((r) => { resolveDone = r; });
  const chunks: string[] = [];
  let status = 0;
  const res: Partial<http.ServerResponse> = {
    writeHead(c: number) { status = c; return this as http.ServerResponse; },
    setHeader() { return this as http.ServerResponse; },
    write(c: string | Buffer) {
      chunks.push(typeof c === 'string' ? c : c.toString('utf-8'));
      return true;
    },
    end() { resolveDone(); return this as http.ServerResponse; },
  };
  void router.handle('GET', url, req, res as http.ServerResponse).catch(() => {});
  const handle: SseHandle = {
    chunks,
    get status() { return status; },
    end: () => resolveDone(),
    emit: (event) => reqEmitter.emit(event),
  } as unknown as SseHandle;
  Object.defineProperty(handle, 'status', { get: () => status });
  return { handle, done };
}

function fakeAgent(queue: BuildQueueManager): unknown {
  const idle = new IdleManager();
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    getBuildQueue: () => queue,
    getIdleManager: () => idle,
    getDatabase() { return null; },
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

function parseEvents(chunks: string[]): Array<{ event: string; data: unknown }> {
  const out: Array<{ event: string; data: unknown }> = [];
  const buf = chunks.join('');
  // Naive SSE parser: split on \n\n, handle `event:`/`data:` lines, skip comments.
  for (const block of buf.split('\n\n')) {
    if (!block.trim()) continue;
    if (block.startsWith(':')) continue; // heartbeat comment
    let event = 'message';
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (dataLines.length === 0) continue;
    try { out.push({ event, data: JSON.parse(dataLines.join('\n')) }); }
    catch { /* skip malformed */ }
  }
  return out;
}

describe('GET /api/builder/queue/events — SSE state stream', () => {
  it('emits an initial state event on connect', async () => {
    vi.useFakeTimers();
    const queue = new BuildQueueManager();
    const router = createApiRouter(fakeAgent(queue) as never);
    const { handle } = openSse(router, '/api/builder/queue/events');
    // Allow microtasks to flush
    await Promise.resolve();
    await Promise.resolve();
    const events = parseEvents(handle.chunks);
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].event).toBe('state');
    const state = events[0].data as { running: unknown; queued: unknown[]; completed: unknown[] };
    expect(state.running).toBeNull();
    expect(state.queued).toEqual([]);
    expect(state.completed).toEqual([]);
    handle.emit('close');
    vi.useRealTimers();
  });

  it('emits state changes when a build is submitted and completes', async () => {
    vi.useFakeTimers();
    const queue = new BuildQueueManager();
    const router = createApiRouter(fakeAgent(queue) as never);
    const { handle } = openSse(router, '/api/builder/queue/events');
    await Promise.resolve(); // initial emit
    expect(parseEvents(handle.chunks).length).toBeGreaterThanOrEqual(1);

    // Submit a build that finishes quickly
    const submitP = queue.submit({
      id: 'b-test-1', appName: 'demo', prompt: 'p', workspace: '/tmp/x',
      execute: async () => 'done',
    });
    // Advance the 1s state-diff interval and let the queue resolve
    await vi.advanceTimersByTimeAsync(1100);
    await submitP;
    await vi.advanceTimersByTimeAsync(1100);

    const events = parseEvents(handle.chunks);
    // We should have observed at least the initial empty state and a later
    // state that includes the completed build.
    const hasCompleted = events.some((e) => {
      const s = e.data as { completed: Array<{ id: string }> };
      return Array.isArray(s.completed) && s.completed.some((c) => c.id === 'b-test-1');
    });
    expect(hasCompleted).toBe(true);
    handle.emit('close');
    vi.useRealTimers();
  });

  it('returns 503 when build queue is unavailable', async () => {
    // Fake agent with no getBuildQueue
    const noQueueAgent = {
      async chat() { return 'ok'; }, async chatStream() {},
      getLastRetrievalMetadata() { return null; },
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
    const router = createApiRouter(noQueueAgent as never);
    // Use the simpler JSON helper since this should error before SSE upgrade.
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method: 'GET', url: '/api/builder/queue/events', headers: {} });
    process.nextTick(() => {
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = [];
    let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(c: number) { status = c; return this as http.ServerResponse; },
      setHeader() { return this as http.ServerResponse; },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
      },
    };
    await router.handle('GET', '/api/builder/queue/events', req, res as http.ServerResponse);
    expect(status).toBe(503);
    const raw = Buffer.concat(chunks).toString('utf-8');
    const body = JSON.parse(raw) as { error?: string };
    expect(String(body.error)).toMatch(/queue not available/i);
  });
});
