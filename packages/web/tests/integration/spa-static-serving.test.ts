/**
 * Step 1 regression — SPA static serving with embedded HTML fallback.
 *
 * Verifies:
 *  - GET / serves built SPA index.html when `dist/client/index.html` exists.
 *  - GET / falls back to embedded HTML when the SPA build is absent.
 *  - GET /assets/foo.js serves the file with correct MIME when SPA is built.
 *  - GET /assets/foo.js returns 404 when SPA isn't built.
 *  - Path traversal (../) is blocked.
 *  - SPA history fallback: an unknown extensionless route returns SPA index
 *    when built, embedded HTML otherwise.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebServer, getEmbeddedHtml } from '../../src/server/index.js';

interface FakeAgentShape {
  chat(): Promise<string>;
  getLastRetrievalMetadata(): unknown;
  getConfig(): unknown;
  getSessionStore(): unknown;
  getSessionManager(): unknown;
  getToolRegistry(): unknown;
}

function fakeAgent(): FakeAgentShape {
  return {
    async chat() { return 'ok'; },
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
    getSessionManager() {
      return { listActive() { return []; }, resetSession() { /* no-op */ } };
    },
    getToolRegistry() { return { getDefinitions() { return []; } }; },
  };
}

interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function get(port: number, path: string): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'GET' },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf-8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function startServer(staticDir: string): Promise<{ server: WebServer; port: number }> {
  const server = new WebServer({
    port: 0, // ephemeral; we'll grab from listen
    host: '127.0.0.1',
    agent: fakeAgent() as unknown as never,
    staticDir,
  });
  // The WebServer doesn't expose the bound port for port:0, so we side-step
  // by picking a free port up-front via a throwaway listener.
  const tmp = http.createServer();
  await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', () => r()));
  const port = (tmp.address() as { port: number }).port;
  await new Promise<void>((r) => tmp.close(() => r()));

  // Reconfigure with the chosen port.
  const real = new WebServer({
    port,
    host: '127.0.0.1',
    agent: fakeAgent() as unknown as never,
    staticDir,
  });
  await real.start();
  return { server: real, port };
}

describe('SPA static serving — Step 1', () => {
  describe('when the SPA build exists', () => {
    let dir: string;
    let server: WebServer;
    let port: number;

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-spa-'));
      fs.mkdirSync(path.join(dir, 'assets'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'index.html'),
        '<!DOCTYPE html><html><body><div id="root"></div><script type="module" src="/assets/main-AAA.js"></script></body></html>',
      );
      fs.writeFileSync(path.join(dir, 'assets', 'main-AAA.js'), 'console.log("spa");');
      fs.writeFileSync(path.join(dir, 'assets', 'main-AAA.css'), 'body{background:#000;}');
      ({ server, port } = await startServer(dir));
    });

    afterAll(async () => {
      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('GET / serves the built SPA index.html (not embedded HTML)', async () => {
      const r = await get(port, '/');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.body).toContain('id="root"');
      expect(r.body).toContain('/assets/main-AAA.js');
      // distinct from the embedded fallback
      expect(r.body).not.toBe(getEmbeddedHtml());
    });

    it('GET /assets/main-AAA.js returns the JS asset with correct MIME', async () => {
      const r = await get(port, '/assets/main-AAA.js');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/javascript/);
      expect(r.body).toBe('console.log("spa");');
    });

    it('GET /assets/main-AAA.css returns the CSS asset with correct MIME', async () => {
      const r = await get(port, '/assets/main-AAA.css');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/css/);
    });

    it('GET /chat (extensionless) falls back to SPA index.html (history routing)', async () => {
      const r = await get(port, '/chat');
      expect(r.status).toBe(200);
      expect(r.body).toContain('id="root"');
    });

    it('blocks path traversal attempts', async () => {
      const r = await get(port, '/../package.json');
      // Either 404 or the SPA index — must NOT leak package.json.
      expect(r.body).not.toContain('"@agentx/web"');
    });
  });

  describe('when the SPA build is absent', () => {
    let dir: string;
    let server: WebServer;
    let port: number;

    beforeAll(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-no-spa-'));
      // intentionally empty — no index.html, no assets
      ({ server, port } = await startServer(dir));
    });

    afterAll(async () => {
      await server.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('GET / falls back to embedded HTML', async () => {
      const r = await get(port, '/');
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toMatch(/text\/html/);
      expect(r.body).toBe(getEmbeddedHtml());
    });

    it('GET /chat (extensionless, unknown route) falls back to embedded HTML', async () => {
      const r = await get(port, '/chat');
      expect(r.status).toBe(200);
      expect(r.body).toBe(getEmbeddedHtml());
    });

    it('GET /assets/missing.js returns 404 (not embedded HTML)', async () => {
      const r = await get(port, '/assets/missing.js');
      expect(r.status).toBe(404);
    });

    it('API routes are unaffected (e.g. /api/providers responds 200)', async () => {
      const r = await get(port, '/api/providers');
      expect(r.status).toBe(200);
      const body = JSON.parse(r.body);
      expect(body.active).toBe('anthropic');
    });
  });
});
