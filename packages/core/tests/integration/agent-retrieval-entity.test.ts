/**
 * R4 — entity-index exact-name retrieval tests.
 *
 * Verifies:
 *   - exact-name queries route through EntityIndexService FIRST when entity
 *     mentions exist, returning all documents that mention the entity
 *   - when no entity matches the phrase, the path falls back to FTS5 phrase
 *     search and returns the FTS-matched documents
 *   - "show all references to X" still bypasses topK on the entity path
 *   - feature flag off — no entity lookup, no metadata exposure
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent.js';
import { DocumentRegistry } from '../../src/memory/document-registry.js';
import { FtsIndexService } from '../../src/memory/fts-index-service.js';
import { EntityIndexService } from '../../src/entities/entity-index-service.js';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import Database from 'better-sqlite3';
import type { LLMResponse } from '../../src/types.js';

interface AgentOpts { retrieval?: { enabled: boolean }; omit?: boolean; }

function writeConfig(dir: string, opts: AgentOpts = {}): string {
  const block = opts.omit ? '' : `  retrieval:\n    enabled: ${opts.retrieval?.enabled ?? false}\n`;
  const yaml = [
    'agent:',
    '  name: AgentX-Test',
    '  defaultProvider: ollama',
    '  model: llama3',
    block,
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r4-'));
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

/** Seed N documents with optional FTS sender content. */
function seedDocs(db: Database.Database, count: number, opts: { sender?: string; ftsSeed?: boolean } = {}): string[] {
  runCognitiveMemoryMigrations(db);
  const reg = new DocumentRegistry(db);
  const fts = new FtsIndexService(db);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const doc = reg.create({
      file_name: `doc-${i}.pdf`,
      file_type: 'pdf',
      mime_type: 'application/pdf',
      content_type: 'document',
      origin_type: 'born_digital',
      title: `Document ${i}`,
      sender: opts.sender ?? null as unknown as string,
      page_count: 1, chunk_count: 1, ocr_required: false, ocr_completed: false,
      classification_label: 'document', classification_confidence: 1.0, classification_method: 'manual',
      extraction_status: 'extracted', indexing_status: 'indexed',
      content_hash: `hash-${i}-${Math.random()}`,
    });
    ids.push(doc.document_id);
    if (opts.ftsSeed && opts.sender) {
      fts.upsertDocumentFts(doc.document_id, {
        title: `Document ${i}`,
        sender: opts.sender,
        recipient: '',
        subject: '',
        content: `mentions ${opts.sender}`,
        file_name: doc.file_name,
      });
    }
  }
  return ids;
}

/** Seed a person entity with mentions across all provided documents. */
function seedEntity(db: Database.Database, canonical: string, normalized: string, documentIds: string[], type = 'PERSON'): string {
  const ent = new EntityIndexService(db);
  const entity = ent.upsertEntity({
    canonical_form: canonical,
    entity_type: type,
    normalized_form: normalized,
    metadata: {},
  });
  for (let i = 0; i < documentIds.length; i++) {
    ent.upsertMention({
      mention_id: `mention-${entity.entity_id}-${i}`,
      entity_id: entity.entity_id,
      document_id: documentIds[i],
      mention_text: canonical,
    });
  }
  return entity.entity_id;
}

describe('R4 — exact-name queries route through entity index when entities exist', () => {
  it('"show all references to robert moyes" hits entity index, source=entity, all docs returned', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    // Seed 8 documents and link them to a 'Robert Moyes' entity
    const docs = seedDocs(db, 8);
    seedEntity(db, 'Robert Moyes', 'robert moyes', docs);

    stubProvider(agent);
    await agent.chat('show all references to robert moyes');

    const meta = agent.getLastRetrievalMetadata();
    expect(meta).not.toBeNull();
    expect(meta!.retrievalIntent).toBe('EXACT_SEARCH');
    expect(meta!.retrievalSource).toBe('entity');
    expect(meta!.retrievalMatchCount).toBe(8);
    expect(meta!.retrievalDocuments.length).toBe(8);
    await agent.shutdown?.();
  });

  it('every result has score_type=entity_match (not exact_match)', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const docs = seedDocs(db, 3);
    seedEntity(db, 'Jane Doe', 'jane doe', docs);
    stubProvider(agent);
    await agent.chat('which documents mention jane doe');
    const results = agent.getLastRetrievalResults();
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.score_type).toBe('entity_match');
    }
    await agent.shutdown?.();
  });

  it('entity path is preferred even when FTS would also match', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    // Seed both entity AND FTS — entity should win
    const docs = seedDocs(db, 5, { sender: 'robert moyes', ftsSeed: true });
    seedEntity(db, 'Robert Moyes', 'robert moyes', docs);
    // Spy on FTS phraseSearch — should NOT be called because entity hit first
    const phraseSpy = vi.spyOn(FtsIndexService.prototype, 'phraseSearch');
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    expect(phraseSpy).not.toHaveBeenCalled();
    expect(agent.getLastRetrievalMetadata()!.retrievalSource).toBe('entity');
    phraseSpy.mockRestore();
    await agent.shutdown?.();
  });
});

describe('R4 — fall back to FTS when entity index has no match', () => {
  it('phrase with no entity match falls through to FTS, source=fts', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    // FTS seeded but NO entity for "grievance procedure"
    const reg = new DocumentRegistry(db);
    const fts = new FtsIndexService(db);
    runCognitiveMemoryMigrations(db);
    for (let i = 0; i < 4; i++) {
      const doc = reg.create({
        file_name: `policy-${i}.pdf`, file_type: 'pdf', mime_type: 'application/pdf',
        content_type: 'document', origin_type: 'born_digital', title: `Policy ${i}`,
        page_count: 1, chunk_count: 1, ocr_required: false, ocr_completed: false,
        classification_label: 'policy', classification_confidence: 1.0, classification_method: 'manual',
        extraction_status: 'extracted', indexing_status: 'indexed',
        content_hash: `pol-${i}-${Math.random()}`,
      });
      fts.upsertDocumentFts(doc.document_id, {
        title: `Policy ${i}`, sender: '', recipient: '', subject: '',
        content: `the grievance procedure applies here`,
        file_name: doc.file_name,
      });
    }
    stubProvider(agent);
    await agent.chat('list every mention of grievance');
    const meta = agent.getLastRetrievalMetadata();
    expect(meta!.retrievalSource).toBe('fts');
    expect(meta!.retrievalMatchCount).toBe(4);
    await agent.shutdown?.();
  });

  it('entity miss + FTS miss => source=fts with 0 results', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    runCognitiveMemoryMigrations(getDb(agent));
    stubProvider(agent);
    await agent.chat('show all references to nonexistent entity');
    const meta = agent.getLastRetrievalMetadata();
    expect(meta!.retrievalSource).toBe('fts');
    expect(meta!.retrievalMatchCount).toBe(0);
    expect(meta!.retrievalDocuments).toEqual([]);
    await agent.shutdown?.();
  });
});

describe('R4 — all-mode bypasses topK on entity path', () => {
  it('"show all references" with 25 entity-linked docs returns all 25 (not 10)', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const docs = seedDocs(db, 25);
    seedEntity(db, 'Robert Moyes', 'robert moyes', docs);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata();
    expect(meta!.retrievalSource).toBe('entity');
    expect(meta!.retrievalMatchCount).toBe(25);
    expect(meta!.retrievalDocuments.length).toBe(25);
    await agent.shutdown?.();
  });

  it('exact search WITHOUT "all" still respects topK on entity path', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const docs = seedDocs(db, 25);
    seedEntity(db, 'Jane Doe', 'jane doe', docs);
    stubProvider(agent);
    await agent.chat('which documents mention jane doe');
    // Default topK=10 in retrieve(); entity path should also respect it.
    const meta = agent.getLastRetrievalMetadata();
    expect(meta!.retrievalSource).toBe('entity');
    expect(meta!.retrievalMatchCount).toBeLessThanOrEqual(10);
    await agent.shutdown?.();
  });
});

describe('R4 — feature flag off preserves existing behaviour', () => {
  it('flag off — entity index is never consulted, no metadata exposed', async () => {
    const agent = buildAgent({ retrieval: { enabled: false } });
    runCognitiveMemoryMigrations(getDb(agent));
    seedEntity(getDb(agent), 'Robert Moyes', 'robert moyes', []);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    expect(agent.getLastRetrievalMetadata()).toBeNull();
    expect(agent.getLastRetrievalIntent()).toBeNull();
    await agent.shutdown?.();
  });

  it('default config (no retrieval block) — same as flag off', async () => {
    const agent = buildAgent({ omit: true });
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    expect(agent.getLastRetrievalMetadata()).toBeNull();
    await agent.shutdown?.();
  });
});

describe('R4 — RetrievalService.source is exposed on RetrievalResponse', () => {
  it('directly via RetrievalService — entity match sets source=entity', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const docs = seedDocs(db, 3);
    seedEntity(db, 'Robert Moyes', 'robert moyes', docs);
    // Reach into the RetrievalService directly to assert the response shape.
    const svc = (agent as unknown as { _retrievalService: { retrieve(q: string): Promise<{ source: string; intent: string; results: unknown[] }> } })._retrievalService;
    const r = await svc.retrieve('show all references to robert moyes');
    expect(r.intent).toBe('EXACT_SEARCH');
    expect(r.source).toBe('entity');
    await agent.shutdown?.();
  });

  it('directly via RetrievalService — count sets source=sql', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocs(getDb(agent), 5);
    const svc = (agent as unknown as { _retrievalService: { retrieve(q: string): Promise<{ source: string }> } })._retrievalService;
    const r = await svc.retrieve('how many documents');
    expect(r.source).toBe('sql');
    await agent.shutdown?.();
  });

  it('directly via RetrievalService — semantic sets source=vector', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocs(getDb(agent), 1);
    const svc = (agent as unknown as { _retrievalService: { retrieve(q: string): Promise<{ source: string }> } })._retrievalService;
    const r = await svc.retrieve('what do these documents say about culture');
    expect(r.source).toBe('vector');
    await agent.shutdown?.();
  });
});
