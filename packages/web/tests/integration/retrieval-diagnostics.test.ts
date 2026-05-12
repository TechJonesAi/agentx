/**
 * /api/retrieval/diagnostics — effective retrieval config + DB diagnostics.
 *
 * Verifies the route reports honestly across the four state combinations:
 *   - config off + env unset       → disabled, source=config
 *   - config off + env=true        → enabled, source=env
 *   - config on  + env unset       → enabled, source=config
 *   - config on  + env=false       → disabled, source=env
 * Plus: surfaces retrievalDocumentCount + memoryDocumentCount + actionable hint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createApiRouter } from '../../src/server/routes/api.js';

interface CallResult { status: number; body: Record<string, unknown>; }

function callGet(router: ReturnType<typeof createApiRouter>, url: string): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method: 'GET', url, headers: {} });
    process.nextTick(() => {
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
        try { resolve({ status, body: JSON.parse(raw) as Record<string, unknown> }); }
        catch (e) { reject(e); }
      },
    };
    router.handle('GET', url, req, res as http.ServerResponse).catch(reject);
  });
}

function fakeAgent(opts: { retrievalEnabled?: boolean; db?: unknown } = {}): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    getDatabase() { return opts.db ?? null; },
    getConfig() {
      return {
        agent: {
          name: 'X', defaultProvider: 'anthropic', model: 'claude-sonnet-4',
          retrieval: { enabled: !!opts.retrievalEnabled },
        },
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

describe('/api/retrieval/diagnostics', () => {
  const savedEnv = process.env['AGENT_RETRIEVAL_ENABLED'];
  const savedData = process.env['DATA_DIR'];
  let tmpDir: string;
  let db: Database.Database;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-retd-'));
    process.env['DATA_DIR'] = tmpDir;
    delete process.env['AGENT_RETRIEVAL_ENABLED'];
    // Tiny in-process DB with a documents table for the count probe.
    db = new Database(':memory:');
    db.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY); INSERT INTO documents (id) VALUES ('d1'),('d2');`);
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env['AGENT_RETRIEVAL_ENABLED'];
    else process.env['AGENT_RETRIEVAL_ENABLED'] = savedEnv;
    if (savedData === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = savedData;
    try { db.close(); } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('config off + env unset → disabled, source=config', async () => {
    const router = createApiRouter(fakeAgent({ retrievalEnabled: false, db }) as never);
    const r = await callGet(router, '/api/retrieval/diagnostics');
    expect(r.status).toBe(200);
    expect(r.body['enabled']).toBe(false);
    expect(r.body['source']).toBe('config');
    expect(String(r.body['hint'])).toMatch(/disabled by config|AGENT_RETRIEVAL_ENABLED=true/i);
  });

  it('config off + env=true → enabled, source=env', async () => {
    process.env['AGENT_RETRIEVAL_ENABLED'] = 'true';
    const router = createApiRouter(fakeAgent({ retrievalEnabled: false, db }) as never);
    const r = await callGet(router, '/api/retrieval/diagnostics');
    expect(r.body['enabled']).toBe(true);
    expect(r.body['source']).toBe('env');
    expect(r.body['retrievalDocumentCount']).toBe(2);
  });

  it('config on + env unset → enabled, source=config', async () => {
    const router = createApiRouter(fakeAgent({ retrievalEnabled: true, db }) as never);
    const r = await callGet(router, '/api/retrieval/diagnostics');
    expect(r.body['enabled']).toBe(true);
    expect(r.body['source']).toBe('config');
  });

  it('config on + env=false → disabled, source=env', async () => {
    process.env['AGENT_RETRIEVAL_ENABLED'] = 'false';
    const router = createApiRouter(fakeAgent({ retrievalEnabled: true, db }) as never);
    const r = await callGet(router, '/api/retrieval/diagnostics');
    expect(r.body['enabled']).toBe(false);
    expect(r.body['source']).toBe('env');
  });

  it('reports retrievalDocumentCount from the agent DB', async () => {
    process.env['AGENT_RETRIEVAL_ENABLED'] = 'true';
    const router = createApiRouter(fakeAgent({ retrievalEnabled: false, db }) as never);
    const r = await callGet(router, '/api/retrieval/diagnostics');
    expect(r.body['retrievalDocumentCount']).toBe(2);
  });

  it('hint surfaces the gap when retrieval enabled but agent DB empty', async () => {
    const emptyDb = new Database(':memory:');
    emptyDb.exec(`CREATE TABLE documents (id TEXT PRIMARY KEY);`);
    // Memory DB falls back to agent DB through getMemoryDbHandle's fallback
    // when no cognitive_memory.db file exists. So memoryDocumentCount == 0
    // too in this isolated test. Still verifies the hint surfaces the
    // "enabled but no docs" case.
    process.env['AGENT_RETRIEVAL_ENABLED'] = 'true';
    const router = createApiRouter(fakeAgent({ db: emptyDb }) as never);
    const r = await callGet(router, '/api/retrieval/diagnostics');
    expect(r.body['enabled']).toBe(true);
    expect(r.body['retrievalDocumentCount']).toBe(0);
    expect(String(r.body['hint'])).toMatch(/No documents|enabled/i);
    try { emptyDb.close(); } catch { /* */ }
  });
});
