/**
 * syncCognitiveToRetrieval — one-way idempotent sync tests.
 *
 * Build a tiny on-disk cognitive_memory.db (silly schema) and a fresh
 * agentx.db (main migration-001 schema via runCognitiveMemoryMigrations).
 * Run the sync, assert counts + idempotency + that re-running doesn't
 * duplicate. Verify cognitive_memory.db is opened read-only (cannot be
 * mutated).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { syncCognitiveToRetrieval, createDatabase, runCognitiveMemoryMigrations } from '../../src/index.js';

function buildCognitiveSource(filePath: string): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE documents (
      document_id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      file_size_bytes INTEGER NOT NULL DEFAULT 0,
      classification_label TEXT,
      classification_confidence REAL DEFAULT 0,
      origin_type TEXT,
      sender TEXT,
      recipient TEXT,
      document_date TEXT,
      created_at TEXT,
      updated_at TEXT,
      word_count INTEGER DEFAULT 0,
      metadata_json TEXT,
      source_type TEXT,
      content_hash TEXT
    );
    CREATE TABLE document_chunks (
      chunk_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      page_id TEXT,
      chunk_index INTEGER NOT NULL,
      chunk_text TEXT NOT NULL,
      token_count INTEGER DEFAULT 0,
      semantic_vector BLOB,
      is_indexed BOOLEAN DEFAULT 0,
      created_at TEXT
    );
    CREATE TABLE document_pages (
      page_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      page_text TEXT NOT NULL,
      extracted_text TEXT,
      ocr_confidence REAL,
      created_at TEXT
    );
  `);
  // Two documents
  db.prepare(`INSERT INTO documents (
    document_id, file_name, file_path, mime_type, classification_label,
    classification_confidence, origin_type, sender, document_date,
    created_at, updated_at, word_count, metadata_json, source_type, content_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'doc-A', 'tribunal-report.pdf', '/abs/tribunal.pdf', 'application/pdf',
    'knowledge_base', 1.0, 'file', null, '2026-04-09T10:00:00Z',
    '2026-04-09T10:00:00Z', '2026-04-09T11:00:00Z', 500,
    JSON.stringify({ collection: 'Law', subject: 'Tribunal hearing notes' }), 'pdf', 'hash-A',
  );
  db.prepare(`INSERT INTO documents (
    document_id, file_name, file_path, mime_type, classification_label,
    classification_confidence, origin_type, sender, document_date,
    created_at, updated_at, word_count, metadata_json, source_type, content_hash
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    'doc-B', 'email.txt', '/abs/email.txt', 'message/rfc822',
    'knowledge_base', 0.9, 'email', 'alice@example.com', '2026-05-01T14:00:00Z',
    '2026-05-01T14:00:00Z', '2026-05-01T14:00:00Z', 120,
    null, 'text', 'hash-B',
  );
  // Three pages for doc-A
  for (let p = 1; p <= 3; p++) {
    db.prepare(`INSERT INTO document_pages (
      page_id, document_id, page_number, page_text, extracted_text, ocr_confidence, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      `page-A-${p}`, 'doc-A', p, `Page ${p} body text.`, `raw page ${p}`,
      0.85, '2026-04-09T11:00:00Z',
    );
  }
  // Three chunks for doc-A — chunk-i references page-A-(i+1) for provenance
  for (let i = 0; i < 3; i++) {
    db.prepare(`INSERT INTO document_chunks (
      chunk_id, document_id, page_id, chunk_index, chunk_text, token_count, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      `chunk-A-${i}`, 'doc-A', `page-A-${i + 1}`, i,
      `Tribunal section ${i + 1}.`, 5, '2026-04-09T11:00:00Z',
    );
  }
  db.prepare(`INSERT INTO document_chunks (
    chunk_id, document_id, page_id, chunk_index, chunk_text, token_count, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    'chunk-B-0', 'doc-B', null, 0, 'Hello from Alice.', 3, '2026-05-01T14:00:00Z',
  );
  db.close();
}

describe('syncCognitiveToRetrieval', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetDb: ReturnType<typeof createDatabase>;
  let targetDbDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-sync-'));
    sourcePath = path.join(tmpDir, 'cognitive_memory.db');
    buildCognitiveSource(sourcePath);
    targetDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-target-'));
    targetDb = createDatabase(targetDbDir);
    runCognitiveMemoryMigrations(targetDb);
  }, 60_000);
  afterEach(() => {
    try { (targetDb as unknown as { close(): void }).close(); } catch { /* */ }
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* */ }
    try { fs.rmSync(targetDbDir, { recursive: true, force: true }); } catch { /* */ }
  });

  it('writes documents + chunks + pages from cognitive_memory.db into agentx.db', async () => {
    const r = await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    expect(r.cognitiveDocumentCount).toBe(2);
    expect(r.documentsWritten).toBe(2);
    expect(r.chunksWritten).toBe(4);
    expect(r.pagesWritten).toBe(3);
    expect(r.documentsSkipped).toBe(0);
    expect(r.pagesSkipped).toBe(0);
    expect(r.targetDocumentCount).toBe(2);
    expect(r.targetChunkCount).toBe(4);
    expect(r.targetPageCount).toBe(3);
    // 3 of 4 chunks reference a page (doc-A chunks); the 1 doc-B chunk has page_id=null
    expect(r.chunksWithPageId).toBe(3);
    expect(r.documentIds).toEqual(expect.arrayContaining(['doc-A', 'doc-B']));
  });

  it('preserves chunk page_id → page_number provenance via FK', async () => {
    await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    const row = (targetDb as unknown as { prepare(s: string): { get(p: unknown): unknown } })
      .prepare(`SELECT c.chunk_id, c.page_id, p.page_number, p.content
                FROM document_chunks c
                LEFT JOIN document_pages p ON c.page_id = p.page_id
                WHERE c.chunk_id = ?`)
      .get('chunk-A-1') as Record<string, unknown>;
    expect(row['chunk_id']).toBe('chunk-A-1');
    expect(row['page_id']).toBe('page-A-2');
    expect(row['page_number']).toBe(2);
    expect(row['content']).toBe('Page 2 body text.');
  });

  it('renames page_text → content and extracted_text → raw_content', async () => {
    await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    const row = (targetDb as unknown as { prepare(s: string): { get(p: unknown): unknown } })
      .prepare('SELECT content, raw_content, ocr_confidence FROM document_pages WHERE page_id = ?')
      .get('page-A-1') as Record<string, unknown>;
    expect(row['content']).toBe('Page 1 body text.');
    expect(row['raw_content']).toBe('raw page 1');
    expect(row['ocr_confidence']).toBe(0.85);
  });

  it('is idempotent — running twice produces the same final counts', async () => {
    await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    const second = await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    expect(second.targetDocumentCount).toBe(2);
    expect(second.targetChunkCount).toBe(4);
    expect(second.targetPageCount).toBe(3);
    // No duplicates
    const allDocs = (targetDb as unknown as { prepare(s: string): { all(): unknown[] } })
      .prepare('SELECT document_id FROM documents').all() as Array<{ document_id: string }>;
    expect(allDocs).toHaveLength(2);
  });

  it('maps mime_type → file_type and preserves classification', async () => {
    await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    const row = (targetDb as unknown as { prepare(s: string): { get(p: unknown): unknown } })
      .prepare('SELECT file_type, content_type, classification_label, sender FROM documents WHERE document_id = ?')
      .get('doc-A') as Record<string, unknown>;
    expect(row['file_type']).toBe('pdf');
    expect(row['content_type']).toBe('document');
    expect(row['classification_label']).toBe('knowledge_base');
    expect(row['sender']).toBeNull();
  });

  it('extracts subject from metadata_json', async () => {
    await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    const row = (targetDb as unknown as { prepare(s: string): { get(p: unknown): unknown } })
      .prepare('SELECT subject FROM documents WHERE document_id = ?')
      .get('doc-A') as { subject?: string };
    expect(row.subject).toBe('Tribunal hearing notes');
  });

  it('emails carry sender + content_type=email', async () => {
    await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    const row = (targetDb as unknown as { prepare(s: string): { get(p: unknown): unknown } })
      .prepare('SELECT content_type, sender FROM documents WHERE document_id = ?')
      .get('doc-B') as Record<string, unknown>;
    expect(row['content_type']).toBe('email');
    expect(row['sender']).toBe('alice@example.com');
  });

  it('parses TEXT timestamps into INTEGER epochs', async () => {
    await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    const row = (targetDb as unknown as { prepare(s: string): { get(p: unknown): unknown } })
      .prepare('SELECT ingested_at, updated_at, document_date FROM documents WHERE document_id = ?')
      .get('doc-A') as Record<string, number>;
    expect(row['ingested_at']).toBe(Date.parse('2026-04-09T10:00:00Z'));
    expect(row['updated_at']).toBe(Date.parse('2026-04-09T11:00:00Z'));
    expect(row['document_date']).toBe(Date.parse('2026-04-09T10:00:00Z'));
  });

  it('does NOT mutate the source cognitive_memory.db', async () => {
    const before = fs.statSync(sourcePath).mtimeMs;
    await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never });
    const after = fs.statSync(sourcePath).mtimeMs;
    // Read-only handle: mtime should be unchanged (within a few ms of test boot
    // because some OSes may update access time but not mtime for reads).
    expect(after).toBe(before);
  });

  it('respects limit param', async () => {
    const r = await syncCognitiveToRetrieval({ sourcePath, targetDb: targetDb as never, limit: 1 });
    expect(r.documentsWritten).toBe(1);
    // Only chunks belonging to the one synced doc
    expect(r.chunksWritten).toBeGreaterThan(0);
    expect(r.chunksWritten).toBeLessThanOrEqual(3);
  });

  it('throws when target schema is missing', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-empty-'));
    const emptyDb = createDatabase(emptyDir);
    // Intentionally do NOT run cognitive migrations on this DB.
    await expect(
      syncCognitiveToRetrieval({ sourcePath, targetDb: emptyDb as never }),
    ).rejects.toThrow(/Target DB missing/);
    try { (emptyDb as unknown as { close(): void }).close(); } catch { /* */ }
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('throws when source path does not exist', async () => {
    await expect(
      syncCognitiveToRetrieval({ sourcePath: '/tmp/does-not-exist.db', targetDb: targetDb as never }),
    ).rejects.toThrow(/Source DB not found/);
  });
});
