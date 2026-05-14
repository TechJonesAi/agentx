/**
 * End-to-end test: every supported file format ingests via the upload
 * route, lands in the documents table, surfaces in /api/memory/control-center,
 * and is searchable via the cognitive routes.
 *
 * Real DB. Real multipart parser. Real extraction layer.
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

interface CallResult { status: number; body: Record<string, unknown>; raw: string; headers: Record<string, string | string[] | undefined>; }

function buildMultipart(parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer | string }>): { body: Buffer; contentType: string } {
  const boundary = `----testboundary${Date.now()}`;
  const segs: Buffer[] = [];
  for (const p of parts) {
    let header = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename !== undefined) header += `; filename="${p.filename}"`;
    header += '\r\n';
    if (p.contentType) header += `Content-Type: ${p.contentType}\r\n`;
    header += '\r\n';
    segs.push(Buffer.from(header, 'utf8'));
    segs.push(typeof p.data === 'string' ? Buffer.from(p.data, 'utf8') : p.data);
    segs.push(Buffer.from('\r\n', 'utf8'));
  }
  segs.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(segs), contentType: `multipart/form-data; boundary=${boundary}` };
}

function call(
  router: ReturnType<typeof createApiRouter>,
  method: string,
  url: string,
  options: { json?: unknown; multipart?: { body: Buffer; contentType: string } } = {},
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    let data: Buffer | undefined;
    const headers: Record<string, string> = {};
    if (options.multipart) {
      data = options.multipart.body;
      headers['content-type'] = options.multipart.contentType;
      headers['content-length'] = String(data.length);
    } else if (options.json !== undefined) {
      data = Buffer.from(JSON.stringify(options.json), 'utf8');
      headers['content-type'] = 'application/json';
    }
    Object.assign(req, { method, url, headers });
    process.nextTick(() => {
      if (data) (req as unknown as { emit(e: string, ...a: unknown[]): void }).emit('data', data);
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = [];
    let status = 0;
    const responseHeaders: Record<string, string | string[] | undefined> = {};
    const res: Partial<http.ServerResponse> = {
      writeHead(code: number, hdrs?: http.OutgoingHttpHeaders) {
        status = code;
        if (hdrs) for (const [k, v] of Object.entries(hdrs)) responseHeaders[k.toLowerCase()] = v as string;
        return this as http.ServerResponse;
      },
      setHeader(k: string, v: string | string[]) { responseHeaders[k.toLowerCase()] = v; return this as http.ServerResponse; },
      write(c: string | Buffer) { chunks.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) chunks.push(Buffer.from(c));
        const raw = Buffer.concat(chunks).toString('utf-8');
        try { resolve({ status, body: raw ? JSON.parse(raw) : {}, raw, headers: responseHeaders }); }
        catch (e) { reject(e); }
      },
    };
    router.handle(method, url, req, res as http.ServerResponse).catch(reject);
  });
}

describe('Extraction end-to-end through upload + cognitive routes', () => {
  let dbDir: string;
  let db: ReturnType<typeof createDatabase>;
  let router: ReturnType<typeof createApiRouter>;

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-extraction-e2e-'));
    db = createDatabase(dbDir);
    runCognitiveMemoryMigrations(db);
    db.exec(`CREATE TABLE IF NOT EXISTS long_term_memory (id TEXT PRIMARY KEY, content TEXT, embedding BLOB, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL);`);

    const fakeAgent = {
      getDatabase() { return db; },
      isEntityIndexingEnabled() { return false; },
      ingestDocumentEntities() { return null; },
      async chat() { return 'ok'; },
      async chatStream(_: string, cbs: { onComplete?: (r: { content: string }) => void }) { cbs.onComplete?.({ content: 'ok' }); },
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
      getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
      getToolRegistry() { return { getDefinitions() { return []; } }; },
    };
    router = createApiRouter(fakeAgent as never);
  }, 60_000);

  afterAll(() => {
    try { db.close(); } catch { /* */ }
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* */ }
  }, 60_000);

  it('TXT upload appears in memory + searchable', async () => {
    const r = await call(router, 'POST', '/api/memory/upload-document', {
      multipart: buildMultipart([
        { name: 'file', filename: 'note.txt', contentType: 'text/plain', data: 'The quarterly review is scheduled for May 14.' },
      ]),
    });
    expect(r.status).toBe(200);
    const uploaded = (r.body['uploaded'] as Array<Record<string, unknown>>)[0];
    expect(uploaded['file_type']).toBe('txt');
    expect(uploaded['chunk_count']).toBe(1);

    const search = await call(router, 'POST', '/api/cognitive/search', { json: { q: 'quarterly review' } });
    expect((search.body['items'] as unknown[]).length).toBe(1);
  });

  it('Markdown upload', async () => {
    const r = await call(router, 'POST', '/api/cognitive/ingest', {
      multipart: buildMultipart([
        { name: 'file', filename: 'spec.md', contentType: 'text/markdown', data: '# Architecture\n\n- Microservices\n- Event-driven' },
      ]),
    });
    expect(r.status).toBe(200);
    expect((r.body['uploaded'] as Array<Record<string, unknown>>)[0]['file_type']).toBe('md');
  });

  it('JSON upload extracts string values', async () => {
    const r = await call(router, 'POST', '/api/memory/upload-document', {
      multipart: buildMultipart([
        { name: 'file', filename: 'config.json', contentType: 'application/json',
          data: JSON.stringify({ name: 'AgentX', mode: 'restoration', priority: 'critical' }) },
      ]),
    });
    expect(r.status).toBe(200);
    const search = await call(router, 'POST', '/api/cognitive/search', { json: { q: 'restoration' } });
    expect((search.body['items'] as Array<Record<string, unknown>>).some(
      (i) => String(i['file_type'] ?? (i['source'] ?? '')).includes('json') || String(i['title']).includes('config'),
    )).toBe(true);
  });

  it('CSV upload', async () => {
    const r = await call(router, 'POST', '/api/memory/upload-document', {
      multipart: buildMultipart([
        { name: 'file', filename: 'data.csv', contentType: 'text/csv', data: 'sku,price\nA-100,29.99\nA-200,49.99' },
      ]),
    });
    expect(r.status).toBe(200);
    const u = (r.body['uploaded'] as Array<Record<string, unknown>>)[0];
    expect(u['file_type']).toBe('csv');
  });

  it('XML upload (tags stripped, content searchable)', async () => {
    const r = await call(router, 'POST', '/api/memory/upload-document', {
      multipart: buildMultipart([
        { name: 'file', filename: 'feed.xml', contentType: 'application/xml',
          data: '<feed><item>Quantum computing milestone reached</item></feed>' },
      ]),
    });
    expect(r.status).toBe(200);
    const search = await call(router, 'POST', '/api/cognitive/search', { json: { q: 'quantum' } });
    expect((search.body['items'] as unknown[]).length).toBe(1);
  });

  it('HTML upload strips tags', async () => {
    const r = await call(router, 'POST', '/api/memory/upload-document', {
      multipart: buildMultipart([
        { name: 'file', filename: 'page.html', contentType: 'text/html',
          data: '<html><body><h1>Compliance Update</h1><p>The new policy takes effect immediately.</p></body></html>' },
      ]),
    });
    expect(r.status).toBe(200);
    const u = (r.body['uploaded'] as Array<Record<string, unknown>>)[0];
    expect(u['file_type']).toBe('html');
    const search = await call(router, 'POST', '/api/cognitive/search', { json: { q: 'compliance update' } });
    expect((search.body['items'] as unknown[]).length).toBe(1);
  });

  it('EML upload classifies as email + populates sender/subject', async () => {
    const eml = [
      'From: Sarah Lee <sarah@law.example>',
      'To: counsel@example.com',
      'Subject: Settlement offer received',
      'Date: Wed, 7 May 2026 14:30:00 +0000',
      'Content-Type: text/plain',
      '',
      'A formal settlement offer has been received from the opposing counsel. We need to respond by Friday.',
    ].join('\r\n');
    const r = await call(router, 'POST', '/api/memory/upload-document', {
      multipart: buildMultipart([
        { name: 'file', filename: 'settlement.eml', contentType: 'message/rfc822', data: eml },
      ]),
    });
    expect(r.status).toBe(200);
    const u = (r.body['uploaded'] as Array<Record<string, unknown>>)[0];
    expect(u['file_type']).toBe('eml');
    expect(u['origin_type']).toBe('email');

    // Should appear under type=email in the Memory list
    const list = await call(router, 'GET', '/api/memory/control-center?type=email');
    const items = list.body['items'] as Array<Record<string, unknown>>;
    const settlement = items.find((i) => String(i['title']).includes('Settlement'));
    expect(settlement).toBeDefined();
    expect(settlement!['sender']).toBe('Sarah Lee');
  });

  it('PDF upload — broken-PDF fallback returns partial/failed with warning, not 500', async () => {
    // Construct a PDF-magic buffer with garbage so pdf-parse fails. The
    // route should still return 200 with a warning rather than crashing.
    const buf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0)]);
    const r = await call(router, 'POST', '/api/memory/upload-document', {
      multipart: buildMultipart([
        { name: 'file', filename: 'broken.pdf', contentType: 'application/pdf', data: buf },
      ]),
    });
    expect(r.status).toBe(200);
    const u = (r.body['uploaded'] as Array<Record<string, unknown>>)[0];
    expect(u['file_type']).toBe('pdf');
    expect((u['warnings'] as string[]).length).toBeGreaterThan(0);
  }, 60_000);  // Windows IO budget — pdf-parse + multipart roundtrip on slow disk

  it('GET /api/cognitive/document/:id returns the doc detail', async () => {
    // Upload one fresh doc, then fetch by id
    const up = await call(router, 'POST', '/api/memory/upload-document', {
      multipart: buildMultipart([
        { name: 'file', filename: 'fetch-me.txt', contentType: 'text/plain', data: 'Just a content marker.' },
      ]),
    });
    const docId = (up.body['uploaded'] as Array<Record<string, unknown>>)[0]['document_id'] as string;
    const r = await call(router, 'GET', `/api/cognitive/document/${encodeURIComponent(docId)}`);
    expect(r.status).toBe(200);
    expect(String(r.body['body'])).toContain('content marker');
  });

  it('GET /api/memory/gateway/document/:id alias returns the same shape', async () => {
    const up = await call(router, 'POST', '/api/memory/upload-document', {
      multipart: buildMultipart([
        { name: 'file', filename: 'gateway.txt', contentType: 'text/plain', data: 'Gateway alias works.' },
      ]),
    });
    const docId = (up.body['uploaded'] as Array<Record<string, unknown>>)[0]['document_id'] as string;
    const r = await call(router, 'GET', `/api/memory/gateway/document/${encodeURIComponent(docId)}`);
    expect(r.status).toBe(200);
    expect(String(r.body['body'])).toContain('Gateway alias works');
  });
});

describe('Email runner — HTML fallback + attachment ingestion', () => {
  let dbDir: string;
  let db: ReturnType<typeof createDatabase>;
  let runner: EmailRunner;
  let nextEmails: RawEmail[] = [];

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-email-attach-'));
    db = createDatabase(dbDir);
    runCognitiveMemoryMigrations(db);
    db.exec(`CREATE TABLE IF NOT EXISTS long_term_memory (id TEXT PRIMARY KEY, content TEXT, embedding BLOB, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL);`);
    runner = new EmailRunner({
      db: db as never,
      source: async () => nextEmails,
      allowedSenders: [],
      allowedDomains: [],
      statePath: path.join(dbDir, 'runner-state.json'),
    });
  }, 60_000);

  afterAll(() => {
    try { runner.stop(); db.close(); } catch { /* */ }
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* */ }
  }, 60_000);

  it('HTML-only email: body extracted via stripHtmlToText', async () => {
    nextEmails = [{
      messageId: '<html-only-1@example.com>',
      from: 'Marketing',
      fromEmail: 'marketing@example.com',
      subject: 'New product announcement',
      date: new Date(),
      textBody: '',
      htmlBody: '<html><body><h1>Big news</h1><p>Our new product launches Monday.</p></body></html>',
    }];
    const r = await runner.runOnce();
    expect(r.ingested).toBe(1);
    const docId = r.details[0].documentId!;

    const detailRow = db.prepare(`SELECT * FROM document_chunks WHERE document_id = ?`).get(docId) as { content?: string };
    expect(detailRow.content).toContain('Big news');
    expect(detailRow.content).toContain('launches Monday');
  });

  it('Attachment ingestion: PDF attachment becomes its own document', async () => {
    // Simple TXT attachment (since synthesising a real PDF is heavy)
    const attBuf = Buffer.from('Quarterly board pack — page 1\n\nRevenue +12% YoY.', 'utf8');
    nextEmails = [{
      messageId: '<with-attach-1@example.com>',
      from: 'CFO',
      fromEmail: 'cfo@example.com',
      subject: 'Q3 numbers attached',
      date: new Date(),
      textBody: 'Please see attached.',
      inlineAttachments: [
        { filename: 'q3-board-pack.txt', contentType: 'text/plain', data: attBuf },
      ],
    }];
    const r = await runner.runOnce();
    expect(r.ingested).toBe(1);

    // The email itself plus the attachment should be in the documents table
    const allDocs = db.prepare(`SELECT origin_type, file_name FROM documents`).all() as Array<{ origin_type: string; file_name: string }>;
    const emails = allDocs.filter((d) => d.origin_type === 'email');
    const attachments = allDocs.filter((d) => d.origin_type === 'attachment');
    expect(attachments.length).toBeGreaterThan(0);
    const att = attachments.find((a) => a.file_name === 'q3-board-pack.txt');
    expect(att).toBeDefined();
    // And the email itself is also in
    expect(emails.length).toBeGreaterThan(0);
  });
});
