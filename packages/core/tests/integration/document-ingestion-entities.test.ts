/**
 * R5.5 — legacy ingestion path entity wiring acceptance tests.
 *
 * Verifies:
 *   - The pre-existing dangling-mention bug is fixed (mentions reference
 *     the STORED entity_id from upsertEntity, not a freshly-generated one).
 *   - DocumentIngestionService.ingest() auto-populates the entity index
 *     when `enableEntityIndexing` is true.
 *   - With the flag off, no entity rows or mentions are written.
 *   - Re-running entity extraction for the same documentId removes stale
 *     mentions before writing fresh ones.
 *   - End-to-end: after ingestion, retrieval EXACT_SEARCH for a person
 *     name found in the document's text uses the entity index.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import { DocumentIngestionService } from '../../src/ingestion/document-ingestion-service.js';
import { Agent } from '../../src/agent.js';
import type { LLMResponse } from '../../src/types.js';

let tmpDir: string;
let dbFile: string;
let db: Database.Database;

// Hook timeout: 60s. Round-3 set this to 30s and it held on
// most Windows runners, but slow-runner contention can push the FTS5
// contentless migration loop past 30s. 60s matches the harness's SLOW
// budget and gives this hook enough headroom for the most-loaded
// GitHub-hosted Windows runner observed so far (CI run 25846282745).
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r5.5-'));
  dbFile = path.join(tmpDir, 'cog.db');
  db = new Database(dbFile);
  runCognitiveMemoryMigrations(db);
}, 60_000);

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function writeTextFile(content: string, name = 'doc.txt'): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content, 'utf-8');
  return p;
}

function entitiesAll(): Array<{ entity_id: string; canonical_form: string }> {
  return db.prepare('SELECT entity_id, canonical_form FROM entities').all() as never;
}

function mentionsAll(): Array<{ mention_id: string; entity_id: string; document_id: string; mention_text: string }> {
  return db.prepare('SELECT mention_id, entity_id, document_id, mention_text FROM entity_mentions').all() as never;
}

function mentionsForDoc(docId: string): number {
  const r = db.prepare('SELECT COUNT(*) as n FROM entity_mentions WHERE document_id = ?').get(docId) as { n: number };
  return r.n;
}

describe('R5.5 — legacy ingestion path with entity indexing OFF', () => {
  it('default config (no flag) writes no entity rows', async () => {
    const svc = new DocumentIngestionService(db);
    const filePath = writeTextFile('Robert Moyes attended the meeting on 2024-01-15.');
    const result = await svc.ingest(filePath, 'doc.txt', 'text/plain', 'manual');
    expect(result.status).toBe('success');
    expect(result.entityCount).toBe(0);
    expect(entitiesAll().length).toBe(0);
    expect(mentionsAll().length).toBe(0);
  });

  it('explicit enableEntityIndexing=false also writes nothing', async () => {
    const svc = new DocumentIngestionService(db, {
      maxFileSizeBytes: 10_000_000,
      enableOCR: false,
      enableEntityIndexing: false,
    });
    const filePath = writeTextFile('Robert Moyes was here.');
    const result = await svc.ingest(filePath, 'doc.txt', 'text/plain', 'manual');
    expect(result.entityCount).toBe(0);
    expect(entitiesAll().length).toBe(0);
  });
});

describe('R5.5 — legacy ingestion path with entity indexing ON', () => {
  it('ingest() auto-populates entities + mentions when flag is on', async () => {
    const svc = new DocumentIngestionService(db, {
      maxFileSizeBytes: 10_000_000,
      enableOCR: false,
      enableEntityIndexing: true,
    });
    const filePath = writeTextFile('Robert Moyes attended the meeting. Jane Doe took the notes.');
    const result = await svc.ingest(filePath, 'doc.txt', 'text/plain', 'manual');
    expect(result.status).toBe('success');
    expect(result.entityCount).toBeGreaterThanOrEqual(2);

    const ents = entitiesAll();
    const canonicals = ents.map(e => e.canonical_form).sort();
    expect(canonicals).toContain('Robert Moyes');
    expect(canonicals).toContain('Jane Doe');
  });

  it('mentions reference the STORED entity_id (no dangling — bug fix)', async () => {
    const svc = new DocumentIngestionService(db, {
      maxFileSizeBytes: 10_000_000,
      enableOCR: false,
      enableEntityIndexing: true,
    });
    // Ingest TWO documents containing the same name to exercise the
    // ON-CONFLICT path. Pre-fix, the second document's mention would
    // dangle (wrong entity_id).
    const fileA = writeTextFile('Robert Moyes signed the contract.', 'a.txt');
    await svc.ingest(fileA, 'a.txt', 'text/plain', 'manual');
    const fileB = writeTextFile('Robert Moyes also reviewed the proposal.', 'b.txt');
    await svc.ingest(fileB, 'b.txt', 'text/plain', 'manual');

    // Exactly ONE entity row for 'Robert Moyes' (cross-document dedupe)
    const robertRows = entitiesAll().filter(e => e.canonical_form === 'Robert Moyes');
    expect(robertRows.length).toBe(1);
    const robertId = robertRows[0].entity_id;

    // Both mentions reference that same stored entity_id (no dangling)
    const allMentions = mentionsAll().filter(m => m.mention_text === 'Robert Moyes');
    expect(allMentions.length).toBe(2);
    for (const m of allMentions) {
      expect(m.entity_id).toBe(robertId);
    }
  });

  it('cross-document dedupe via canonical_form UNIQUE produces ONE entity row', async () => {
    const svc = new DocumentIngestionService(db, {
      maxFileSizeBytes: 10_000_000,
      enableOCR: false,
      enableEntityIndexing: true,
    });
    for (let i = 0; i < 5; i++) {
      const f = writeTextFile(`Doc ${i}: Robert Moyes attended.`, `d${i}.txt`);
      await svc.ingest(f, `d${i}.txt`, 'text/plain', 'manual');
    }
    const robertCount = entitiesAll().filter(e => e.canonical_form === 'Robert Moyes').length;
    expect(robertCount).toBe(1);
    // 5 mentions, one per doc
    const robertMentions = mentionsAll().filter(m => m.mention_text === 'Robert Moyes');
    expect(robertMentions.length).toBe(5);
  });
});

describe('R5.5 — re-ingestion replaces stale mentions', () => {
  it('calling extractAndIndexEntities twice for the same documentId removes prior mentions', async () => {
    // We test the underlying behaviour via the EntityIngestionService directly,
    // since DocumentIngestionService.ingest() dedupes on content_hash and
    // does not call extractAndIndexEntities a second time for identical content.
    const { EntityIngestionService } = await import('../../src/entities/entity-ingestion-service.js');
    const ingestion = new EntityIngestionService(db);
    const docId = 'logical-doc-001';

    // Seed a documents row so the FK is materially satisfied
    db.prepare(`
      INSERT INTO documents (
        document_id, file_name, file_type, mime_type, content_type, origin_type,
        page_count, chunk_count, ocr_required, ocr_completed,
        classification_confidence, extraction_status, indexing_status,
        content_hash, ingested_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(docId, 'logical.txt', 'txt', 'text/plain', 'document', 'manual',
           0, 0, 0, 0, 1.0, 'extracted', 'indexed', `h-${docId}`, Date.now(), Date.now());

    const r1 = ingestion.ingestDocument(docId, 'Robert Moyes met with Jane Doe.');
    expect(r1.staleMentionsRemoved).toBe(0);
    expect(mentionsForDoc(docId)).toBe(2);

    const r2 = ingestion.ingestDocument(docId, 'Anna Bell prepared the report.');
    expect(r2.staleMentionsRemoved).toBe(2);
    expect(mentionsForDoc(docId)).toBe(1);

    // Anna Bell entity exists; Robert Moyes still in entities table (from r1)
    // but has no mention attached to docId
    const annaMentions = mentionsAll().filter(m => m.mention_text === 'Anna Bell');
    expect(annaMentions.length).toBe(1);
    const robertMentionsForDoc = mentionsAll().filter(m => m.mention_text === 'Robert Moyes' && m.document_id === docId);
    expect(robertMentionsForDoc.length).toBe(0);
  });
});

describe('R5.5 — end-to-end: ingestion → retrieval', () => {
  it('after legacy ingest with flag on, retrieval EXACT_SEARCH for the name uses entity index', async () => {
    // Build a fresh Agent with both retrieval AND a separately-ingested
    // document so that the agent's DB also has entries.
    const agentTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r5.5-e2e-'));
    const prevDataDir = process.env['DATA_DIR'];
    process.env['DATA_DIR'] = agentTmp;
    try {
      const yaml = [
        'agent:',
        '  name: AgentX-Test',
        '  defaultProvider: ollama',
        '  model: llama3',
        '  retrieval:',
        '    enabled: true',
        '  entityIndexing:',
        '    enabled: true',
        'providers:',
        '  ollama:',
        '    model: llama3',
        '    baseUrl: http://localhost:11434',
        'memory:',
        '  maxConversationHistory: 100',
        '  summarizeAfter: 50',
        '  embeddingProvider: local',
        'sessions:',
        '  persistToDisk: false',
        '  ttlMinutes: 60',
        'skills:',
        '  directory: ./skills',
        '  autoReload: false',
        'browser:',
        '  headless: true',
        '  timeout: 30000',
        'health:',
        '  enabled: false',
        '  port: 9090',
        '',
      ].join('\n');
      const cfg = path.join(agentTmp, 'agentx.yaml');
      fs.writeFileSync(cfg, yaml, 'utf-8');
      const agent = new Agent(cfg);

      // Run the legacy ingest path against the agent's DB
      const agentDb = (agent as unknown as { db: Database.Database }).db;
      const svc = new DocumentIngestionService(agentDb, {
        maxFileSizeBytes: 10_000_000,
        enableOCR: false,
        enableEntityIndexing: true,
      });
      const fileA = writeTextFile('Robert Moyes signed the indemnity agreement.', 'agree.txt');
      const ingestResult = await svc.ingest(fileA, 'agree.txt', 'text/plain', 'manual');
      expect(ingestResult.status).toBe('success');
      expect(ingestResult.entityCount).toBeGreaterThanOrEqual(1);

      // Stub the LLM provider so chat() doesn't hit a network
      const stub = {
        isConfigured: () => true,
        async complete(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
        async completeStream(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
      };
      (agent as unknown as { provider: typeof stub }).provider = stub;

      await agent.chat('show all references to robert moyes');
      const meta = agent.getLastRetrievalMetadata();
      expect(meta).not.toBeNull();
      expect(meta!.retrievalIntent).toBe('EXACT_SEARCH');
      expect(meta!.retrievalSource).toBe('entity');
      expect(meta!.retrievalDocuments[0].document_id).toBe(ingestResult.documentId);

      await agent.shutdown?.();
    } finally {
      if (prevDataDir === undefined) delete process.env['DATA_DIR'];
      else process.env['DATA_DIR'] = prevDataDir;
      try { fs.rmSync(agentTmp, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
