#!/usr/bin/env node
/**
 * Live demonstration: full extraction parity push.
 *
 * Boots the actual built WebServer. Uploads every supported format via
 * /api/memory/upload-document, runs the email runner against an HTML-only
 * email and an email with an attachment, then exercises the cognitive
 * routes. Every step prints what came back from the real HTTP layer.
 *
 * Run after `pnpm -r build`:
 *   node packages/web/tests/integration/extraction-live.demo.mjs
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebServer } from '../../dist/server/index.js';
import {
  createDatabase,
  runCognitiveMemoryMigrations,
  EmailRunner,
} from '../../../core/dist/index.js';

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-extraction-demo-'));
console.log(`[setup] DB dir: ${dbDir}`);
const db = createDatabase(dbDir);
runCognitiveMemoryMigrations(db);
db.exec(`CREATE TABLE IF NOT EXISTS long_term_memory (id TEXT PRIMARY KEY, content TEXT, embedding BLOB, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL);`);

let nextEmails = [];
const runner = new EmailRunner({
  db,
  source: async () => nextEmails,
  allowedSenders: [],
  allowedDomains: [],
  statePath: path.join(dbDir, 'runner-state.json'),
});

const fakeAgent = {
  getDatabase() { return db; },
  getEmailRunner() { return runner; },
  getEmailIngestionService() { return null; },
  isEntityIndexingEnabled() { return false; },
  ingestDocumentEntities() { return null; },
  async chat() { return 'ok'; },
  async chatStream(_, cbs) { cbs.onComplete?.({ content: 'ok' }); },
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

const tmp = http.createServer();
await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
const port = tmp.address().port;
await new Promise((r) => tmp.close(r));

const server = new WebServer({ port, host: '127.0.0.1', agent: fakeAgent });
await server.start();
console.log(`[server] started on 127.0.0.1:${port}\n`);

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej);
});
const postJson = (p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body || {});
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
    (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); });
  req.on('error', rej); req.write(data); req.end();
});
function buildMultipart(parts) {
  const boundary = `----demo${Date.now()}`;
  const segments = [];
  for (const p of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) header += `; filename="${p.filename}"`;
    header += `\r\n`;
    if (p.contentType) header += `Content-Type: ${p.contentType}\r\n`;
    header += `\r\n`;
    segments.push(Buffer.from(header, 'utf8'));
    segments.push(typeof p.data === 'string' ? Buffer.from(p.data, 'utf8') : p.data);
    segments.push(Buffer.from('\r\n', 'utf8'));
  }
  segments.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(segments), contentType: `multipart/form-data; boundary=${boundary}` };
}
const postMultipart = (p, parts) => new Promise((res, rej) => {
  const { body, contentType } = buildMultipart(parts);
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': contentType, 'Content-Length': body.length } },
    (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); });
  req.on('error', rej); req.write(body); req.end();
});
const banner = (s) => console.log(`\n══ ${s} ` + '═'.repeat(Math.max(0, 70 - s.length)));

async function uploadAndReport(label, parts) {
  const r = await postMultipart('/api/memory/upload-document', parts);
  const data = JSON.parse(r.body);
  for (const u of data.uploaded) {
    const warn = (u.warnings || []).length ? `  ⚠ ${u.warnings.join(' | ')}` : '';
    console.log(`  ${label.padEnd(8)} → file_type=${u.file_type}, mime=${u.mime_type}, chunks=${u.chunk_count}, words=${u.word_count}${warn}`);
  }
}

banner('1. Upload every supported format');
await uploadAndReport('TXT', [{ name: 'file', filename: 'note.txt', contentType: 'text/plain', data: 'The quarterly review is scheduled for May 14.' }]);
await uploadAndReport('MD',  [{ name: 'file', filename: 'spec.md',  contentType: 'text/markdown', data: '# Architecture\n\n- Microservices\n- Event-driven\n\nFor the **Q3 launch**.' }]);
await uploadAndReport('JSON', [{ name: 'file', filename: 'config.json', contentType: 'application/json', data: JSON.stringify({ project: 'AgentX', mode: 'restoration', priority: 'critical' }) }]);
await uploadAndReport('CSV', [{ name: 'file', filename: 'data.csv', contentType: 'text/csv', data: 'sku,price\nA-100,29.99\nA-200,49.99' }]);
await uploadAndReport('XML', [{ name: 'file', filename: 'feed.xml', contentType: 'application/xml', data: '<feed><item>Quantum computing milestone reached</item></feed>' }]);
await uploadAndReport('HTML', [{ name: 'file', filename: 'page.html', contentType: 'text/html', data: '<html><body><h1>Compliance Update</h1><p>The new policy takes effect immediately.</p></body></html>' }]);

const eml = [
  'From: Sarah Lee <sarah@law.example>',
  'To: counsel@example.com',
  'Subject: Settlement offer received',
  'Date: Wed, 7 May 2026 14:30:00 +0000',
  'Content-Type: text/plain', '',
  'A formal settlement offer has been received. We need to respond by Friday.',
].join('\r\n');
await uploadAndReport('EML', [{ name: 'file', filename: 'settlement.eml', contentType: 'message/rfc822', data: eml }]);

// Real PDF fixture (generated from text via macOS cupsfilter). pdf-parse v2's
// PDFParse class extracts the body text. The fixture lives in tests/fixtures/
// so the demo proves end-to-end PDF text extraction with a real producer.
const realPdfPath = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'fixtures', 'sample-board-pack.pdf');
if (fs.existsSync(realPdfPath)) {
  const realPdf = fs.readFileSync(realPdfPath);
  await uploadAndReport('PDF', [{ name: 'file', filename: 'sample-board-pack.pdf', contentType: 'application/pdf', data: realPdf }]);
} else {
  console.log('  PDF       → skipped (fixture not present)');
}

// MSG — synthesised buffer
const magic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const padding = Buffer.alloc(64, 0);
const msgBody = Buffer.from(
  '\x00\x00Subject: Quarterly board pack\x00\x00\x00\x00From: chair@board.example\x00\x00\x00\x00     The board reviewed the Q3 strategy update and approved the recommendations from the executive team. Detailed minutes follow in the attached supplements.     ',
  'latin1',
);
await uploadAndReport('MSG', [{ name: 'file', filename: 'msg.msg', contentType: 'application/vnd.ms-outlook',
  data: Buffer.concat([magic, padding, msgBody]) }]);

banner('2. Memory list — every upload appears');
{
  const r = await get('/api/memory/control-center');
  const data = JSON.parse(r.body);
  console.log(`totalCount: ${data.totalCount}`);
  for (const it of data.items) {
    console.log(`  [${it.type.padEnd(8)}] ${it.title.padEnd(30)}  (words: ${it.wordCount})`);
  }
}

banner('3. Cognitive search — full-text across all formats');
for (const q of ['quarterly', 'compliance', 'restoration', 'settlement', 'quantum']) {
  const r = await postJson('/api/cognitive/search', { q });
  const data = JSON.parse(r.body);
  console.log(`  q="${q.padEnd(12)}" → matched ${data.totalCount}: ${data.items.map((i) => i.title).join(', ')}`);
}

banner('4. Email runner — HTML-only email, body extracted via fallback');
nextEmails = [{
  messageId: '<demo-html-1@example.com>',
  from: 'Marketing',
  fromEmail: 'marketing@example.com',
  subject: 'Product launch announcement',
  date: new Date(),
  textBody: '',
  htmlBody: '<html><body><h1>Big news</h1><p>Our new product launches Monday.</p></body></html>',
}];
{
  const r = await postJson('/api/email/run');
  const d = JSON.parse(r.body).result;
  console.log(`  fetched: ${d.fetched}, ingested: ${d.ingested}, dups: ${d.duplicates}, rejected: ${d.rejected}, errors: ${d.errors}`);
  // Search for the HTML body content
  const search = await postJson('/api/cognitive/search', { q: 'launches Monday' });
  const items = JSON.parse(search.body).items;
  console.log(`  search "launches Monday" → matched ${items.length}: ${items.map((i) => i.title).join(', ')}`);
}

banner('5. Email runner — email with attachment becomes 2 documents');
nextEmails = [{
  messageId: '<demo-attach-1@example.com>',
  from: 'CFO',
  fromEmail: 'cfo@example.com',
  subject: 'Q3 numbers attached',
  date: new Date(),
  textBody: 'Please see attached.',
  inlineAttachments: [
    { filename: 'q3-board-pack.txt', contentType: 'text/plain',
      data: Buffer.from('Quarterly board pack — page 1\n\nRevenue +12% YoY. Operating margin 18%.', 'utf8') },
  ],
}];
{
  const r = await postJson('/api/email/run');
  const d = JSON.parse(r.body).result;
  console.log(`  fetched: ${d.fetched}, ingested: ${d.ingested}`);
  const list = await get('/api/memory/control-center?type=attachment');
  const atts = JSON.parse(list.body).items;
  console.log(`  attachments in memory: ${atts.length}`);
  for (const a of atts) console.log(`    ${a.title} — sender: ${a.sender}`);
  const s = await postJson('/api/cognitive/search', { q: 'Operating margin' });
  console.log(`  search "Operating margin" → ${JSON.parse(s.body).totalCount} match(es)`);
}

banner('6. GET /api/cognitive/document/:id — fetch full body');
{
  const list = await get('/api/memory/control-center');
  const items = JSON.parse(list.body).items;
  const settlement = items.find((i) => i.title.includes('Settlement'));
  if (settlement) {
    const r = await get(`/api/cognitive/document/${encodeURIComponent(settlement.id)}`);
    const d = JSON.parse(r.body);
    console.log(`  status: ${r.status}, type: ${d.type}, sender: ${d.sender}`);
    console.log(`  body excerpt: ${d.body.slice(0, 100)}...`);
  }
}

banner('7. GET /api/memory/gateway/document/:id — alias works');
{
  const list = await get('/api/memory/control-center');
  const items = JSON.parse(list.body).items;
  const html = items.find((i) => String(i.title).includes('page'));
  if (html) {
    const r = await get(`/api/memory/gateway/document/${encodeURIComponent(html.id)}`);
    const d = JSON.parse(r.body);
    console.log(`  status: ${r.status}, body: ${d.body}`);
  }
}

banner('Summary');
{
  const r = await get('/api/memory/control-center');
  const data = JSON.parse(r.body);
  const counts = {};
  for (const it of data.items) counts[it.type] = (counts[it.type] || 0) + 1;
  console.log(`  Total documents in memory: ${data.totalCount}`);
  for (const [t, n] of Object.entries(counts)) console.log(`    ${t.padEnd(10)} ${n}`);
}

await server.stop();
db.close();
fs.rmSync(dbDir, { recursive: true, force: true });
console.log('\n[done] cleanup complete.');
