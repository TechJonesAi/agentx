#!/usr/bin/env node
/**
 * Live demonstration: Memory Control Center routes work against a real DB.
 *
 * What this proves:
 *  1. We start the actual built WebServer (dist/server/index.js).
 *  2. We open a real SQLite DB and run the cognitive-memory migrations.
 *  3. We INSERT a fake email, a fake PDF, and a long-term-memory note.
 *  4. We hit GET /api/memory/control-center and print the response.
 *  5. We hit GET /api/memory/control-center/:id (detail) and print.
 *  6. We hit POST /api/memory/gateway/query and print.
 *  7. We hit DELETE and print, then re-list.
 *
 * Run after `pnpm -r build`:
 *   node packages/web/tests/integration/memory-control-center-live.demo.mjs
 */
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WebServer } from '../../dist/server/index.js';
import { createDatabase, runCognitiveMemoryMigrations } from '../../../core/dist/index.js';

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-mcc-demo-'));
console.log(`[setup] DB dir: ${dbDir}`);
const db = createDatabase(dbDir);
runCognitiveMemoryMigrations(db);
db.exec(`
  CREATE TABLE IF NOT EXISTS long_term_memory (
    id TEXT PRIMARY KEY, content TEXT NOT NULL, embedding BLOB,
    tags TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL
  );
`);

const NOW = Date.now();

// Insert a fake email
db.prepare(`INSERT INTO documents (
  document_id, file_name, file_type, mime_type, content_type, origin_type,
  title, sender, sender_email, subject, document_date, ingested_at, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
  'demo-email-1', '2026-05-05-tribunal.eml', 'eml', 'message/rfc822', 'email', 'email',
  'Tribunal hearing rescheduled', 'Jane Smith', 'jane@chambers.example.com',
  'Tribunal hearing rescheduled to June 14',
  NOW - 86400_000, NOW - 86400_000, NOW - 86400_000,
);
db.prepare(`INSERT INTO document_chunks (chunk_id, document_id, chunk_number, content, created_at) VALUES (?,?,?,?,?)`)
  .run('demo-email-1-chunk0', 'demo-email-1', 0,
    'Dear Mr Jones,\n\nThe tribunal hearing has been rescheduled to June 14 at 10:00.\n\nKind regards, Jane Smith',
    NOW - 86400_000);

// Insert a fake PDF
db.prepare(`INSERT INTO documents (
  document_id, file_name, file_type, mime_type, content_type, origin_type,
  title, document_date, ingested_at, updated_at
) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
  'demo-pdf-1', 'employment-handbook.pdf', 'pdf', 'application/pdf', 'document', 'upload',
  'Employment Handbook 2025',
  NOW - 7 * 86400_000, NOW - 7 * 86400_000, NOW - 7 * 86400_000,
);
db.prepare(`INSERT INTO document_chunks (chunk_id, document_id, chunk_number, content, created_at) VALUES (?,?,?,?,?)`)
  .run('demo-pdf-1-chunk0', 'demo-pdf-1', 0,
    'Section 1: Probationary period. New employees are subject to a six-month probationary period.',
    NOW - 7 * 86400_000);

// Insert a long-term-memory note
db.prepare(`INSERT INTO long_term_memory (id, content, tags, created_at, accessed_at) VALUES (?,?,?,?,?)`)
  .run('demo-note-1', 'Always cite [DOC-N] when referencing employment law.',
    JSON.stringify(['teaching']), NOW - 14 * 86400_000, NOW - 14 * 86400_000);

console.log('[setup] inserted: 1 email, 1 PDF, 1 note\n');

// Build a minimal agent stub
const fakeAgent = {
  getDatabase() { return db; },
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

// Pick an ephemeral port
const tmp = http.createServer();
await new Promise((r) => tmp.listen(0, '127.0.0.1', r));
const port = tmp.address().port;
await new Promise((r) => tmp.close(r));

const server = new WebServer({ port, host: '127.0.0.1', agent: fakeAgent });
await server.start();
console.log(`[server] started on 127.0.0.1:${port}\n`);

const get = (p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => {
    let b = ''; r.on('data', (c) => (b += c));
    r.on('end', () => res({ status: r.statusCode, body: b }));
  }).on('error', rej);
});
const post = (p, body) => new Promise((res, rej) => {
  const data = JSON.stringify(body);
  const req = http.request(
    { host: '127.0.0.1', port, path: p, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
    (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); },
  );
  req.on('error', rej); req.write(data); req.end();
});
const del = (p) => new Promise((res, rej) => {
  const req = http.request({ host: '127.0.0.1', port, path: p, method: 'DELETE' },
    (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res({ status: r.statusCode, body: b })); });
  req.on('error', rej); req.end();
});

const banner = (s) => console.log(`\n══ ${s} ` + '═'.repeat(Math.max(0, 70 - s.length)));

banner('1. GET /api/memory/control-center  (no filters)');
{
  const r = await get('/api/memory/control-center');
  console.log(`status: ${r.status}`);
  const data = JSON.parse(r.body);
  console.log(`totalCount: ${data.totalCount}`);
  for (const it of data.items) {
    console.log(`  [${it.type.padEnd(8)}] ${it.id}  "${it.title}"  (${it.wordCount} words)`);
    console.log(`      preview: ${it.preview.slice(0, 80)}...`);
  }
}

banner('2. GET /api/memory/control-center?type=email');
{
  const r = await get('/api/memory/control-center?type=email');
  console.log(`status: ${r.status}`);
  const data = JSON.parse(r.body);
  console.log(`Got ${data.items.length} email(s):`);
  for (const it of data.items) console.log(`  ${it.id} — sender=${it.sender}`);
}

banner('3. GET /api/memory/control-center/doc:demo-email-1  (full body)');
{
  const r = await get('/api/memory/control-center/doc%3Ademo-email-1');
  console.log(`status: ${r.status}`);
  const data = JSON.parse(r.body);
  console.log(`title: "${data.title}"`);
  console.log(`type: ${data.type}, sender: ${data.sender}, source: ${data.source}`);
  console.log(`body (${data.wordCount} words):`);
  console.log('  ' + data.body.split('\n').join('\n  '));
}

banner('4. POST /api/memory/gateway/query  q="probationary"');
{
  const r = await post('/api/memory/gateway/query', { q: 'probationary' });
  console.log(`status: ${r.status}`);
  const data = JSON.parse(r.body);
  console.log(`matched ${data.totalCount} item(s):`);
  for (const it of data.items) console.log(`  ${it.id} — "${it.title}"`);
}

banner('5. DELETE /api/memory/control-center/note:demo-note-1');
{
  const r = await del('/api/memory/control-center/note%3Ademo-note-1');
  console.log(`status: ${r.status}, body: ${r.body}`);
  const after = await get('/api/memory/control-center?type=note');
  const data = JSON.parse(after.body);
  console.log(`notes after delete: ${data.totalCount}`);
}

banner('6. POST /api/memory/control-center/bulk-delete  remove the 2 documents');
{
  const r = await post('/api/memory/control-center/bulk-delete', {
    ids: ['doc:demo-email-1', 'doc:demo-pdf-1'],
  });
  console.log(`status: ${r.status}, body: ${r.body}`);
  const after = await get('/api/memory/control-center');
  const data = JSON.parse(after.body);
  console.log(`totalCount after bulk-delete: ${data.totalCount}`);
}

await server.stop();
db.close();
fs.rmSync(dbDir, { recursive: true, force: true });
console.log('\n[done] cleanup complete.');
