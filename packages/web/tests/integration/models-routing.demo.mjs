/**
 * Live demo — Tier 3 Models/Routing batch.
 *
 * Runs the route handlers directly (in-process) against a tmpdir-backed
 * routing.json. Proves:
 *   1. GET on a fresh dir returns DEFAULT_ROUTING_POLICY_CONFIG.
 *   2. POST persists a valid config.
 *   3. GET round-trips the persisted shape.
 *   4. The Ollama probe degrades gracefully when nothing's listening.
 *
 * No browser, no network. Run: node packages/web/tests/integration/models-routing.demo.mjs
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { createApiRouter } from '../../dist/server/routes/api.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-routing-demo-'));
process.env.DATA_DIR = tmp;
process.env.OLLAMA_HOST = 'http://127.0.0.1:1'; // closed port

const agent = {
  async chat() { return 'ok'; },
  async chatStream() {},
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
  getSessionManager() { return { listActive() { return []; }, resetSession() {} }; },
  getToolRegistry() { return { getDefinitions() { return []; } }; },
};

const router = createApiRouter(agent);

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null);
    const headers = body !== undefined ? { 'content-type': 'application/json' } : {};
    Object.assign(req, { method, url, headers });
    process.nextTick(() => {
      if (body !== undefined) req.emit('data', Buffer.from(JSON.stringify(body)));
      req.emit('end');
    });
    const chunks = [];
    let status = 0;
    const res = {
      writeHead(c) { status = c; return res; },
      setHeader() { return res; },
      write(c) { chunks.push(Buffer.from(c)); return true; },
      end(c) {
        if (c) chunks.push(Buffer.from(c));
        try { resolve({ status, body: JSON.parse(Buffer.concat(chunks).toString('utf-8')) }); }
        catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res).catch(reject);
  });
}

console.log('━━━ TIER 3 MODELS/ROUTING — LIVE DEMO ━━━');
console.log('tmpdir:', tmp);

const r1 = await call('GET', '/api/models/routing');
console.log('\n[1] GET (no routing.json yet) → status:', r1.status);
console.log('    policy.mode    :', r1.body.policy?.mode);
console.log('    availableModels:', r1.body.availableModels);
console.log('    ollama         :', r1.body.ollama);
if (r1.status !== 200 || r1.body.policy?.mode !== 'LOCAL_ONLY') throw new Error('GET-default failed');
if (r1.body.ollama?.reachable !== false) throw new Error('Ollama probe should be unreachable');

const r2 = await call('POST', '/api/models/routing', {
  mode: 'COMBINATION',
  capabilityPins: { code: 'qwen3-coder:30b', reasoning: 'llama3.1:70b-32k' },
  contextOverflowTokens: 24000,
  maxLocalFailuresBeforeCloud: 5,
});
console.log('\n[2] POST valid config → status:', r2.status);
console.log('    ok            :', r2.body.ok);
console.log('    policy.mode   :', r2.body.policy?.mode);
console.log('    policy.pins   :', r2.body.policy?.capabilityPins);
if (r2.status !== 200 || r2.body.ok !== true) throw new Error('POST-valid failed');

const onDisk = JSON.parse(fs.readFileSync(path.join(tmp, 'routing.json'), 'utf-8'));
console.log('\n[3] routing.json on disk:');
console.log('   ', JSON.stringify(onDisk, null, 2).replace(/\n/g, '\n    '));
if (onDisk.mode !== 'COMBINATION') throw new Error('on-disk mode wrong');

const r4 = await call('POST', '/api/models/routing', { mode: 'BOGUS' });
console.log('\n[4] POST invalid mode → status:', r4.status, 'error:', r4.body.error);
console.log('    details:', r4.body.details);
if (r4.status !== 400) throw new Error('POST-invalid should be 400');

const r5 = await call('GET', '/api/models/routing');
console.log('\n[5] GET round-trip → status:', r5.status, 'mode:', r5.body.policy?.mode);
if (r5.body.policy?.mode !== 'COMBINATION') throw new Error('round-trip failed');

console.log('\n━━━ ALL CHECKS PASSED — Strategy 3 routing config is live ━━━');
fs.rmSync(tmp, { recursive: true, force: true });
