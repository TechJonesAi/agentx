#!/usr/bin/env node
/**
 * Live demonstration: email ingestion runner end-to-end.
 *
 * Uses a fixture email source (no IMAP, no Keychain) so the demo runs
 * hermetically in any environment. The same code path with createImapSource
 * runs in production — only the source function differs.
 *
 * What this proves:
 *  1. Boots the actual built WebServer.
 *  2. Constructs an EmailRunner with a fixture source returning 3 emails.
 *  3. POST /api/email/run triggers a cycle → 3 emails ingested.
 *  4. GET /api/memory/control-center?type=email shows them.
 *  5. POST /api/memory/gateway/query finds them by content.
 *  6. GET detail returns full email body with sender/subject metadata.
 *  7. Second run dedupes (3 duplicates).
 *  8. Allowlist blocks a non-allowed sender.
 *  9. Start/stop toggle the polling loop.
 *
 * Run after `pnpm -r build`:
 *   node packages/web/tests/integration/email-runner-live.demo.mjs
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

const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-email-demo-'));
console.log(`[setup] DB dir: ${dbDir}`);
const db = createDatabase(dbDir);
runCognitiveMemoryMigrations(db);
db.exec(`CREATE TABLE IF NOT EXISTS long_term_memory (id TEXT PRIMARY KEY, content TEXT, embedding BLOB, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL);`);

const NOW = Date.now();
let nextEmails = [
  {
    messageId: '<demo-001@chambers.example>',
    from: 'Jane Smith',
    fromEmail: 'jane@chambers.example.com',
    subject: 'Tribunal hearing rescheduled to June 14',
    date: new Date(NOW - 86400_000),
    textBody: 'Dear Mr Jones,\n\nThe tribunal hearing has been moved to June 14 at 10:00 GMT.\n\nKind regards, Jane Smith',
  },
  {
    messageId: '<demo-002@hr.example>',
    from: 'HR Team',
    fromEmail: 'hr@hr.example.com',
    subject: 'Probationary period review reminder',
    date: new Date(NOW - 2 * 86400_000),
    textBody: 'Reminder: your six-month probationary period review is due next Tuesday.',
  },
  {
    messageId: '<demo-003@billing.example>',
    from: 'Billing',
    fromEmail: 'billing@billing.example.com',
    subject: 'Invoice INV-2026-04-009',
    date: new Date(NOW - 3 * 86400_000),
    textBody: 'Invoice INV-2026-04-009 attached. Payable within 30 days.',
  },
];

const fixtureSource = async () => nextEmails;

const runner = new EmailRunner({
  db,
  source: fixtureSource,
  allowedSenders: ['jane@chambers.example.com', 'hr@hr.example.com', 'billing@billing.example.com'],
  allowedDomains: [],
  statePath: path.join(dbDir, 'email-runner-state.json'),
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

const banner = (s) => console.log(`\n══ ${s} ` + '═'.repeat(Math.max(0, 70 - s.length)));

banner('1. GET /api/email/status  (before any run)');
{
  const r = await get('/api/email/status');
  const d = JSON.parse(r.body);
  console.log(`status: ${r.status}, runner.running: ${d.runner?.running}, lastRunAt: ${d.runner?.lastRunAt}`);
}

banner('2. Memory before ingestion');
{
  const r = await get('/api/memory/control-center?type=email');
  const d = JSON.parse(r.body);
  console.log(`emails in memory: ${d.totalCount}`);
}

banner('3. POST /api/email/run  (trigger ingestion now)');
{
  const r = await postJson('/api/email/run');
  const d = JSON.parse(r.body);
  console.log(`status: ${r.status}, ok: ${d.ok}`);
  console.log(`  fetched: ${d.result.fetched}, ingested: ${d.result.ingested}, duplicates: ${d.result.duplicates}, rejected: ${d.result.rejected}, errors: ${d.result.errors}`);
  for (const det of d.result.details) {
    console.log(`  [${det.status.padEnd(9)}] ${det.sender} — "${det.subject}"`);
  }
}

banner('4. GET /api/memory/control-center?type=email  (after ingestion)');
{
  const r = await get('/api/memory/control-center?type=email');
  const d = JSON.parse(r.body);
  console.log(`totalCount: ${d.totalCount}`);
  for (const it of d.items) {
    console.log(`  [email] ${it.id}`);
    console.log(`    sender: ${it.sender}`);
    console.log(`    title:  ${it.title}`);
    console.log(`    preview: ${it.preview.slice(0, 70)}...`);
  }
}

banner('5. POST /api/memory/gateway/query  q="probationary"');
{
  const r = await postJson('/api/memory/gateway/query', { q: 'probationary' });
  const d = JSON.parse(r.body);
  console.log(`status: ${r.status}, matched: ${d.totalCount}`);
  for (const it of d.items) console.log(`  ${it.id} — "${it.title}"`);
}

banner('6. GET detail of the tribunal email');
{
  const list = await get('/api/memory/control-center?type=email');
  const items = JSON.parse(list.body).items;
  const tribunal = items.find((i) => i.title.includes('Tribunal'));
  const r = await get(`/api/memory/control-center/${encodeURIComponent(tribunal.id)}`);
  const d = JSON.parse(r.body);
  console.log(`status: ${r.status}`);
  console.log(`title: "${d.title}"`);
  console.log(`sender: ${d.sender}, type: ${d.type}, file_type: ${d.metadata?.file_type}`);
  console.log(`body:\n  ${d.body.split('\n').join('\n  ')}`);
}

banner('7. Run again — dedupe by message-id (no new ingests)');
{
  const r = await postJson('/api/email/run');
  const d = JSON.parse(r.body).result;
  console.log(`fetched: ${d.fetched}, ingested: ${d.ingested}, duplicates: ${d.duplicates}`);
  const list = await get('/api/memory/control-center?type=email');
  console.log(`emails in memory still: ${JSON.parse(list.body).totalCount}`);
}

banner('8. Inject a non-allowlisted sender — runner rejects it');
{
  nextEmails = [{
    messageId: '<demo-spam@spam.example>',
    from: 'Spam Inc',
    fromEmail: 'spam@spam.example.com',
    subject: 'Free cruise!',
    date: new Date(),
    textBody: 'CLICK HERE',
  }];
  const r = await postJson('/api/email/run');
  const d = JSON.parse(r.body).result;
  console.log(`fetched: ${d.fetched}, ingested: ${d.ingested}, rejected: ${d.rejected}`);
  console.log(`  reason: ${d.details[0]?.reason}`);
  const list = await get('/api/memory/control-center?type=email');
  console.log(`emails in memory still: ${JSON.parse(list.body).totalCount}  (no spam ingested)`);
}

banner('9. POST /api/email/start  then  /api/email/stop');
{
  nextEmails = [];
  const r1 = await postJson('/api/email/start', { intervalMs: 5000 });
  console.log(`start status: ${r1.status}, running: ${JSON.parse(r1.body).status?.running}`);
  const r2 = await postJson('/api/email/stop');
  console.log(`stop status:  ${r2.status}, running: ${JSON.parse(r2.body).status?.running}`);
}

banner('10. Final /api/email/status');
{
  const r = await get('/api/email/status');
  const d = JSON.parse(r.body);
  const rs = d.runner;
  console.log(`running: ${rs.running}, lastRunAt: ${new Date(rs.lastRunAt).toISOString()}`);
  console.log(`processedCount: ${rs.processedCount}, lastResult.ingested: ${rs.lastResult?.ingested}`);
}

await server.stop();
db.close();
fs.rmSync(dbDir, { recursive: true, force: true });
console.log('\n[done] cleanup complete.');
