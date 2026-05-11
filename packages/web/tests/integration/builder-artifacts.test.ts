/**
 * Tier 3 Builder Batch 1 — GET /api/builder/artifacts.
 *
 * Defensive read. Coverage:
 *   - returns {artifacts: []} when table absent (fresh DB)
 *   - returns rows when table exists and is seeded
 *   - returns [] when getDatabase() is unavailable / null
 *   - LIMIT 100 is respected (105 rows inserted → 100 returned)
 *   - route is no longer shimmed (no 501 envelope)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApiRouter } from '../../src/server/routes/api.js';
import { createDatabase } from '@agentx/core';

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

function fakeAgent(opts: { db?: ReturnType<typeof createDatabase> | null } = {}): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    getDatabase: () => opts.db ?? null,
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

describe('Tier 3 Builder Batch 1 — GET /api/builder/artifacts', () => {
  let dbDir: string;
  let db: ReturnType<typeof createDatabase> | null = null;

  beforeEach(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-builder-artifacts-'));
  });

  afterEach(() => {
    try { db?.close(); } catch { /* */ }
    db = null;
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('returns {artifacts: []} when getDatabase() is null', async () => {
    const router = createApiRouter(fakeAgent({ db: null }) as never);
    const r = await call(router, 'GET', '/api/builder/artifacts');
    expect(r.status).toBe(200);
    expect(Array.isArray(r.body['artifacts'])).toBe(true);
    expect((r.body['artifacts'] as unknown[]).length).toBe(0);
    // Not a shim envelope
    expect(r.body['available']).toBeUndefined();
    expect(r.body['reason']).toBeUndefined();
  });

  it('returns {artifacts: []} when the build_artifacts table does not exist', async () => {
    db = createDatabase(dbDir);
    // Note: createDatabase does NOT create build_artifacts on main.
    const router = createApiRouter(fakeAgent({ db }) as never);
    const r = await call(router, 'GET', '/api/builder/artifacts');
    expect(r.status).toBe(200);
    expect((r.body['artifacts'] as unknown[]).length).toBe(0);
  });

  it('returns seeded rows when the table exists', async () => {
    db = createDatabase(dbDir);
    // Manually create the build_artifacts table that silly defines inside
    // its memory/database.ts — we don't add a migration in this batch, so
    // tests construct it themselves to verify the read path.
    db.exec(`
      CREATE TABLE IF NOT EXISTS build_artifacts (
        id TEXT PRIMARY KEY,
        build_id TEXT NOT NULL,
        type TEXT NOT NULL,
        path TEXT NOT NULL,
        size_bytes INTEGER,
        hash TEXT,
        version INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL
      );
    `);
    const NOW = Date.now();
    const insert = db.prepare(
      `INSERT INTO build_artifacts (id, build_id, type, path, size_bytes, hash, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insert.run('art-1', 'build-1', 'binary', '/tmp/a.bin', 1024, 'h1', 1, NOW - 1000);
    insert.run('art-2', 'build-1', 'log',    '/tmp/a.log',  256, 'h2', 1, NOW);
    insert.run('art-3', 'build-2', 'binary', '/tmp/b.bin', 2048, 'h3', 1, NOW - 500);

    const router = createApiRouter(fakeAgent({ db }) as never);
    const r = await call(router, 'GET', '/api/builder/artifacts');
    expect(r.status).toBe(200);
    const artifacts = r.body['artifacts'] as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(3);
    // Newest first (created_at DESC)
    expect(artifacts[0]['id']).toBe('art-2');
    expect(artifacts[1]['id']).toBe('art-3');
    expect(artifacts[2]['id']).toBe('art-1');
    expect(artifacts[0]['build_id']).toBe('build-1');
    expect(artifacts[0]['type']).toBe('log');
  });

  it('respects LIMIT 100 (105 rows inserted → 100 returned)', async () => {
    db = createDatabase(dbDir);
    db.exec(`
      CREATE TABLE IF NOT EXISTS build_artifacts (
        id TEXT PRIMARY KEY, build_id TEXT NOT NULL, type TEXT NOT NULL,
        path TEXT NOT NULL, size_bytes INTEGER, hash TEXT,
        version INTEGER DEFAULT 1, created_at INTEGER NOT NULL
      );
    `);
    const insert = db.prepare(
      `INSERT INTO build_artifacts (id, build_id, type, path, size_bytes, hash, version, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const NOW = Date.now();
    for (let i = 0; i < 105; i++) {
      insert.run(`art-${i}`, 'build-x', 'binary', `/tmp/${i}.bin`, i, `h${i}`, 1, NOW + i);
    }

    const router = createApiRouter(fakeAgent({ db }) as never);
    const r = await call(router, 'GET', '/api/builder/artifacts');
    expect(r.status).toBe(200);
    const artifacts = r.body['artifacts'] as Array<Record<string, unknown>>;
    expect(artifacts).toHaveLength(100);
    // Highest created_at first — art-104 inserted last
    expect(artifacts[0]['id']).toBe('art-104');
    expect(artifacts[99]['id']).toBe('art-5'); // 105 rows, top 100 newest = art-104 down to art-5
  });

  it('is no longer shimmed (no 501 envelope, no available:false)', async () => {
    const router = createApiRouter(fakeAgent() as never);
    const r = await call(router, 'GET', '/api/builder/artifacts');
    expect(r.status).toBe(200);
    expect(r.body['reason']).not.toBe('not implemented on this build');
    expect(r.body['available']).toBeUndefined();
  });
});
