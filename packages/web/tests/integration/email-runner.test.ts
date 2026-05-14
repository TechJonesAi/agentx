/**
 * End-to-end test: email ingestion runner against a real DB.
 *
 * Uses a fixture source (no IMAP) so the test runs hermetically. Asserts:
 *  - first runOnce ingests all 3 emails
 *  - second runOnce dedupes (0 ingested, 3 duplicates)
 *  - emails appear in /api/memory/control-center as type='email'
 *  - subject/sender survive into the document row
 *  - body text is searchable via /api/memory/gateway/query
 *  - allowlist blocks non-allowed senders
 *  - GET /api/email/status reports the runner state
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApiRouter } from '../../src/server/routes/api.js';
import {
  createDatabase,
  runCognitiveMemoryMigrations,
  EmailRunner,
  type RawEmail,
} from '@agentx/core';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function call(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
  body?: unknown,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : '';
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, {
      method,
      url,
      headers: data ? { 'content-type': 'application/json' } : {},
    });
    process.nextTick(() => {
      if (data) (req as unknown as { emit(e: string, ...a: unknown[]): void }).emit('data', Buffer.from(data, 'utf-8'));
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

describe('Email ingestion runner — end-to-end against a real DB', () => {
  let dbDir: string;
  let db: ReturnType<typeof createDatabase>;
  let router: ReturnType<typeof createApiRouter>;
  let runner: EmailRunner;
  let fixtureEmails: RawEmail[] = [];
  let blockedEmail: RawEmail;

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-email-runner-'));
    db = createDatabase(dbDir);
    runCognitiveMemoryMigrations(db);
    db.exec(`CREATE TABLE IF NOT EXISTS long_term_memory (id TEXT PRIMARY KEY, content TEXT, embedding BLOB, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL);`);

    const NOW = Date.now();
    fixtureEmails = [
      {
        messageId: '<msg-001@chambers.example>',
        from: 'Jane Smith',
        fromEmail: 'jane@chambers.example.com',
        to: 'darren@example.com',
        subject: 'Tribunal hearing rescheduled to June 14',
        date: new Date(NOW - 86400_000),
        textBody: 'Dear Mr Jones,\n\nThe tribunal hearing originally scheduled for May 14 has been moved to June 14 at 10:00 GMT. Please confirm your availability.\n\nKind regards,\nJane Smith\nEmployment Tribunals Service',
      },
      {
        messageId: '<msg-002@hr.example>',
        from: 'HR Team',
        fromEmail: 'hr@hr.example.com',
        subject: 'Probationary period review reminder',
        date: new Date(NOW - 2 * 86400_000),
        textBody: 'This is a reminder that your six-month probationary period review is due next Tuesday. Please come prepared with examples of your contributions to date.',
      },
      {
        messageId: '<msg-003@billing.example>',
        from: 'Billing',
        fromEmail: 'billing@billing.example.com',
        subject: 'Invoice INV-2026-04-009',
        date: new Date(NOW - 3 * 86400_000),
        textBody: 'Invoice INV-2026-04-009 attached. Payable within 30 days.',
      },
    ];
    blockedEmail = {
      messageId: '<msg-spam@spam.example>',
      from: 'Marketing Spam',
      fromEmail: 'spam@spam.example.com',
      subject: 'You won a free cruise!',
      date: new Date(NOW - 4 * 86400_000),
      textBody: 'CLICK HERE TO CLAIM',
    };

    let nextEmailsToReturn: RawEmail[] = [];
    const fixtureSource = async () => nextEmailsToReturn;

    runner = new EmailRunner({
      db: db as never,
      source: fixtureSource,
      // Allow only the legit senders; blockedEmail's sender is excluded.
      allowedSenders: ['jane@chambers.example.com', 'hr@hr.example.com', 'billing@billing.example.com'],
      allowedDomains: [],
      statePath: path.join(dbDir, 'email-runner-state.json'),
    });

    // Allow each test to control what the source returns by reassigning
    // nextEmailsToReturn before triggering runOnce().
    (runner as unknown as { __setNext: (xs: RawEmail[]) => void }).__setNext = (xs) => {
      nextEmailsToReturn = xs;
    };

    // Fake agent exposes both getDatabase and the runner via getEmailRunner.
    const fakeAgent = {
      getDatabase() { return db; },
      getEmailRunner() { return runner; },
      getEmailIngestionService() { return null; },
      isEntityIndexingEnabled() { return false; },
      ingestDocumentEntities() { return null; },
      async chat() { return 'ok'; },
      async chatStream() { /* noop */ },
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

    router = createApiRouter(fakeAgent as never);
  }, 30_000);

  afterAll(() => {
    try { runner.stop(); db.close(); } catch { /* */ }
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('first runOnce ingests all 3 fixture emails', async () => {
    (runner as unknown as { __setNext: (xs: RawEmail[]) => void }).__setNext(fixtureEmails);
    const result = await runner.runOnce();
    expect(result.fetched).toBe(3);
    expect(result.ingested).toBe(3);
    expect(result.duplicates).toBe(0);
    expect(result.rejected).toBe(0);
    expect(result.errors).toBe(0);
    // Each detail entry has a documentId for ingested status
    for (const d of result.details) {
      expect(d.status).toBe('ingested');
      expect(typeof d.documentId).toBe('string');
    }
  });

  it('emails appear in /api/memory/control-center as type=email', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center?type=email');
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(3);
    for (const it of items) {
      expect(it['type']).toBe('email');
      expect(it['source']).toBe('email');
      expect(typeof it['sender']).toBe('string');
      expect(typeof it['title']).toBe('string');
    }
    // Newest-first: tribunal email (yesterday) should be first
    expect(items[0]['sender']).toBe('Jane Smith');
    expect(items[0]['title']).toContain('Tribunal');
  });

  it('chunk content is full-text searchable via /api/memory/gateway/query', async () => {
    const r = await call(router, 'POST', '/api/memory/gateway/query', { q: 'probationary' });
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]['title']).toContain('Probationary period');
  });

  it('GET detail returns the full email body and email metadata', async () => {
    const list = await call(router, 'GET', '/api/memory/control-center?type=email');
    const items = list.body['items'] as Array<Record<string, unknown>>;
    const tribunal = items.find((i) => String(i['title']).includes('Tribunal'));
    expect(tribunal).toBeDefined();
    const id = String(tribunal!['id']);

    const detail = await call(router, 'GET', `/api/memory/control-center/${encodeURIComponent(id)}`);
    expect(detail.status).toBe(200);
    expect(detail.body['type']).toBe('email');
    expect(detail.body['sender']).toBe('Jane Smith');
    expect(String(detail.body['body'])).toContain('moved to June 14');
    const md = detail.body['metadata'] as Record<string, unknown>;
    expect(md['origin_type']).toBe('email');
    expect(md['file_type']).toBe('eml');
  });

  it('second runOnce dedupes by message-id (0 ingested, 3 duplicates)', async () => {
    (runner as unknown as { __setNext: (xs: RawEmail[]) => void }).__setNext(fixtureEmails);
    const result = await runner.runOnce();
    expect(result.fetched).toBe(3);
    expect(result.ingested).toBe(0);
    expect(result.duplicates).toBe(3);
    // Memory still has only 3 emails — no duplicates inserted
    const list = await call(router, 'GET', '/api/memory/control-center?type=email');
    expect((list.body['items'] as unknown[]).length).toBe(3);
  });

  it('rejects emails from non-allowlisted senders', async () => {
    (runner as unknown as { __setNext: (xs: RawEmail[]) => void }).__setNext([blockedEmail]);
    const result = await runner.runOnce();
    expect(result.fetched).toBe(1);
    expect(result.ingested).toBe(0);
    expect(result.rejected).toBe(1);
    expect(result.details[0].reason).toMatch(/allowlist/i);
    // Memory still has only the original 3 emails
    const list = await call(router, 'GET', '/api/memory/control-center?type=email');
    expect((list.body['items'] as unknown[]).length).toBe(3);
  });

  it('GET /api/email/status reports runner state with lastResult', async () => {
    const r = await call(router, 'GET', '/api/email/status');
    expect(r.status).toBe(200);
    const runnerStatus = r.body['runner'] as Record<string, unknown>;
    expect(runnerStatus).toBeDefined();
    expect(runnerStatus['running']).toBe(false);
    expect(runnerStatus['lastRunAt']).toBeTypeOf('number');
    expect(runnerStatus['processedCount']).toBeGreaterThanOrEqual(3);
    const last = runnerStatus['lastResult'] as Record<string, unknown>;
    expect(last).toBeDefined();
    expect(typeof last['fetched']).toBe('number');
  });

  it('POST /api/email/run triggers a cycle (no new emails this time)', async () => {
    (runner as unknown as { __setNext: (xs: RawEmail[]) => void }).__setNext([]);
    const r = await call(router, 'POST', '/api/email/run');
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    const result = r.body['result'] as Record<string, unknown>;
    expect(result['fetched']).toBe(0);
    expect(result['ingested']).toBe(0);
  });

  it('POST /api/email/start then /api/email/stop toggles running flag', async () => {
    (runner as unknown as { __setNext: (xs: RawEmail[]) => void }).__setNext([]);
    const r1 = await call(router, 'POST', '/api/email/start', { intervalMs: 5_000 });
    expect(r1.status).toBe(200);
    expect((r1.body['status'] as Record<string, unknown>)['running']).toBe(true);

    const r2 = await call(router, 'POST', '/api/email/stop');
    expect(r2.status).toBe(200);
    expect((r2.body['status'] as Record<string, unknown>)['running']).toBe(false);
  });
});
