/**
 * Tier 2 batch C — POST /api/agent-loops/start asserted end-to-end via the
 * api router. NEVER runs a real loop. agent.runAgentLoop is stubbed in
 * every test; the engine itself is never constructed.
 *
 * Coverage:
 *   - env flag off → 503 agent_loops_disabled
 *   - missing goal → 400
 *   - empty goal  → 400
 *   - overlong goal (> 4000 chars) → 400
 *   - constraints > 50 items → 400
 *   - constraint > 256 chars → 400
 *   - success → 200 with silly-compatible shape (loopId, status, success,
 *     summary, steps, duration, tasks, reasoning, expectedOutcome, findings)
 *   - thrown engine error → safe 500
 *   - timeout → 504 with safe error
 *   - shim regression: route is no longer 501
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as http from 'node:http';
import { createApiRouter } from '../../src/server/routes/api.js';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function call(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
  body?: unknown,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : '';
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, {
      method,
      url,
      headers: data ? { 'content-type': 'application/json' } : {},
    });
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
        try { resolve({ status, body: raw ? JSON.parse(raw) : {}, raw }); }
        catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

function syntheticLoopState(): Record<string, unknown> {
  return {
    loopId: 'loop-test-1',
    status: 'completed',
    currentStep: 2,
    totalDuration: 12345,
    plan: {
      tasks: [
        { action: 'inspect', description: 'Check the codebase' },
        { action: 'analyze', description: 'Find candidate files' },
      ],
      reasoning: 'Inspect, then analyze.',
      expectedOutcome: 'A list of candidate files.',
    },
    executionResults: [
      { success: true, output: 'ok-1' },
      { success: true, output: 'ok-2' },
    ],
    reflections: [
      { analysis: 'Step 1 done.' },
      { analysis: 'Step 2 done.' },
    ],
    finalOutcome: { success: true, summary: 'Two-step plan completed.' },
  };
}

function fakeAgent(opts: { runAgentLoop?: (g: string, s?: string, c?: string[]) => Promise<unknown> } = {}): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    runAgentLoop: opts.runAgentLoop ?? (async () => syntheticLoopState()),
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

describe('Tier 2 batch C — POST /api/agent-loops/start', () => {
  let prevFlag: string | undefined;

  beforeEach(() => {
    prevFlag = process.env['AGENTX_ENABLE_AGENT_LOOPS'];
    // Enabled by default in each test — disabled tests opt back out.
    process.env['AGENTX_ENABLE_AGENT_LOOPS'] = 'true';
  });

  afterEach(() => {
    if (prevFlag === undefined) delete process.env['AGENTX_ENABLE_AGENT_LOOPS'];
    else process.env['AGENTX_ENABLE_AGENT_LOOPS'] = prevFlag;
  });

  it('returns 503 agent_loops_disabled when env flag is unset', async () => {
    delete process.env['AGENTX_ENABLE_AGENT_LOOPS'];
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'POST', '/api/agent-loops/start', { goal: 'do something' });
    expect(r.status).toBe(503);
    expect(r.body['available']).toBe(false);
    expect(r.body['reason']).toBe('agent_loops_disabled');
  });

  it('returns 503 agent_loops_disabled when env flag is "false"', async () => {
    process.env['AGENTX_ENABLE_AGENT_LOOPS'] = 'false';
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'POST', '/api/agent-loops/start', { goal: 'do something' });
    expect(r.status).toBe(503);
    expect(r.body['reason']).toBe('agent_loops_disabled');
  });

  it('returns 400 when goal field is missing', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'POST', '/api/agent-loops/start', { sessionId: 's1' });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toContain('goal');
  });

  it('returns 400 when goal is empty / whitespace-only', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r1 = await call(router, 'POST', '/api/agent-loops/start', { goal: '' });
    expect(r1.status).toBe(400);
    const r2 = await call(router, 'POST', '/api/agent-loops/start', { goal: '   \t  ' });
    expect(r2.status).toBe(400);
  });

  it('returns 400 when goal is too long (> 4000 chars)', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const huge = 'x'.repeat(4001);
    const r = await call(router, 'POST', '/api/agent-loops/start', { goal: huge });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toContain('4000');
  });

  it('returns 400 when constraints has > 50 items', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'POST', '/api/agent-loops/start', {
      goal: 'do something', constraints: Array.from({ length: 51 }, (_, i) => `c${i}`),
    });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toContain('50');
  });

  it('returns 400 when a single constraint exceeds 256 chars', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'POST', '/api/agent-loops/start', {
      goal: 'do something', constraints: ['ok', 'x'.repeat(257)],
    });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toContain('256');
  });

  it('returns 400 when constraints is not an array', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'POST', '/api/agent-loops/start', {
      goal: 'do something', constraints: 'not-an-array',
    });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toContain('array');
  });

  it('success path returns the silly-compatible shape', async () => {
    const runAgentLoop = vi.fn(async () => syntheticLoopState());
    const router = createApiRouter(fakeAgent({ runAgentLoop }) as never);
    const r = await call(router, 'POST', '/api/agent-loops/start', { goal: 'inspect then analyze' });
    expect(r.status).toBe(200);
    expect(r.body['loopId']).toBe('loop-test-1');
    expect(r.body['status']).toBe('completed');
    expect(r.body['success']).toBe(true);
    expect(r.body['summary']).toBe('Two-step plan completed.');
    expect(r.body['steps']).toBe(2);
    expect(r.body['duration']).toBe(12345);
    expect(r.body['reasoning']).toBe('Inspect, then analyze.');
    expect(r.body['expectedOutcome']).toBe('A list of candidate files.');
    const tasks = r.body['tasks'] as Array<{ action: string; description: string }>;
    expect(tasks).toHaveLength(2);
    expect(tasks[0].action).toBe('inspect');
    const findings = r.body['findings'] as Array<{ step: number; action: string; outcome: string; analysis: string }>;
    expect(findings).toHaveLength(2);
    expect(findings[0].step).toBe(1);
    expect(findings[0].outcome).toBe('success');
    expect(findings[0].analysis).toBe('Step 1 done.');
    expect(findings[1].step).toBe(2);
    // Confirms agent.runAgentLoop was called with the trimmed goal
    expect(runAgentLoop).toHaveBeenCalledWith('inspect then analyze', undefined, undefined);
    // Not a shim envelope
    expect(r.body['available']).toBeUndefined();
  });

  it('passes sessionId + filtered constraints to runAgentLoop', async () => {
    const runAgentLoop = vi.fn(async () => syntheticLoopState());
    const router = createApiRouter(fakeAgent({ runAgentLoop }) as never);
    await call(router, 'POST', '/api/agent-loops/start', {
      goal: 'plan something',
      sessionId: 'session-42',
      constraints: ['no-network', 'no-shell', 42 /* dropped — not a string */, 'limit:5m'],
    });
    expect(runAgentLoop).toHaveBeenCalledWith('plan something', 'session-42', ['no-network', 'no-shell', 'limit:5m']);
  });

  it('returns 500 with safe error when runAgentLoop throws', async () => {
    const runAgentLoop = vi.fn(async () => { throw new Error('planner failed: LLM unreachable'); });
    const router = createApiRouter(fakeAgent({ runAgentLoop }) as never);
    const r = await call(router, 'POST', '/api/agent-loops/start', { goal: 'try and fail' });
    expect(r.status).toBe(500);
    expect(String(r.body['error'])).toContain('planner failed');
    expect(r.body['available']).toBeUndefined();
  });

  it('returns 504 when runAgentLoop hangs past the server-side timeout', async () => {
    // Override the 6-min timeout for the test — we can't do that from
    // outside, so we instead simulate the timeout fast by NOT resolving
    // and relying on vitest's hookTimeout to NOT fire (our 10s test
    // timeout < 6min). To actually verify timeout behaviour without
    // waiting 6 minutes, we use a fast hang and stub setTimeout to fire
    // immediately via vi.useFakeTimers + vi.advanceTimersByTime.
    const router = createApiRouter(fakeAgent({
      runAgentLoop: () => new Promise<never>(() => { /* never resolves */ }),
    }) as never);
    vi.useFakeTimers();
    try {
      const promise = call(router, 'POST', '/api/agent-loops/start', { goal: 'forever' });
      // Advance virtual time past the 6-minute timeout
      await vi.advanceTimersByTimeAsync(6 * 60 * 1000 + 1000);
      const r = await promise;
      expect(r.status).toBe(504);
      expect(String(r.body['error'])).toContain('timed out');
      expect(r.body['available']).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('route is no longer shimmed (POST returns route response, not 501 envelope)', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'POST', '/api/agent-loops/start', { goal: 'check' });
    expect(r.status).toBe(200);
    expect(r.body['reason']).not.toBe('not implemented on this build');
  });
});
