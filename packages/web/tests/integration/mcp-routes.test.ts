/**
 * Tier 2 batch B — MCP write routes asserted against a real on-disk mcp.json.
 *
 * Strategy 3: routes use loadMCPConfig/saveMCPConfig directly. Tests set
 * DATA_DIR to a tmpdir so writes don't pollute ~/.agentx. No MCP runtime
 * instance is constructed at any point.
 *
 * Coverage:
 *  - PUT /api/mcp/allow-remote happy path writes file
 *  - PUT /api/mcp/allow-remote rejects non-JSON / oversize / bad body
 *  - PUT /api/mcp/servers/:name happy path writes file
 *  - PUT /api/mcp/servers/:name rejects invalid name
 *  - PUT /api/mcp/servers/:name rejects unknown fields
 *  - PUT /api/mcp/servers/:name validation failure → 400
 *  - PUT /api/mcp/servers/:name enabled toggle handled
 *  - DELETE /api/mcp/servers/:name happy path removes config
 *  - DELETE non-existent server → 404
 *  - existing GET /api/mcp/servers and /api/mcp/tools still work
 *  - unrelated MCP route remains safe (404 / shim envelope)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApiRouter } from '../../src/server/routes/api.js';
import { loadMCPConfig } from '@agentx/core';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function call(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
  options: { body?: unknown; rawBody?: Buffer; contentType?: string } = {},
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const data = options.rawBody
      ? options.rawBody
      : (options.body !== undefined ? Buffer.from(JSON.stringify(options.body), 'utf-8') : undefined);
    const headers: Record<string, string> = {};
    if (data) {
      headers['content-type'] = options.contentType ?? 'application/json';
      headers['content-length'] = String(data.length);
    }
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method, url, headers });
    process.nextTick(() => {
      if (data) (req as unknown as { emit(e: string, ...a: unknown[]): void }).emit('data', data);
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
      destroy() { /* ignored — tests don't close streams */ return this as http.ServerResponse; },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

function fakeAgent(opts: { mcpManager?: unknown } = {}): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    getMCPClientManager: () => opts.mcpManager ?? null,
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

describe('Tier 2 batch B — MCP write routes (Strategy 3, no boot init)', () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-mcp-routes-'));
    prevDataDir = process.env['DATA_DIR'];
    process.env['DATA_DIR'] = tmpDir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = prevDataDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
  });

  describe('PUT /api/mcp/allow-remote', () => {
    it('writes allowRemote=true to mcp.json and reports requiresRestart', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'PUT', '/api/mcp/allow-remote', { body: { allowRemote: true } });
      expect(r.status).toBe(200);
      expect(r.body['allowRemote']).toBe(true);
      expect(r.body['requiresRestart']).toBe(true);
      const cfg = loadMCPConfig(tmpDir);
      expect(cfg.allowRemote).toBe(true);
    });

    it('rejects non-JSON content-type with 400', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'PUT', '/api/mcp/allow-remote', {
        rawBody: Buffer.from('allowRemote=true'),
        contentType: 'application/x-www-form-urlencoded',
      });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toContain('content-type');
    });

    it('rejects malformed JSON with 400', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'PUT', '/api/mcp/allow-remote', {
        rawBody: Buffer.from('{not valid json'),
        contentType: 'application/json',
      });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toContain('invalid JSON');
    });

    it('treats absent allowRemote field as false (defensive default)', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'PUT', '/api/mcp/allow-remote', { body: { other: true } });
      expect(r.status).toBe(200);
      expect(r.body['allowRemote']).toBe(false);
      expect(loadMCPConfig(tmpDir).allowRemote).toBe(false);
    });
  });

  describe('PUT /api/mcp/servers/:name', () => {
    it('writes a stdio server config and persists to disk', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'PUT', '/api/mcp/servers/myserver', {
        body: { command: 'npx', args: ['-y', '@example/mcp-server'], description: 'Demo' },
      });
      expect(r.status).toBe(200);
      expect(r.body['ok']).toBe(true);
      expect(r.body['name']).toBe('myserver');
      const cfg = loadMCPConfig(tmpDir);
      expect(cfg.mcpServers['myserver']).toBeDefined();
      expect(cfg.mcpServers['myserver'].command).toBe('npx');
      expect(cfg.mcpServers['myserver'].enabled).toBe(false); // default — not auto-enabled
    });

    it('rejects names with path-traversal characters (../etc)', async () => {
      const router = createApiRouter(fakeAgent() as never);
      // The route regex /^\/api\/mcp\/servers\/([^/]+)$/ already blocks slashes.
      // Test the name-validation regex via dot-only segment (still matches /).
      const r = await call(router, 'PUT', '/api/mcp/servers/..%2Fetc', {
        body: { command: 'sh' },
      });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toContain('Invalid server name');
    });

    it('rejects names with unsafe characters (spaces, backticks)', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'PUT', '/api/mcp/servers/' + encodeURIComponent('my server'), {
        body: { command: 'sh' },
      });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toContain('Invalid server name');
    });

    it('rejects unknown body fields', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'PUT', '/api/mcp/servers/myserver', {
        body: { command: 'npx', __proto__pollute: true, __filename: '/etc/shadow' },
      });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toContain('Unknown fields rejected');
    });

    it('returns 400 when validateServerConfig fails (missing command/url)', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'PUT', '/api/mcp/servers/myserver', {
        body: { description: 'no command, no url' },
      });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toContain('Invalid server config');
    });

    it('toggles enabled on an existing server', async () => {
      const router = createApiRouter(fakeAgent() as never);
      // 1. create
      await call(router, 'PUT', '/api/mcp/servers/myserver', { body: { command: 'npx' } });
      // 2. enable
      const r = await call(router, 'PUT', '/api/mcp/servers/myserver', { body: { enabled: true } });
      expect(r.status).toBe(200);
      expect(loadMCPConfig(tmpDir).mcpServers['myserver'].enabled).toBe(true);
    });

    it('refuses to toggle enabled on a non-existent server (no implicit create)', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'PUT', '/api/mcp/servers/ghost', { body: { enabled: true } });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toContain('Cannot toggle enabled on unknown server');
    });

    it('rejects oversized body (> 32 KB)', async () => {
      const router = createApiRouter(fakeAgent() as never);
      // Build a body just over 32 KB
      const huge = { command: 'npx', description: 'x'.repeat(40 * 1024) };
      const r = await call(router, 'PUT', '/api/mcp/servers/myserver', { body: huge });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toMatch(/body too large/i);
    });

    it('also calls manager methods when manager is wired', async () => {
      const upserts: Array<{ name: string; cfg: Record<string, unknown> }> = [];
      const enables: Array<{ name: string; enabled: boolean }> = [];
      const mgr = {
        upsertServer: (name: string, cfg: Record<string, unknown>) => upserts.push({ name, cfg }),
        async setServerEnabled(name: string, enabled: boolean) { enables.push({ name, enabled }); },
        async removeServer() { /* */ },
      };
      const router = createApiRouter(fakeAgent({ mcpManager: mgr }) as never);
      const r = await call(router, 'PUT', '/api/mcp/servers/wired', {
        body: { command: 'npx', enabled: true },
      });
      expect(r.status).toBe(200);
      expect(upserts).toHaveLength(1);
      expect(upserts[0].name).toBe('wired');
      expect(enables).toEqual([{ name: 'wired', enabled: true }]);
    });
  });

  describe('DELETE /api/mcp/servers/:name', () => {
    it('removes an existing server from disk', async () => {
      const router = createApiRouter(fakeAgent() as never);
      // Create
      await call(router, 'PUT', '/api/mcp/servers/dropme', { body: { command: 'npx' } });
      expect(loadMCPConfig(tmpDir).mcpServers['dropme']).toBeDefined();
      // Delete
      const r = await call(router, 'DELETE', '/api/mcp/servers/dropme');
      expect(r.status).toBe(200);
      expect(r.body['removed']).toBe(true);
      expect(loadMCPConfig(tmpDir).mcpServers['dropme']).toBeUndefined();
    });

    it('returns 404 with safe error for non-existent server', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'DELETE', '/api/mcp/servers/ghost');
      expect(r.status).toBe(404);
      expect(String(r.body['error'])).toContain('Unknown MCP server');
    });

    it('rejects invalid name', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'DELETE', '/api/mcp/servers/' + encodeURIComponent('bad name'));
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toContain('Invalid server name');
    });
  });

  describe('Regressions / safety', () => {
    it('GET /api/mcp/servers still works (returns []  with available:false)', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'GET', '/api/mcp/servers');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body['servers'])).toBe(true);
      expect(r.body['available']).toBe(false);
    });

    it('GET /api/mcp/tools still works', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'GET', '/api/mcp/tools');
      expect(r.status).toBe(200);
      expect(Array.isArray(r.body['tools'])).toBe(true);
    });

    it('Unrelated /api/mcp/* path returns the safe 404 envelope (not fake-available)', async () => {
      const router = createApiRouter(fakeAgent() as never);
      const r = await call(router, 'GET', '/api/mcp/something-not-implemented');
      expect(r.status).toBe(404);
      expect(r.body['available']).toBe(false);
      expect(typeof r.body['error']).toBe('string');
    });
  });
});
