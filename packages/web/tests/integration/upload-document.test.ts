/**
 * End-to-end test: document upload → DB → Memory list → retrieval.
 *
 * Inserts no fixtures up front. Drives the api router by:
 *  1. POSTing multipart/form-data to /api/memory/upload-document with a TXT
 *     file. Asserts the response shape includes a real document_id.
 *  2. GETting /api/memory/control-center — the uploaded TXT must appear.
 *  3. POSTing /api/memory/gateway/query with a word from the file content.
 *  4. POSTing the same file again and asserting duplicate_of is set.
 *  5. GETting the file's detail and asserting body matches the original.
 *
 * Also asserts /api/cognitive/ingest accepts the same multipart shape.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApiRouter } from '../../src/server/routes/api.js';
import { createDatabase, runCognitiveMemoryMigrations } from '@agentx/core';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function jsonCall(
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

/** Build a multipart/form-data body with one or more file parts. */
function buildMultipart(parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer | string; }>): { body: Buffer; contentType: string; } {
  const boundary = `----testboundary${Date.now()}`;
  const segments: Buffer[] = [];
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

function multipartCall(
  router: ReturnType<typeof createApiRouter>,
  url: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer | string; }>,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const { body, contentType } = buildMultipart(parts);
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, {
      method: 'POST',
      url,
      headers: { 'content-type': contentType, 'content-length': String(body.length) },
    });
    process.nextTick(() => {
      (req as unknown as { emit(e: string, ...a: unknown[]): void }).emit('data', body);
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
    router.handle('POST', url, req, res as http.ServerResponse).catch(reject);
  });
}

describe('Document upload — end-to-end against a real DB', () => {
  let dbDir: string;
  let db: ReturnType<typeof createDatabase>;
  let router: ReturnType<typeof createApiRouter>;

  const SAMPLE_TXT_CONTENT = `Employment Tribunal Brief — 2026

Section 1: Probationary period
New employees serve a six-month probation period during which performance is reviewed monthly.

Section 2: Notice periods
Statutory minimum notice is one week per year of service, capped at twelve weeks.

Section 3: Holiday entitlement
Twenty-eight days statutory minimum, inclusive of bank holidays.`;

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-upload-test-'));
    db = createDatabase(dbDir);
    runCognitiveMemoryMigrations(db);
    db.exec(`CREATE TABLE IF NOT EXISTS long_term_memory (id TEXT PRIMARY KEY, content TEXT, embedding BLOB, tags TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, accessed_at INTEGER NOT NULL);`);

    const fakeAgent = {
      getDatabase() { return db; },
      isEntityIndexingEnabled() { return false; },
      ingestDocumentEntities() { return null; },
      async chat() { return 'ok'; },
      async chatStream() { /* */ },
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
  }, 60_000);

  afterAll(() => {
    try { db.close(); } catch { /* */ }
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('POST /api/memory/upload-document accepts a TXT file and returns document_id', async () => {
    const r = await multipartCall(router, '/api/memory/upload-document', [
      { name: 'file', filename: 'tribunal-brief.txt', contentType: 'text/plain', data: SAMPLE_TXT_CONTENT },
    ]);
    expect(r.status).toBe(200);
    expect(r.body['ok']).toBe(true);
    const uploaded = r.body['uploaded'] as Array<Record<string, unknown>>;
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]['file_name']).toBe('tribunal-brief.txt');
    expect(uploaded[0]['file_type']).toBe('txt');
    expect(uploaded[0]['mime_type']).toBe('text/plain');
    expect(typeof uploaded[0]['document_id']).toBe('string');
    expect(String(uploaded[0]['document_id'])).toMatch(/^doc-/);
    // Real chunking happened (text is ~50 words, fits in one chunk)
    expect(uploaded[0]['chunk_count']).toBe(1);
    expect(Number(uploaded[0]['word_count'])).toBeGreaterThan(20);
    expect(uploaded[0]['duplicate_of']).toBeNull();
  });

  it('uploaded TXT now appears in /api/memory/control-center', async () => {
    const r = await jsonCall(router, 'GET', '/api/memory/control-center');
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThan(0);
    const ours = items.find((i) => String(i['title']) === 'tribunal-brief');
    expect(ours).toBeDefined();
    expect(ours!['type']).toBe('document');
    expect(String(ours!['preview'])).toContain('Probationary period');
  });

  it('GET /api/memory/control-center/:id returns the full body', async () => {
    const list = await jsonCall(router, 'GET', '/api/memory/control-center?type=document');
    const items = list.body['items'] as Array<Record<string, unknown>>;
    const id = String(items[0]['id']);
    const r = await jsonCall(router, 'GET', `/api/memory/control-center/${encodeURIComponent(id)}`);
    expect(r.status).toBe(200);
    expect(String(r.body['body'])).toContain('Employment Tribunal Brief');
    expect(String(r.body['body'])).toContain('Twenty-eight days statutory minimum');
    expect(r.body['type']).toBe('document');
  });

  it('full-text search finds the upload by chunk-content match (q=probationary)', async () => {
    const r = await jsonCall(router, 'POST', '/api/memory/gateway/query', { q: 'probationary' });
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((i) => String(i['title']) === 'tribunal-brief')).toBe(true);
  });

  it('uploading the same content again returns duplicate_of (idempotent on content_hash)', async () => {
    const r = await multipartCall(router, '/api/memory/upload-document', [
      { name: 'file', filename: 'tribunal-brief-v2.txt', contentType: 'text/plain', data: SAMPLE_TXT_CONTENT },
    ]);
    expect(r.status).toBe(200);
    const uploaded = r.body['uploaded'] as Array<Record<string, unknown>>;
    expect(uploaded[0]['duplicate_of']).toBeTruthy();
    expect(uploaded[0]['chunk_count']).toBe(0); // no new chunks written
  });

  it('/api/cognitive/ingest accepts the same multipart shape', async () => {
    const r = await multipartCall(router, '/api/cognitive/ingest', [
      { name: 'file', filename: 'notes.md', contentType: 'text/markdown', data: '# Meeting notes\n\nDiscussed Q3 budget allocation.' },
    ]);
    expect(r.status).toBe(200);
    const uploaded = r.body['uploaded'] as Array<Record<string, unknown>>;
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]['file_type']).toBe('md');
    expect(uploaded[0]['mime_type']).toBe('text/markdown');
  });

  it('rejects multipart with no files', async () => {
    const r = await multipartCall(router, '/api/memory/upload-document', [
      { name: 'description', data: 'just a text field' },
    ]);
    expect(r.status).toBe(400);
    expect(r.body['ok']).toBe(false);
    expect(String(r.body['error'])).toContain('no files');
  });

  it('rejects non-multipart bodies cleanly', async () => {
    const r = await jsonCall(router, 'POST', '/api/memory/upload-document', { not: 'multipart' });
    expect(r.status).toBe(400);
    expect(r.body['ok']).toBe(false);
    expect(String(r.body['error'])).toMatch(/multipart/i);
  });

  it('extracts the title from filename (strips extension)', async () => {
    const r = await multipartCall(router, '/api/memory/upload-document', [
      { name: 'file', filename: 'q3-2026-board-pack.txt', contentType: 'text/plain', data: 'Board pack contents — confidential.' },
    ]);
    expect(r.status).toBe(200);
    const list = await jsonCall(router, 'GET', '/api/memory/control-center?q=board');
    const items = list.body['items'] as Array<Record<string, unknown>>;
    const ours = items.find((i) => String(i['title']) === 'q3-2026-board-pack');
    expect(ours).toBeDefined();
  });
});
