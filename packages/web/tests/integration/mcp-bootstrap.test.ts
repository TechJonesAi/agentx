/**
 * MCP bootstrap + config-fallback integration tests.
 *
 * Verifies:
 *   - POST /api/mcp/bootstrap creates a starter config when none exists.
 *   - It is idempotent (existing config preserved).
 *   - allowRemote never auto-flips to true.
 *   - No server is enabled by default.
 *   - GET /api/mcp/servers falls back to on-disk config when the agent
 *     has no MCP client manager — so the UI can show the starter set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApiRouter } from '../../src/server/routes/api.js';

interface CallResult { status: number; body: Record<string, unknown> }

function call(router: ReturnType<typeof createApiRouter>, method: string, url: string): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method, url, headers: {} });
    process.nextTick(() => { (req as unknown as { emit(e: string): void }).emit('end'); });
    const chunks: Buffer[] = [];
    let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(code: number) { status = code; return this as http.ServerResponse; },
      setHeader() { return this as http.ServerResponse; },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status, body: raw ? JSON.parse(raw) : {} }); }
        catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

function fakeAgent(): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getDatabase: () => null,
    getConfig: () => ({ agent: {}, providers: {} }),
    getMCPClientManager: () => null,
    getSessionStore: () => null,
    getSessionManager: () => ({ listActive: () => [], resetSession: () => {} }),
    getToolRegistry: () => ({ getDefinitions: () => [] }),
  };
}

describe('MCP bootstrap + config fallback', () => {
  let tmpDataDir: string;
  let prevDataDir: string | undefined;
  let router: ReturnType<typeof createApiRouter>;

  beforeEach(() => {
    prevDataDir = process.env['DATA_DIR'];
    tmpDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-mcp-'));
    process.env['DATA_DIR'] = tmpDataDir;
    router = createApiRouter(fakeAgent() as never);
  });

  afterEach(() => {
    fs.rmSync(tmpDataDir, { recursive: true, force: true });
    if (prevDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = prevDataDir;
  });

  it('GET /api/mcp/servers shows starter defaults even before bootstrap writes the file', async () => {
    // loadMCPConfig returns DEFAULT_MCP_CONFIG when the file is missing,
    // so the UI sees the starter set immediately — but only as runtime
    // shape, not yet persisted to disk.
    const cfgPath = path.join(tmpDataDir, 'mcp.json');
    expect(fs.existsSync(cfgPath)).toBe(false);
    const r = await call(router, 'GET', '/api/mcp/servers');
    expect(r.status).toBe(200);
    const servers = r.body['servers'] as Array<{ enabled: boolean; safety: string }>;
    expect(servers.length).toBeGreaterThanOrEqual(5);
    expect(servers.every((s) => s.enabled === false)).toBe(true);
    expect(servers.every((s) => s.safety === 'green')).toBe(true);
    expect(r.body['allowRemote']).toBe(false);
  });

  it('POST /api/mcp/bootstrap creates starter config (all disabled, allowRemote false)', async () => {
    const r = await call(router, 'POST', '/api/mcp/bootstrap');
    expect(r.status).toBe(200);
    expect(r.body['bootstrapped']).toBe(true);
    expect(r.body['allowRemote']).toBe(false);
    const written = r.body['written'] as string[];
    expect(written.length).toBeGreaterThanOrEqual(5);
    expect(written).toContain('filesystem');

    // File matches contract
    const cfgPath = path.join(tmpDataDir, 'mcp.json');
    expect(fs.existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      allowRemote: boolean;
      mcpServers: Record<string, { enabled?: boolean }>;
    };
    expect(parsed.allowRemote).toBe(false);
    for (const [, s] of Object.entries(parsed.mcpServers)) {
      expect(s.enabled === true).toBe(false);
    }
  });

  it('bootstrap is idempotent and preserves user edits', async () => {
    await call(router, 'POST', '/api/mcp/bootstrap');
    const cfgPath = path.join(tmpDataDir, 'mcp.json');
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as {
      allowRemote: boolean;
      mcpServers: Record<string, { enabled?: boolean }>;
    };
    const firstName = Object.keys(cfg.mcpServers)[0]!;
    cfg.mcpServers[firstName]!.enabled = true;
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

    const b = await call(router, 'POST', '/api/mcp/bootstrap');
    expect(b.body['bootstrapped']).toBe(false);
    expect((b.body['existing'] as string[]).length).toBeGreaterThan(0);

    const after = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')) as typeof cfg;
    expect(after.mcpServers[firstName]!.enabled).toBe(true); // user edit kept
    expect(after.allowRemote).toBe(false); // never flipped
  });

  it('GET /api/mcp/servers after bootstrap surfaces config-file servers from disk', async () => {
    await call(router, 'POST', '/api/mcp/bootstrap');
    const r = await call(router, 'GET', '/api/mcp/servers');
    const servers = r.body['servers'] as Array<{ name: string; enabled: boolean; connected: boolean; safety: string }>;
    expect(servers.length).toBeGreaterThanOrEqual(5);
    expect(servers.every((s) => s.enabled === false)).toBe(true);
    expect(servers.every((s) => s.connected === false)).toBe(true);
    expect(servers.every((s) => s.safety === 'green')).toBe(true);
    expect(r.body['source']).toBe('config-file');
    expect(r.body['allowRemote']).toBe(false);
  });
});
