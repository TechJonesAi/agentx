/**
 * Auto-sync triggers from upload + diagnostics surface lastSync state.
 *
 * Hard rule under test: upload must succeed even if sync fails. The
 * sync runs after the upload response is sent (debounced), so we
 * assert via a direct call to queueRetrievalSync with `immediate:true`
 * and observe state changes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { createDatabase, runCognitiveMemoryMigrations } from '@agentx/core';
import {
  queueRetrievalSync,
  getRetrievalSyncState,
  _resetSyncStateForTests,
} from '../../src/server/routes/retrieval-sync-state.js';

interface CognitiveSeedRow {
  document_id: string;
  file_name: string;
  mime_type: string;
  origin_type: string;
  created_at: string;
  updated_at: string;
  document_date: string;
  metadata_json: string | null;
  source_type: string;
  classification_label: string;
}

function buildCognitiveSource(filePath: string, docs: CognitiveSeedRow[]): void {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE documents (
      document_id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      file_path TEXT NOT NULL DEFAULT '/',
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
  const insertDoc = db.prepare(`INSERT INTO documents (
    document_id, file_name, file_path, mime_type, classification_label,
    classification_confidence, origin_type, document_date,
    created_at, updated_at, metadata_json, source_type
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const d of docs) {
    insertDoc.run(d.document_id, d.file_name, '/abs', d.mime_type, d.classification_label, 1.0,
      d.origin_type, d.document_date, d.created_at, d.updated_at, d.metadata_json, d.source_type);
    db.prepare(`INSERT INTO document_chunks (chunk_id, document_id, chunk_index, chunk_text, created_at)
                VALUES (?, ?, ?, ?, ?)`)
      .run(`${d.document_id}-chunk-0`, d.document_id, 0, `Content of ${d.file_name}.`, d.created_at);
  }
  db.close();
}

function fakeAgent(targetDb: unknown): unknown {
  return {
    async chat() { return 'ok'; },
    async chatStream() { /* */ },
    getLastRetrievalMetadata() { return null; },
    getDatabase: () => targetDb,
    getConfig() {
      return {
        agent: { name: 'X', defaultProvider: 'anthropic', model: 'claude-sonnet-4' },
        providers: { anthropic: { model: 'claude-sonnet-4', maxTokens: 4096 } },
      };
    },
    getSessionStore() { return null; },
    getSessionManager() { return { listActive() { return []; }, resetSession() {} }; },
    getToolRegistry() { return { getDefinitions() { return []; } }; },
  };
}

describe('Retrieval auto-sync state machine', () => {
  let tmpDir: string;
  let sourcePath: string;
  let targetDbDir: string;
  let targetDb: ReturnType<typeof createDatabase>;

  beforeEach(() => {
    _resetSyncStateForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-autosync-'));
    sourcePath = path.join(tmpDir, 'cognitive_memory.db');
    buildCognitiveSource(sourcePath, [
      { document_id: 'doc-1', file_name: 'tribunal-1.pdf', mime_type: 'application/pdf',
        origin_type: 'file', classification_label: 'knowledge_base',
        created_at: '2026-04-09T10:00:00Z', updated_at: '2026-04-09T10:00:00Z',
        document_date: '2026-04-09T10:00:00Z', metadata_json: null, source_type: 'pdf' },
      { document_id: 'doc-2', file_name: 'email-1.txt', mime_type: 'message/rfc822',
        origin_type: 'email', classification_label: 'knowledge_base',
        created_at: '2026-05-01T14:00:00Z', updated_at: '2026-05-01T14:00:00Z',
        document_date: '2026-05-01T14:00:00Z', metadata_json: null, source_type: 'text' },
    ]);
    targetDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-target-'));
    targetDb = createDatabase(targetDbDir);
    runCognitiveMemoryMigrations(targetDb);
  }, 30_000);
  afterEach(() => {
    _resetSyncStateForTests();
    try { (targetDb as unknown as { close(): void }).close(); } catch { /* */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(targetDbDir, { recursive: true, force: true });
  });

  it('initial state has no lastSync and 0 pending', () => {
    const s = getRetrievalSyncState();
    expect(s.lastSyncAt).toBeNull();
    expect(s.lastSyncResult).toBeNull();
    expect(s.pendingDocumentCount).toBe(0);
  });

  it('queue with immediate:true syncs specified documents', async () => {
    const agent = fakeAgent(targetDb);
    queueRetrievalSync(agent, ['doc-1'], { sourcePath, immediate: true });
    // Wait for the drain to complete (immediate avoids debounce)
    await new Promise((r) => setTimeout(r, 200));
    const s = getRetrievalSyncState();
    expect(s.lastSyncResult).not.toBeNull();
    expect(s.lastSyncResult?.documentsWritten).toBe(1);
    expect(s.lastSyncResult?.chunksWritten).toBe(1);
    // Verify the doc landed in target
    const cnt = (targetDb as unknown as { prepare(s: string): { get(p: unknown): { n?: number } } })
      .prepare('SELECT COUNT(*) AS n FROM documents WHERE document_id = ?').get('doc-1');
    expect(cnt.n).toBe(1);
  });

  it('queue with debounce coalesces multiple IDs into one sync', async () => {
    const agent = fakeAgent(targetDb);
    queueRetrievalSync(agent, ['doc-1']);
    queueRetrievalSync(agent, ['doc-2']);
    // Before debounce fires, both should be pending
    expect(getRetrievalSyncState().pendingDocumentCount).toBe(2);
    // Wait past debounce window (1500ms + buffer)
    await new Promise((r) => setTimeout(r, 1800));
    // Direct override of sourcePath isn't possible through debounce, so
    // this test exercises the queueing logic; the drain will try to use
    // the default ~/.agentx path which won't exist in test env. We accept
    // that the actual drain may emit a soft warning — the queueing
    // mechanism itself is what's under test.
    const s = getRetrievalSyncState();
    expect(s.pendingDocumentCount).toBe(0); // drained (success or fail)
  });

  it('sync failure is recorded in lastSyncError; upload-equivalent path does not throw', async () => {
    const agent = fakeAgent(targetDb);
    // Force a failure: point at non-existent source
    queueRetrievalSync(agent, ['doc-1'], {
      sourcePath: '/tmp/does-not-exist-cognitive.db',
      immediate: true,
    });
    await new Promise((r) => setTimeout(r, 200));
    const s = getRetrievalSyncState();
    expect(s.lastSyncError).toMatch(/not found/i);
    expect(s.lastSyncAt).not.toBeNull();
    // No throw to caller → caller (upload route) keeps running
  });

  it('repeated sync of same doc is idempotent', async () => {
    const agent = fakeAgent(targetDb);
    queueRetrievalSync(agent, ['doc-1'], { sourcePath, immediate: true });
    await new Promise((r) => setTimeout(r, 200));
    queueRetrievalSync(agent, ['doc-1'], { sourcePath, immediate: true });
    await new Promise((r) => setTimeout(r, 200));
    const cnt = (targetDb as unknown as { prepare(s: string): { get(): { n?: number } } })
      .prepare('SELECT COUNT(*) AS n FROM documents').get();
    expect(cnt.n).toBe(1); // not 2
  });

  it('zero pending IDs is a no-op', () => {
    const agent = fakeAgent(targetDb);
    queueRetrievalSync(agent, []);
    const s = getRetrievalSyncState();
    expect(s.pendingDocumentCount).toBe(0);
    expect(s.lastSyncAt).toBeNull();
  });
});
