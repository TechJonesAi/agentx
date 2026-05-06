/**
 * End-to-end test: Memory Control Center routes against a real SQLite DB.
 *
 * Inserts real rows into `documents`, `document_chunks`, and `long_term_memory`,
 * then drives the API router (no agent, just a thin DB-aware fake) and asserts
 * the SPA-contract shapes round-trip with real data.
 *
 * This is the test that proves /api/memory/control-center actually returns
 * data — not a 501 shim, not a stub.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createApiRouter } from '../../src/server/routes/api.js';
import { createDatabase, runCognitiveMemoryMigrations } from '@agentx/core';

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

describe('Memory Control Center — end-to-end against a real DB', () => {
  let dbDir: string;
  let db: ReturnType<typeof createDatabase>;
  let router: ReturnType<typeof createApiRouter>;
  const NOW = Date.now();
  const EMAIL_DATE = NOW - 86400_000; // yesterday
  const PDF_DATE = NOW - 7 * 86400_000; // last week
  const NOTE_DATE = NOW - 14 * 86400_000; // 2 weeks ago

  beforeAll(() => {
    // Real on-disk SQLite, real schema (runs main's migrations 001+007).
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-memory-test-'));
    db = createDatabase(dbDir);
    runCognitiveMemoryMigrations(db);

    // Also create the legacy long_term_memory table that
    // `memory/database.ts` would create at agent startup.
    db.exec(`
      CREATE TABLE IF NOT EXISTS long_term_memory (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding BLOB,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );
    `);

    // ── Real test data ─────────────────────────────────────────────────
    // 1. An ingested email (would have come from EmailIngestionService).
    db.prepare(
      `INSERT INTO documents (
        document_id, file_name, file_type, mime_type, content_type, origin_type,
        title, sender, sender_email, subject, document_date, ingested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'doc-email-001',
      '2026-05-05-tribunal-update.eml',
      'eml',
      'message/rfc822',
      'email',
      'email',
      'Tribunal hearing rescheduled',
      'Jane Smith',
      'jane@chambers.example.com',
      'Tribunal hearing rescheduled to June 14',
      EMAIL_DATE,
      EMAIL_DATE,
      EMAIL_DATE,
    );
    db.prepare(
      `INSERT INTO document_chunks (chunk_id, document_id, chunk_number, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'chunk-email-001-0',
      'doc-email-001',
      0,
      'Dear Mr Jones,\n\nFollowing the case management discussion, the tribunal hearing originally listed for May 14 has been rescheduled to June 14 at 10:00. Please confirm availability.\n\nKind regards,\nJane Smith\nEmployment Tribunal Service',
      EMAIL_DATE,
    );

    // 2. An ingested PDF document.
    db.prepare(
      `INSERT INTO documents (
        document_id, file_name, file_type, mime_type, content_type, origin_type,
        title, document_date, ingested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'doc-pdf-001',
      'employment-handbook-2025.pdf',
      'pdf',
      'application/pdf',
      'document',
      'upload',
      'Employment Handbook 2025',
      PDF_DATE,
      PDF_DATE,
      PDF_DATE,
    );
    db.prepare(
      `INSERT INTO document_chunks (chunk_id, document_id, chunk_number, content, created_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'chunk-pdf-001-0',
      'doc-pdf-001',
      0,
      'Employment Handbook — Section 1: Probationary period. New employees are subject to a six-month probationary period during which performance is reviewed monthly.',
      PDF_DATE,
    );

    // 3. A long-term-memory note (a "teaching" the user stored).
    db.prepare(
      `INSERT INTO long_term_memory (id, content, tags, created_at, accessed_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'note-001',
      'Always cite [DOC-N] tags when referencing employment law sources in advice.',
      JSON.stringify(['teaching', 'citation-policy']),
      NOTE_DATE,
      NOTE_DATE,
    );

    // Build a minimal agent-shaped fake exposing getDatabase().
    const fakeAgent = {
      getDatabase() { return db; },
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
      getSessionManager() { return { listActive() { return []; }, resetSession() { /* */ } }; },
      getToolRegistry() { return { getDefinitions() { return []; } }; },
    };

    router = createApiRouter(fakeAgent as never);
  });

  afterAll(() => {
    try { db.close(); } catch { /* ignore */ }
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('GET /api/memory/control-center returns the 3 inserted items, newest-first', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center');
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    const totalCount = r.body['totalCount'] as number;

    expect(totalCount).toBe(3);
    expect(items).toHaveLength(3);

    // Newest-first ordering
    expect(items[0]['id']).toBe('doc:doc-email-001');
    expect(items[1]['id']).toBe('doc:doc-pdf-001');
    expect(items[2]['id']).toBe('note:note-001');

    // Email item shape
    expect(items[0]['type']).toBe('email');
    expect(items[0]['title']).toBe('Tribunal hearing rescheduled');
    expect(items[0]['sender']).toBe('Jane Smith');
    expect(typeof items[0]['preview']).toBe('string');
    expect(String(items[0]['preview'])).toContain('hearing originally listed');
    expect(items[0]['source']).toBe('email');

    // PDF item shape
    expect(items[1]['type']).toBe('document');
    expect(items[1]['title']).toBe('Employment Handbook 2025');

    // Note item shape
    expect(items[2]['type']).toBe('note');
    expect(items[2]['title']).toContain('Always cite');
  });

  it('filters by type=email', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center?type=email');
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]['id']).toBe('doc:doc-email-001');
  });

  it('filters by type=document', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center?type=document');
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]['id']).toBe('doc:doc-pdf-001');
  });

  it('filters by type=note', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center?type=note');
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]['id']).toBe('note:note-001');
  });

  it('full-text search across documents (q=tribunal)', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center?q=tribunal');
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]['id']).toBe('doc:doc-email-001');
  });

  it('filters by sender (sender=Jane)', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center?sender=Jane');
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]['id']).toBe('doc:doc-email-001');
  });

  it('GET /api/memory/control-center/:id returns the email body and metadata', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center/doc%3Adoc-email-001');
    expect(r.status).toBe(200);
    expect(r.body['id']).toBe('doc:doc-email-001');
    expect(r.body['type']).toBe('email');
    expect(String(r.body['body'])).toContain('rescheduled to June 14');
    const md = r.body['metadata'] as Record<string, unknown>;
    expect(md['file_type']).toBe('eml');
    expect(md['origin_type']).toBe('email');
  });

  it('GET /api/memory/control-center/:id returns the note body', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center/note%3Anote-001');
    expect(r.status).toBe(200);
    expect(r.body['id']).toBe('note:note-001');
    expect(r.body['type']).toBe('note');
    expect(String(r.body['body'])).toContain('Always cite');
    const md = r.body['metadata'] as Record<string, unknown>;
    expect(Array.isArray(md['tags'])).toBe(true);
  });

  it('returns 404 for unknown ids (no leak of internal error shape)', async () => {
    const r = await call(router, 'GET', '/api/memory/control-center/doc%3Anonexistent');
    expect(r.status).toBe(404);
    expect(String(r.body['error'])).toContain('not found');
  });

  it('POST /api/memory/gateway/query returns matching items', async () => {
    const r = await call(router, 'POST', '/api/memory/gateway/query', { q: 'probationary' });
    expect(r.status).toBe(200);
    const items = r.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]['id']).toBe('doc:doc-pdf-001');
  });

  it('DELETE /api/memory/control-center/:id removes the note', async () => {
    const before = await call(router, 'GET', '/api/memory/control-center?type=note');
    expect((before.body['items'] as unknown[]).length).toBe(1);

    const del = await call(router, 'DELETE', '/api/memory/control-center/note%3Anote-001');
    expect(del.status).toBe(200);
    expect(del.body['ok']).toBe(true);

    const after = await call(router, 'GET', '/api/memory/control-center?type=note');
    expect((after.body['items'] as unknown[]).length).toBe(0);

    // Re-insert for subsequent tests in this file (if any added later).
    db.prepare(
      `INSERT INTO long_term_memory (id, content, tags, created_at, accessed_at) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      'note-001',
      'Always cite [DOC-N] tags when referencing employment law sources in advice.',
      JSON.stringify(['teaching', 'citation-policy']),
      NOTE_DATE,
      NOTE_DATE,
    );
  });

  it('POST /api/memory/control-center/bulk-delete removes multiple items', async () => {
    const del = await call(router, 'POST', '/api/memory/control-center/bulk-delete', {
      ids: ['doc:doc-pdf-001', 'note:note-001'],
    });
    expect(del.status).toBe(200);
    expect(del.body['ok']).toBe(true);
    expect(del.body['deleted']).toBe(2);

    const after = await call(router, 'GET', '/api/memory/control-center');
    const items = after.body['items'] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(1);
    expect(items[0]['id']).toBe('doc:doc-email-001');
  });
});
