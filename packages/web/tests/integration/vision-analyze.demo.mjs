/**
 * Live demo — Tier 3 Vision/analyze batch.
 *
 * Runs POST /api/vision/analyze through the in-process router with a mocked
 * VisionProvider. Proves:
 *   1. Non-multipart body → 400
 *   2. No image part → 400
 *   3. Unavailable provider → 200 { available: false, reason, model }
 *   4. Success → 200 { available: true, description, latencyMs }
 *   5. Builder/run permanent shim → 501 { available: false, reason }
 *
 * No live Ollama dependency.
 */
import * as http from 'node:http';
import { createApiRouter } from '../../dist/server/routes/api.js';
import {
  setVisionProviderForTesting,
  clearVisionProviderForTesting,
} from '../../../core/dist/multimodal/vision-service.js';

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

function callMultipart(url, parts) {
  return new Promise((resolve, reject) => {
    const boundary = '----demoboundary' + Math.random().toString(16).slice(2);
    const chunks = [];
    for (const p of parts) {
      let h = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
      if (p.filename) h += `; filename="${p.filename}"`;
      h += '\r\n';
      if (p.contentType) h += `Content-Type: ${p.contentType}\r\n`;
      h += '\r\n';
      chunks.push(Buffer.from(h, 'utf-8'));
      chunks.push(p.data);
      chunks.push(Buffer.from('\r\n', 'utf-8'));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'));
    const body = Buffer.concat(chunks);
    const req = new http.IncomingMessage(null);
    Object.assign(req, { method: 'POST', url,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    process.nextTick(() => { req.emit('data', body); req.emit('end'); });
    const out = []; let status = 0;
    const res = {
      writeHead(c) { status = c; return res; },
      setHeader() { return res; },
      write(c) { out.push(Buffer.from(c)); return true; },
      end(c) {
        if (c) out.push(Buffer.from(c));
        try { resolve({ status, body: JSON.parse(Buffer.concat(out).toString('utf-8')) }); }
        catch (e) { reject(e); }
      },
    };
    router.handle('POST', url, req, res).catch(reject);
  });
}

function callPlain(method, url, ctype, payload) {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null);
    Object.assign(req, { method, url, headers: ctype ? { 'content-type': ctype } : {} });
    process.nextTick(() => {
      if (payload) req.emit('data', payload);
      req.emit('end');
    });
    const out = []; let status = 0;
    const res = {
      writeHead(c) { status = c; return res; },
      setHeader() { return res; },
      write(c) { out.push(Buffer.from(c)); return true; },
      end(c) {
        if (c) out.push(Buffer.from(c));
        try { resolve({ status, body: JSON.parse(Buffer.concat(out).toString('utf-8')) }); }
        catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res).catch(reject);
  });
}

console.log('━━━ TIER 3 VISION/ANALYZE + BUILDER-RUN SHIM — LIVE DEMO ━━━');

// 1. Non-multipart
const r1 = await callPlain('POST', '/api/vision/analyze', 'application/json',
  Buffer.from('{"x":1}'));
console.log('\n[1] POST /api/vision/analyze (json body) →', r1.status, r1.body.error);
if (r1.status !== 400) throw new Error('expected 400');

// 2. Missing image part
const r2 = await callMultipart('/api/vision/analyze', [{ name: 'notes', data: Buffer.from('hi') }]);
console.log('[2] POST /api/vision/analyze (no image) →', r2.status, r2.body.error);
if (r2.status !== 400) throw new Error('expected 400');

// 3. Unavailable provider
setVisionProviderForTesting({
  isAvailable: async () => false,
  describe: async () => ({ description: '[Vision not available]' }),
});
const r3 = await callMultipart('/api/vision/analyze', [
  { name: 'image', filename: 'a.png', contentType: 'image/png',
    data: Buffer.from([0x89,0x50,0x4e,0x47]) },
]);
console.log('[3] POST /api/vision/analyze (unavailable provider) →', r3.status);
console.log('    body:', JSON.stringify(r3.body));
if (r3.status !== 200 || r3.body.available !== false) throw new Error('expected available:false');

// 4. Successful provider
setVisionProviderForTesting({
  isAvailable: async () => true,
  describe: async () => ({ description: 'A small red boat on a calm blue lake at sunrise.' }),
});
const r4 = await callMultipart('/api/vision/analyze', [
  { name: 'image', filename: 'boat.png', contentType: 'image/png',
    data: Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]) },
]);
console.log('[4] POST /api/vision/analyze (success) →', r4.status);
console.log('    description:', r4.body.description);
console.log('    model      :', r4.body.model);
console.log('    latencyMs  :', r4.body.latencyMs, '| filename:', r4.body.filename, '| size:', r4.body.size);
if (r4.body.available !== true) throw new Error('expected available:true');
clearVisionProviderForTesting();

// 5. Builder/run permanent shim
const r5 = await callPlain('POST', '/api/builder/run');
console.log('\n[5] POST /api/builder/run (permanent shim) →', r5.status);
console.log('    body:', JSON.stringify(r5.body));
if (r5.status !== 501) throw new Error('expected 501');
if (r5.body.available !== false || r5.body.reason !== 'not implemented on this build') {
  throw new Error('expected shim envelope');
}

console.log('\n━━━ ALL CHECKS PASSED — vision route is live with honest unavailable, builder/run is documented permanent shim ━━━');
