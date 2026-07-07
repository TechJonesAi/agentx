/**
 * Provider readiness hardening — model verification + recommendation.
 *
 * Covers:
 *   - Anthropic ready=true with ANTHROPIC_API_KEY set
 *   - Anthropic ready=false + hint without API key
 *   - Ollama unreachable → ready=false, no availableModels
 *   - Ollama reachable but no models installed → ready=false with pull hint
 *   - Ollama reachable + configured model missing → ready=false, includes
 *     availableModels, recommendedModel, configuredModel; hint mentions
 *     POST /api/agent/provider/select-local-model
 *   - Ollama reachable + configured model installed exactly → ready=true
 *   - Ollama reachable + configured model installed via prefix (silly
 *     tags like "qwen2.5-coder:32b") → ready=true, model set to matched
 *     tag
 *   - POST /select-local-model: rejects when Ollama unreachable
 *   - POST /select-local-model: rejects when model not installed
 *   - POST /select-local-model: persists to routing.json forceModel
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApiRouter } from '../../src/server/routes/api.js';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function callJson(
  router: ReturnType<typeof createApiRouter>, method: string, url: string, body?: unknown,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    Object.assign(req, { method, url, headers });
    process.nextTick(() => {
      if (body !== undefined) {
        (req as unknown as { emit(e: string, c?: Buffer): void }).emit('data', Buffer.from(JSON.stringify(body)));
      }
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = []; let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(c: number) { status = c; return this as http.ServerResponse; },
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

function fakeAgent(opts: { provider?: 'anthropic' | 'openai' | 'ollama'; model?: string; ollamaModel?: string } = {}): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    getConfig() {
      return {
        agent: { name: 'X', defaultProvider: opts.provider ?? 'ollama', model: opts.model ?? 'qwen2.5-coder:32b' },
        providers: {
          anthropic: { model: 'claude-sonnet-4', maxTokens: 4096 },
          openai: { model: 'gpt-4o', maxTokens: 4096 },
          ollama: { model: opts.ollamaModel ?? opts.model ?? 'qwen2.5-coder:32b', baseUrl: 'http://localhost:11434' },
        },
      };
    },
    getSessionStore() { return null; },
    getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
    getToolRegistry() { return { getDefinitions() { return []; } }; },
  };
}

// Spin up a tiny HTTP server that emulates Ollama /api/tags for tests.
function startFakeOllama(models: Array<{ name: string; size?: number }>): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models }));
      } else {
        res.writeHead(404); res.end();
      }
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        // Force-terminate keep-alive sockets that Node's global fetch holds
        // open, otherwise server.close() waits on them forever and the run
        // never exits. closeAllConnections() makes teardown deterministic.
        close: () => { try { server.closeAllConnections?.(); server.close(); } catch { /* */ } },
      });
    });
  });
}

describe('Provider readiness — Anthropic', () => {
  const saved = process.env['ANTHROPIC_API_KEY'];
  afterEach(() => {
    if (saved === undefined) delete process.env['ANTHROPIC_API_KEY'];
    else process.env['ANTHROPIC_API_KEY'] = saved;
  });

  it('ready=true with ANTHROPIC_API_KEY set', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'sk-test';
    const router = createApiRouter(fakeAgent({ provider: 'anthropic', model: 'claude-sonnet-4' }) as never);
    const r = await callJson(router, 'GET', '/api/agent/provider/status');
    expect(r.body['provider']).toBe('anthropic');
    expect(r.body['ready']).toBe(true);
  });

  it('ready=false + hint when API key missing', async () => {
    delete process.env['ANTHROPIC_API_KEY'];
    const router = createApiRouter(fakeAgent({ provider: 'anthropic', model: 'claude-sonnet-4' }) as never);
    const r = await callJson(router, 'GET', '/api/agent/provider/status');
    expect(r.body['ready']).toBe(false);
    expect(String(r.body['hint'])).toMatch(/AGENT_DEFAULT_PROVIDER=ollama/);
  });
});

describe('Provider readiness — Ollama', () => {
  const savedHost = process.env['OLLAMA_HOST'];
  const savedDataDir = process.env['DATA_DIR'];
  const savedOllamaModel = process.env['OLLAMA_MODEL'];
  let fakeOllama: { url: string; close: () => void } | null = null;
  let tmpDir: string;

  beforeEach(() => {
    // Isolate from the user's real ~/.agentx/routing.json — resolveOllamaModel
    // reads it when DATA_DIR is unset, which would otherwise let the live
    // forceModel leak into test expectations.
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-pr-'));
    process.env['DATA_DIR'] = tmpDir;
    delete process.env['OLLAMA_MODEL'];
  });

  afterEach(() => {
    if (fakeOllama) { fakeOllama.close(); fakeOllama = null; }
    if (savedHost === undefined) delete process.env['OLLAMA_HOST'];
    else process.env['OLLAMA_HOST'] = savedHost;
    if (savedDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = savedDataDir;
    if (savedOllamaModel === undefined) delete process.env['OLLAMA_MODEL'];
    else process.env['OLLAMA_MODEL'] = savedOllamaModel;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('ready=false when Ollama unreachable', async () => {
    process.env['OLLAMA_HOST'] = 'http://127.0.0.1:1'; // closed port
    const router = createApiRouter(fakeAgent({ ollamaModel: 'llama3' }) as never);
    const r = await callJson(router, 'GET', '/api/agent/provider/status');
    expect(r.body['ready']).toBe(false);
    expect(String(r.body['hint'])).toMatch(/Start Ollama|OLLAMA_HOST/);
  });

  it('ready=false with pull hint when Ollama has 0 models', async () => {
    fakeOllama = await startFakeOllama([]);
    process.env['OLLAMA_HOST'] = fakeOllama.url;
    const router = createApiRouter(fakeAgent({ ollamaModel: 'qwen2.5-coder:32b' }) as never);
    const r = await callJson(router, 'GET', '/api/agent/provider/status');
    expect(r.body['ready']).toBe(false);
    expect(r.body['installedCount']).toBe(0);
    expect(String(r.body['reason'])).toMatch(/no models are installed/);
    expect(String(r.body['hint'])).toMatch(/ollama pull/);
  });

  it('ready=false + recommendation when configured model missing', async () => {
    fakeOllama = await startFakeOllama([
      { name: 'llama3.1:70b-instruct-q4_K_M', size: 42_000_000_000 },
      { name: 'qwen2.5-coder:14b', size: 9_000_000_000 },
    ]);
    process.env['OLLAMA_HOST'] = fakeOllama.url;
    const router = createApiRouter(fakeAgent({ model: 'llama3', ollamaModel: 'llama3' }) as never);
    const r = await callJson(router, 'GET', '/api/agent/provider/status');
    expect(r.body['ready']).toBe(false);
    expect(r.body['installedCount']).toBe(2);
    expect(r.body['configuredModel']).toBe('llama3');
    // Recommendation should prefer the coding model
    expect(r.body['recommendedModel']).toBe('qwen2.5-coder:14b');
    expect((r.body['availableModels'] as unknown[])).toHaveLength(2);
    expect(String(r.body['reason'])).toMatch(/not installed/i);
    expect(String(r.body['hint'])).toMatch(/select-local-model/);
  });

  it('ready=true when configured model exactly installed', async () => {
    fakeOllama = await startFakeOllama([
      { name: 'qwen2.5-coder:32b' },
    ]);
    process.env['OLLAMA_HOST'] = fakeOllama.url;
    const router = createApiRouter(fakeAgent({ ollamaModel: 'qwen2.5-coder:32b' }) as never);
    const r = await callJson(router, 'GET', '/api/agent/provider/status');
    expect(r.body['ready']).toBe(true);
    expect(r.body['model']).toBe('qwen2.5-coder:32b');
  });

  it('ready=true when configured model matches by prefix (size-suffix tag)', async () => {
    fakeOllama = await startFakeOllama([
      { name: 'llama3.1:70b-instruct-q4_K_M' },
    ]);
    process.env['OLLAMA_HOST'] = fakeOllama.url;
    const router = createApiRouter(fakeAgent({ model: 'llama3.1', ollamaModel: 'llama3.1' }) as never);
    const r = await callJson(router, 'GET', '/api/agent/provider/status');
    expect(r.body['ready']).toBe(true);
    expect(r.body['model']).toBe('llama3.1:70b-instruct-q4_K_M');
  });
});

describe('POST /api/agent/provider/select-local-model', () => {
  const savedHost = process.env['OLLAMA_HOST'];
  const savedData = process.env['DATA_DIR'];
  let fakeOllama: { url: string; close: () => void } | null = null;
  let dataDir: string;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-select-'));
    process.env['DATA_DIR'] = dataDir;
  });
  afterEach(() => {
    if (fakeOllama) { fakeOllama.close(); fakeOllama = null; }
    if (savedHost === undefined) delete process.env['OLLAMA_HOST'];
    else process.env['OLLAMA_HOST'] = savedHost;
    if (savedData === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = savedData;
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('rejects when Ollama unreachable (502)', async () => {
    process.env['OLLAMA_HOST'] = 'http://127.0.0.1:1';
    const router = createApiRouter(fakeAgent() as never);
    const r = await callJson(router, 'POST', '/api/agent/provider/select-local-model', { model: 'qwen2.5-coder:32b' });
    expect(r.status).toBe(502);
    expect(String(r.body['error'])).toMatch(/Ollama unreachable/);
  });

  it('rejects when model not installed (400)', async () => {
    fakeOllama = await startFakeOllama([{ name: 'llama3.1:70b' }]);
    process.env['OLLAMA_HOST'] = fakeOllama.url;
    const router = createApiRouter(fakeAgent() as never);
    const r = await callJson(router, 'POST', '/api/agent/provider/select-local-model', { model: 'does-not-exist' });
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toMatch(/not installed/);
    expect((r.body['availableModels'] as unknown[])).toEqual(['llama3.1:70b']);
  });

  it('persists selection to routing.json forceModel (200)', async () => {
    fakeOllama = await startFakeOllama([{ name: 'qwen2.5-coder:32b' }]);
    process.env['OLLAMA_HOST'] = fakeOllama.url;
    const router = createApiRouter(fakeAgent() as never);
    const r = await callJson(router, 'POST', '/api/agent/provider/select-local-model', { model: 'qwen2.5-coder:32b' });
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    expect(r.body['model']).toBe('qwen2.5-coder:32b');
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataDir, 'routing.json'), 'utf-8'));
    expect(onDisk.forceModel).toBe('qwen2.5-coder:32b');
  });

  it('rejects missing model field (400)', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await callJson(router, 'POST', '/api/agent/provider/select-local-model', {});
    expect(r.status).toBe(400);
    expect(String(r.body['error'])).toMatch(/model field is required/);
  });
});
