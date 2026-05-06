#!/usr/bin/env node
/**
 * Live demonstration: uploading a document end-to-end.
 *
 * What this proves:
 *  1. Boots the actual built WebServer.
 *  2. Sends a real multipart/form-data POST to /api/memory/upload-document
 *     with a TXT file containing real prose.
 *  3. The route extracts text, chunks it, INSERTs documents +
 *     document_chunks rows (FTS triggers fire automatically).
 *  4. Lists /api/memory/control-center — the upload appears.
 *  5. Searches via /api/memory/gateway/query — the upload's chunk
 *     content is FTS-searchable.
 *  6. Uploads the same content again — duplicate_of is set
 *     (content_hash dedupe).
 *  7. Uploads a markdown file via /api/cognitive/ingest — different
 *     route, same code path.
 *
 * Run after `pnpm -r build`:
 *   node packages/web/tests/integration/upload-document-live.demo.mjs
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebServer } from '../../dist/server/index.js';
import { createDatabase, runCognitiveMemoryMigrations } from '../../../core/dist/index.js';

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-upload-demo-'));
console.log(`[setup] DB dir: ${dbDir}`);
const db = createDatabase(dbDir);
runCognitiveMemoryMigrations(db);
db.exec(`CREATE TABLE IF NOT EXISTS long_term_memory (id TEXT PRIMARY KEY, content TEXT, embedding BLOB, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL);`);

const fakeAgent = {
  getDatabase() { return db; },
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

const SAMPLE_TXT = `Employment Tribunal Brief — 2026

Section 1: Probationary period
New employees serve a six-month probation period during which performance is reviewed monthly.

Section 2: Notice periods
Statutory minimum notice is one week per year of service, capped at twelve weeks.

Section 3: Holiday entitlement
Twenty-eight days statutory minimum, inclusive of bank holidays.`;

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

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); }).on('error', rej);
});
const postJson = (p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body);
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
    (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); });
  req.on('error', rej); req.write(data); req.end();
});
const postMultipart = (p, parts) => new Promise((res, rej) => {
  const { body, contentType } = buildMultipart(parts);
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': contentType, 'Content-Length': body.length } },
    (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); });
  req.on('error', rej); req.write(body); req.end();
});

const banner = (s) => console.log(`\n══ ${s} ` + '═'.repeat(Math.max(0, 70 - s.length)));

banner('1. Memory before uploads');
{
  const r = await get('/api/memory/control-center');
  const data = JSON.parse(r.body);
  console.log(`status: ${r.status}, items: ${data.totalCount}`);
}

banner('2. POST /api/memory/upload-document  (txt file)');
let firstId;
{
  const r = await postMultipart('/api/memory/upload-document', [
    { name: 'file', filename: 'tribunal-brief.txt', contentType: 'text/plain', data: SAMPLE_TXT },
  ]);
  console.log(`status: ${r.status}`);
  const data = JSON.parse(r.body);
  for (const u of data.uploaded) {
    console.log(`  uploaded: ${u.file_name}`);
    console.log(`    document_id: ${u.document_id}`);
    console.log(`    file_type: ${u.file_type}, mime: ${u.mime_type}`);
    console.log(`    chunks: ${u.chunk_count}, words: ${u.word_count}`);
    console.log(`    duplicate_of: ${u.duplicate_of}`);
    firstId = u.document_id;
  }
}

banner('3. Memory after upload — list shows the new document');
{
  const r = await get('/api/memory/control-center');
  const data = JSON.parse(r.body);
  console.log(`totalCount: ${data.totalCount}`);
  for (const it of data.items) {
    console.log(`  [${it.type.padEnd(8)}] ${it.id}  "${it.title}"  (${it.wordCount} words)`);
    console.log(`      preview: ${it.preview.slice(0, 80)}...`);
  }
}

banner('4. POST /api/memory/gateway/query  q="probationary"');
{
  const r = await postJson('/api/memory/gateway/query', { q: 'probationary' });
  const data = JSON.parse(r.body);
  console.log(`status: ${r.status}, matched: ${data.totalCount}`);
  for (const it of data.items) console.log(`  ${it.id} — "${it.title}"`);
}

banner('5. GET /api/memory/control-center/:id  (full body of upload)');
{
  // List id is `doc:<document_id>` — encode the colon for the URL.
  const detailId = `doc:${firstId}`;
  const r = await get(`/api/memory/control-center/${encodeURIComponent(detailId)}`);
  console.log(`status: ${r.status}`);
  const data = JSON.parse(r.body);
  if (r.status === 200) {
    console.log(`title: "${data.title}"`);
    console.log(`type: ${data.type}, source: ${data.source}, words: ${data.wordCount}`);
    console.log(`body excerpt:`);
    console.log('  ' + data.body.slice(0, 200).split('\n').join('\n  '));
  }
}

banner('6. Upload same content again — content_hash dedupe');
{
  const r = await postMultipart('/api/memory/upload-document', [
    { name: 'file', filename: 'tribunal-brief-v2.txt', contentType: 'text/plain', data: SAMPLE_TXT },
  ]);
  const data = JSON.parse(r.body);
  for (const u of data.uploaded) {
    console.log(`  ${u.file_name} → duplicate_of: ${u.duplicate_of}, chunks: ${u.chunk_count}`);
  }
  const after = await get('/api/memory/control-center');
  console.log(`memory totalCount after dedupe attempt: ${JSON.parse(after.body).totalCount}  (still 1 — no new doc)`);
}

banner('7. POST /api/cognitive/ingest  (markdown via the alt route)');
{
  const r = await postMultipart('/api/cognitive/ingest', [
    { name: 'file', filename: 'meeting-notes.md', contentType: 'text/markdown',
      data: '# Q3 Board Meeting\n\n- Discussed budget reallocation\n- Approved hiring plan\n- Reviewed compliance audit findings' },
  ]);
  const data = JSON.parse(r.body);
  console.log(`status: ${r.status}`);
  for (const u of data.uploaded) {
    console.log(`  uploaded: ${u.file_name} (${u.file_type}, ${u.mime_type}) — ${u.chunk_count} chunks`);
  }
  const after = await get('/api/memory/control-center');
  const items = JSON.parse(after.body).items;
  console.log(`memory totalCount: ${items.length}`);
  for (const it of items) {
    console.log(`  [${it.type.padEnd(8)}] ${it.title}`);
  }
}

banner('8. Filter by type=document');
{
  const r = await get('/api/memory/control-center?type=document');
  const data = JSON.parse(r.body);
  console.log(`Got ${data.items.length} document(s):`);
  for (const it of data.items) {
    console.log(`  ${it.id} — "${it.title}" (${it.wordCount} words)`);
  }
}

await server.stop();
db.close();
fs.rmSync(dbDir, { recursive: true, force: true });
console.log('\n[done] cleanup complete.');
