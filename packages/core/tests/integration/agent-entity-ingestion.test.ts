/**
 * R5 — entity ingestion wiring acceptance tests.
 *
 * Verifies:
 *   - feature flag default off — ingestDocumentEntities is a no-op
 *   - flag on — extracting "Robert Moyes" creates entity + mention rows
 *   - cross-document dedupe — same canonical name → single entity, multiple mentions
 *   - re-ingest of same document — stale mentions removed, fresh ones written
 *   - end-to-end — after ingestion, retrieval EXACT_SEARCH path uses entity index
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent.js';
import { DocumentRegistry } from '../../src/memory/document-registry.js';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import Database from 'better-sqlite3';
import type { LLMResponse } from '../../src/types.js';

interface AgentOpts {
  retrieval?: { enabled: boolean };
  entityIndexing?: { enabled: boolean };
  omit?: boolean;
}

function writeConfig(dir: string, opts: AgentOpts = {}): string {
  const blocks: string[] = [];
  if (!opts.omit) {
    if (opts.retrieval) {
      blocks.push(`  retrieval:\n    enabled: ${opts.retrieval.enabled}`);
    }
    if (opts.entityIndexing) {
      blocks.push(`  entityIndexing:\n    enabled: ${opts.entityIndexing.enabled}`);
    }
  }
  const yaml = [
    'agent:',
    '  name: AgentX-Test',
    '  defaultProvider: ollama',
    '  model: llama3',
    ...blocks,
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
  const p = path.join(dir, 'agentx.yaml');
  fs.writeFileSync(p, yaml, 'utf-8');
  return p;
}

let tmpDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r5-'));
  prevDataDir = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = prevDataDir;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function buildAgent(opts: AgentOpts = {}): Agent {
  return new Agent(writeConfig(tmpDir, opts));
}

function stubProvider(agent: Agent): void {
  const stub = {
    isConfigured: () => true,
    async complete(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
    async completeStream(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
  };
  (agent as unknown as { provider: typeof stub }).provider = stub;
}

function getDb(agent: Agent): Database.Database {
  return (agent as unknown as { db: Database.Database }).db;
}

function seedDocument(db: Database.Database, fileName: string, hash: string): string {
  runCognitiveMemoryMigrations(db);
  const reg = new DocumentRegistry(db);
  const doc = reg.create({
    file_name: fileName,
    file_type: 'pdf',
    mime_type: 'application/pdf',
    content_type: 'document',
    origin_type: 'born_digital',
    title: 'Test Document',
    page_count: 1, chunk_count: 1, ocr_required: false, ocr_completed: false,
    classification_label: 'document',
    classification_confidence: 1.0,
    classification_method: 'manual',
    extraction_status: 'extracted',
    indexing_status: 'indexed',
    content_hash: hash,
  });
  return doc.document_id;
}

function countEntities(db: Database.Database): number {
  const r = db.prepare('SELECT COUNT(*) as n FROM entities').get() as { n: number };
  return r.n;
}

function countMentions(db: Database.Database, documentId?: string): number {
  if (documentId) {
    const r = db.prepare('SELECT COUNT(*) as n FROM entity_mentions WHERE document_id = ?').get(documentId) as { n: number };
    return r.n;
  }
  const r = db.prepare('SELECT COUNT(*) as n FROM entity_mentions').get() as { n: number };
  return r.n;
}

function entitiesByCanonical(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT entity_id, canonical_form FROM entities').all() as Array<{ entity_id: string; canonical_form: string }>;
  const out: Record<string, string> = {};
  for (const r of rows) out[r.canonical_form] = r.entity_id;
  return out;
}

describe('R5 — feature flag default off', () => {
  it('default config (no entityIndexing block) — ingestDocumentEntities returns null', () => {
    const agent = buildAgent({ omit: true });
    const result = agent.ingestDocumentEntities('doc-1', 'Robert Moyes attended the meeting.');
    expect(result).toBeNull();
    expect(agent.isEntityIndexingEnabled()).toBe(false);
    agent.shutdown?.();
  });

  it('explicit entityIndexing.enabled=false — no entities or mentions written', () => {
    const agent = buildAgent({ entityIndexing: { enabled: false } });
    runCognitiveMemoryMigrations(getDb(agent));
    const docId = seedDocument(getDb(agent), 'note.pdf', 'h1');
    const result = agent.ingestDocumentEntities(docId, 'Robert Moyes was here.');
    expect(result).toBeNull();
    expect(countEntities(getDb(agent))).toBe(0);
    expect(countMentions(getDb(agent))).toBe(0);
    agent.shutdown?.();
  });
});

describe('R5 — entity + mention creation', () => {
  it('flag on — "Robert Moyes attended" creates an entity and a mention', () => {
    const agent = buildAgent({ entityIndexing: { enabled: true } });
    const docId = seedDocument(getDb(agent), 'note.pdf', 'h1');
    const result = agent.ingestDocumentEntities(docId, 'Robert Moyes attended the meeting on 2024-01-15.');
    expect(result).not.toBeNull();
    expect(result!.mentionsCreated).toBeGreaterThanOrEqual(1);

    // Robert Moyes should be present in entities table
    const ents = entitiesByCanonical(getDb(agent));
    expect(ents['Robert Moyes']).toBeDefined();
    // A mention row tied to docId should exist
    expect(countMentions(getDb(agent), docId)).toBe(result!.mentionsCreated);
    agent.shutdown?.();
  });

  it('repeated occurrences of the same name produce ONE entity, ONE mention per document', () => {
    const agent = buildAgent({ entityIndexing: { enabled: true } });
    const docId = seedDocument(getDb(agent), 'note.pdf', 'h2');
    const text = 'Robert Moyes spoke first. Then Robert Moyes addressed the panel. Robert Moyes concluded.';
    agent.ingestDocumentEntities(docId, text);
    const ents = entitiesByCanonical(getDb(agent));
    // Exactly one Robert Moyes entity
    expect(Object.keys(ents).filter(k => k === 'Robert Moyes').length).toBe(1);
    // The mention count for this canonical+doc pair is 1 (extractor de-dupes)
    const robertId = ents['Robert Moyes'];
    const mentionsForDoc = getDb(agent).prepare(
      'SELECT COUNT(*) as n FROM entity_mentions WHERE entity_id = ? AND document_id = ?'
    ).get(robertId, docId) as { n: number };
    expect(mentionsForDoc.n).toBe(1);
    agent.shutdown?.();
  });

  it('cross-document dedupe — same canonical entity reused across two documents', () => {
    const agent = buildAgent({ entityIndexing: { enabled: true } });
    const docA = seedDocument(getDb(agent), 'a.pdf', 'ha');
    const docB = seedDocument(getDb(agent), 'b.pdf', 'hb');
    agent.ingestDocumentEntities(docA, 'Robert Moyes attended the meeting.');
    agent.ingestDocumentEntities(docB, 'Robert Moyes signed the contract.');
    expect(countEntities(getDb(agent))).toBe(1); // single entity row
    expect(countMentions(getDb(agent))).toBe(2); // one mention per doc
    agent.shutdown?.();
  });
});

describe('R5 — re-ingest removes stale mentions', () => {
  it('re-ingesting the same document removes prior mentions before writing fresh ones', () => {
    const agent = buildAgent({ entityIndexing: { enabled: true } });
    const docId = seedDocument(getDb(agent), 'note.pdf', 'h1');

    // First ingestion — Robert Moyes + Jane Doe
    const r1 = agent.ingestDocumentEntities(docId, 'Robert Moyes met with Jane Doe.');
    expect(r1!.staleMentionsRemoved).toBe(0);
    expect(countMentions(getDb(agent), docId)).toBe(r1!.mentionsCreated);
    expect(r1!.mentionsCreated).toBe(2);

    // Re-ingest with different text — only Anna Bell
    const r2 = agent.ingestDocumentEntities(docId, 'Anna Bell prepared the report.');
    expect(r2!.staleMentionsRemoved).toBe(2); // both prior mentions removed
    expect(countMentions(getDb(agent), docId)).toBe(r2!.mentionsCreated);
    expect(r2!.mentionsCreated).toBe(1);

    // The orphaned-from-doc mentions are gone — Robert Moyes + Jane Doe entities
    // may still exist (they're cross-document records) but no mentions in this doc.
    const robertMentions = getDb(agent).prepare(
      'SELECT COUNT(*) as n FROM entity_mentions m JOIN entities e ON m.entity_id = e.entity_id WHERE e.canonical_form = ? AND m.document_id = ?'
    ).get('Robert Moyes', docId) as { n: number };
    expect(robertMentions.n).toBe(0);
    agent.shutdown?.();
  });

  it('empty text on re-ingest only clears stale mentions and writes nothing new', () => {
    const agent = buildAgent({ entityIndexing: { enabled: true } });
    const docId = seedDocument(getDb(agent), 'note.pdf', 'h1');
    agent.ingestDocumentEntities(docId, 'Robert Moyes spoke.');
    expect(countMentions(getDb(agent), docId)).toBeGreaterThan(0);
    const r = agent.ingestDocumentEntities(docId, '');
    expect(r!.mentionsCreated).toBe(0);
    expect(r!.staleMentionsRemoved).toBeGreaterThan(0);
    expect(countMentions(getDb(agent), docId)).toBe(0);
    agent.shutdown?.();
  });

  it('removeDocumentMentions via service path clears all mentions for a document', () => {
    const agent = buildAgent({ entityIndexing: { enabled: true } });
    const docId = seedDocument(getDb(agent), 'note.pdf', 'h1');
    agent.ingestDocumentEntities(docId, 'Robert Moyes and Jane Doe met.');
    expect(countMentions(getDb(agent), docId)).toBe(2);
    // Re-ingest with empty text triggers the same removal pathway
    agent.ingestDocumentEntities(docId, '');
    expect(countMentions(getDb(agent), docId)).toBe(0);
    agent.shutdown?.();
  });
});

describe('R5 — end-to-end retrieval after ingestion', () => {
  it('after entity ingestion, retrieval EXACT_SEARCH for "robert moyes" hits entity index (source=entity)', async () => {
    // Both flags on so ingestion writes entities AND retrieval consumes them.
    const agent = buildAgent({ retrieval: { enabled: true }, entityIndexing: { enabled: true } });
    const docA = seedDocument(getDb(agent), 'a.pdf', 'ha');
    const docB = seedDocument(getDb(agent), 'b.pdf', 'hb');
    agent.ingestDocumentEntities(docA, 'Robert Moyes attended the all-hands meeting.');
    agent.ingestDocumentEntities(docB, 'Robert Moyes signed the indemnity agreement.');

    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata();
    expect(meta).not.toBeNull();
    expect(meta!.retrievalIntent).toBe('EXACT_SEARCH');
    expect(meta!.retrievalSource).toBe('entity');
    expect(meta!.retrievalMatchCount).toBe(2);
    const docIds = meta!.retrievalDocuments.map(d => d.document_id).sort();
    expect(docIds).toEqual([docA, docB].sort());
    await agent.shutdown?.();
  });

  it('end-to-end: ingest "Robert Moyes" once, query — entity path returns the document', async () => {
    const agent = buildAgent({ retrieval: { enabled: true }, entityIndexing: { enabled: true } });
    const docId = seedDocument(getDb(agent), 'memo.pdf', 'hm');
    agent.ingestDocumentEntities(docId, 'A meeting was held with Robert Moyes.');
    stubProvider(agent);
    await agent.chat('which documents mention robert moyes');
    const meta = agent.getLastRetrievalMetadata();
    expect(meta!.retrievalSource).toBe('entity');
    expect(meta!.retrievalDocuments[0].document_id).toBe(docId);
    await agent.shutdown?.();
  });
});

describe('R5 — exposed surface', () => {
  it('Agent.isEntityIndexingEnabled reflects the flag', () => {
    const off = buildAgent({ entityIndexing: { enabled: false } });
    expect(off.isEntityIndexingEnabled()).toBe(false);
    off.shutdown?.();
    const on = buildAgent({ entityIndexing: { enabled: true } });
    expect(on.isEntityIndexingEnabled()).toBe(true);
    on.shutdown?.();
  });
});
