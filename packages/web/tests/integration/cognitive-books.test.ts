/**
 * Cognitive Books subsystem — GET/PATCH/POST routes.
 *
 * Uses a real on-disk SQLite via createDatabase + runCognitiveMemoryMigrations,
 * which creates main's `documents` + `document_pages` + `document_chunks`
 * tables. Tests inject the DB via a fake `agent.getDatabase()` and exercise
 * the route handlers end-to-end.
 *
 * Coverage:
 *   - GET /api/cognitive/books on empty DB
 *   - GET /api/cognitive/books with one seeded book
 *   - GET /api/cognitive/books/:id pages + collection
 *   - GET /api/cognitive/books/:id 404 when missing
 *   - PATCH /api/cognitive/books/:id/collection updates metadata
 *   - PATCH 404 when book missing
 *   - POST /api/cognitive/ingest-book rejects non-multipart
 *   - POST /api/cognitive/ingest-book rejects missing book_name + files
 *   - GET /api/cognitive/books/diagnostics surfaces the bound DB path
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createDatabase, runCognitiveMemoryMigrations } from '@agentx/core';
import { createApiRouter } from '../../src/server/routes/api.js';

interface CallResult { status: number; body: Record<string, unknown>; raw: string; }

function callJson(
  router: ReturnType<typeof createApiRouter>, method: string, url: string, body?: unknown,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const req = new http.IncomingMessage(null as unknown as never);
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    Object.assign(req, { method, url, headers });
    process.nextTick(() => {
      if (body !== undefined) {
        (req as unknown as { emit(e: string, c?: Buffer): void }).emit('data', Buffer.from(JSON.stringify(body)));
      }
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const chunks: Buffer[] = [];
    let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(c: number) { status = c; return this as http.ServerResponse; },
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

function callMultipart(
  router: ReturnType<typeof createApiRouter>, url: string,
  parts: Array<{ name: string; filename?: string; contentType?: string; data: Buffer }>,
): Promise<CallResult> {
  return new Promise((resolve, reject) => {
    const boundary = '----testb' + Math.random().toString(16).slice(2);
    const chunks: Buffer[] = [];
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
    const req = new http.IncomingMessage(null as unknown as never);
    Object.assign(req, { method: 'POST', url,
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } });
    process.nextTick(() => {
      (req as unknown as { emit(e: string, c?: Buffer): void }).emit('data', body);
      (req as unknown as { emit(e: string): void }).emit('end');
    });
    const out: Buffer[] = []; let status = 0;
    const res: Partial<http.ServerResponse> = {
      writeHead(c: number) { status = c; return this as http.ServerResponse; },
      setHeader() { return this as http.ServerResponse; },
      write(c: string | Buffer) { out.push(Buffer.from(c)); return true; },
      end(c?: string | Buffer) {
        if (c) out.push(Buffer.from(c));
        const raw = Buffer.concat(out).toString('utf-8');
        try { resolve({ status, body: raw ? JSON.parse(raw) : {}, raw }); }
        catch (e) { reject(e); }
      },
    };
    router.handle('POST', url, req, res as http.ServerResponse).catch(reject);
  });
}

function fakeAgent(db: unknown): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    getDatabase() { return db; },
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
}

describe('Cognitive Books — end-to-end against real DB', () => {
  let dbDir: string;
  let db: ReturnType<typeof createDatabase>;
  let router: ReturnType<typeof createApiRouter>;
  let savedDataDir: string | undefined;

  beforeAll(() => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-books-test-'));
    // Isolate from the user's real ~/.agentx/cognitive_memory.db — the
    // cognitive-adapter prefers on-disk cognitive_memory.db over the
    // agent-supplied DB, which would otherwise leak the real 253 docs
    // into test expectations.
    savedDataDir = process.env['DATA_DIR'];
    process.env['DATA_DIR'] = dbDir;
    db = createDatabase(dbDir);
    runCognitiveMemoryMigrations(db);
  }, 60_000);

  afterAll(() => {
    if (savedDataDir === undefined) delete process.env['DATA_DIR'];
    else process.env['DATA_DIR'] = savedDataDir;
  }, 60_000);

  beforeEach(() => {
    db.exec(`DELETE FROM document_pages; DELETE FROM document_chunks; DELETE FROM documents;`);
    router = createApiRouter(fakeAgent(db) as never);
  });

  describe('GET /api/cognitive/books', () => {
    it('returns empty array when no books exist', async () => {
      const r = await callJson(router, 'GET', '/api/cognitive/books');
      expect(r.status).toBe(200);
      expect(r.body['books']).toEqual([]);
    });

    it('returns books with metadata.collection and page count', async () => {
      // Seed a book document with 3 pages
      const ingestedAt = Date.now();
      db.prepare(`INSERT INTO documents (
        document_id, file_name, file_type, mime_type, content_type, origin_type,
        document_date, ingested_at, updated_at, classification_label
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'doc-book-001', 'Employment Handbook', 'book', 'image/book-collection',
        'document', 'upload', ingestedAt, ingestedAt, ingestedAt, 'knowledge_base',
      );
      // metadata_json column may or may not exist (depends on which schema
      // migration ran); add it tolerantly.
      try {
        db.exec(`ALTER TABLE documents ADD COLUMN metadata_json TEXT`);
      } catch { /* already exists */ }
      db.prepare(`UPDATE documents SET metadata_json = ? WHERE document_id = ?`)
        .run(JSON.stringify({ type: 'book', collection: 'Law' }), 'doc-book-001');
      for (let p = 1; p <= 3; p++) {
        db.prepare(`INSERT INTO document_pages (
          page_id, document_id, page_number, content, ocr_confidence, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)`).run(`pg-${p}`, 'doc-book-001', p, `Page ${p} text`, 0.9, Date.now());
      }

      const r = await callJson(router, 'GET', '/api/cognitive/books');
      expect(r.status).toBe(200);
      const books = r.body['books'] as Array<Record<string, unknown>>;
      expect(books).toHaveLength(1);
      expect(books[0]['document_id']).toBe('doc-book-001');
      expect(books[0]['name']).toBe('Employment Handbook');
      expect(books[0]['page_count']).toBe(3);
      expect(books[0]['collection']).toBe('Law');
    });
  });

  describe('GET /api/cognitive/books/:id', () => {
    it('returns 404 when missing', async () => {
      const r = await callJson(router, 'GET', '/api/cognitive/books/does-not-exist');
      expect(r.status).toBe(404);
    });

    it('returns book detail with pages and parsed metadata', async () => {
      try { db.exec(`ALTER TABLE documents ADD COLUMN metadata_json TEXT`); } catch { /* */ }
      const ts = Date.now();
      db.prepare(`INSERT INTO documents (
        document_id, file_name, file_type, mime_type, content_type, origin_type,
        document_date, ingested_at, updated_at, classification_label, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'doc-book-002', 'My Book', 'book', 'image/book-collection',
        'document', 'upload', ts, ts, ts, 'knowledge_base',
        JSON.stringify({ type: 'book', collection: 'Personal' }),
      );
      db.prepare(`INSERT INTO document_pages (
        page_id, document_id, page_number, content, ocr_confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`).run('pg-a', 'doc-book-002', 1, 'Hello page 1', 0.95, Date.now());
      db.prepare(`INSERT INTO document_pages (
        page_id, document_id, page_number, content, ocr_confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`).run('pg-b', 'doc-book-002', 2, 'Hello page 2', 0.85, Date.now());

      const r = await callJson(router, 'GET', '/api/cognitive/books/doc-book-002');
      expect(r.status).toBe(200);
      expect(r.body['document_id']).toBe('doc-book-002');
      expect(r.body['name']).toBe('My Book');
      expect(r.body['collection']).toBe('Personal');
      expect(r.body['page_count']).toBe(2);
      const pages = r.body['pages'] as Array<Record<string, unknown>>;
      expect(pages).toHaveLength(2);
      expect(pages[0]['page_number']).toBe(1);
      expect(pages[0]['page_text']).toBe('Hello page 1');
    });
  });

  describe('PATCH /api/cognitive/books/:id/collection', () => {
    it('updates metadata.collection', async () => {
      try { db.exec(`ALTER TABLE documents ADD COLUMN metadata_json TEXT`); } catch { /* */ }
      const ts = Date.now();
      db.prepare(`INSERT INTO documents (
        document_id, file_name, file_type, mime_type, content_type, origin_type,
        document_date, ingested_at, updated_at, classification_label, metadata_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        'doc-book-003', 'B3', 'book', 'image/book-collection',
        'document', 'upload', ts, ts, ts, 'knowledge_base',
        JSON.stringify({ type: 'book', collection: 'Old' }),
      );

      const r = await callJson(router, 'PATCH', '/api/cognitive/books/doc-book-003/collection',
        { collection: 'Medical' });
      expect(r.status).toBe(200);
      expect(r.body['ok']).toBe(true);
      expect(r.body['collection']).toBe('Medical');

      const refetch = await callJson(router, 'GET', '/api/cognitive/books/doc-book-003');
      expect((refetch.body['metadata'] as Record<string, unknown>)['collection']).toBe('Medical');
    });

    it('returns 404 when book missing', async () => {
      const r = await callJson(router, 'PATCH', '/api/cognitive/books/missing-id/collection',
        { collection: 'X' });
      expect(r.status).toBe(404);
    });

    it('rejects non-string collection', async () => {
      const r = await callJson(router, 'PATCH', '/api/cognitive/books/anything/collection',
        { collection: 123 });
      expect(r.status).toBe(400);
    });
  });

  describe('POST /api/cognitive/ingest-book', () => {
    it('rejects non-multipart body', async () => {
      const r = await callJson(router, 'POST', '/api/cognitive/ingest-book', { book_name: 'x' });
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toMatch(/multipart/i);
    });

    it('rejects missing book_name AND document_id', async () => {
      const r = await callMultipart(router, '/api/cognitive/ingest-book', [
        { name: 'image', filename: 'p1.png', contentType: 'image/png',
          data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
      ]);
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toMatch(/book_name or document_id/i);
    });

    it('rejects no files', async () => {
      const r = await callMultipart(router, '/api/cognitive/ingest-book', [
        { name: 'book_name', data: Buffer.from('Test Book') },
      ]);
      expect(r.status).toBe(400);
      expect(String(r.body['error'])).toMatch(/no image files/i);
    });

    // Note: success path requires tesseract.js to actually OCR a real image.
    // We don't exercise OCR here because it's slow and dependency-heavy in CI.
    // The handler returns 422 when tesseract isn't loadable — covered separately.
  });

  describe('GET /api/cognitive/books/diagnostics', () => {
    it('returns the bound DB path', async () => {
      const r = await callJson(router, 'GET', '/api/cognitive/books/diagnostics');
      expect(r.status).toBe(200);
      expect(typeof r.body['dbPath']).toBe('string');
    });
  });
});
