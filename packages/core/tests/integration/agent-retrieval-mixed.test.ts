/**
 * R6 — mixed exact retrieval (entity + FTS supplement) acceptance tests.
 *
 * Verifies:
 *   - entity-only result → source='entity'
 *   - FTS-only fallback (no entity) → source='fts'
 *   - entity + FTS both contribute distinct docs → source='mixed'
 *   - duplicate document across entity+FTS appears once
 *   - "show all references" still returns every match across both sources
 *   - feature flag off — unchanged
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r6-'));
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

/** Seed N documents and return their ids. Optionally seed FTS sender content. */
function seedDocs(db: Database.Database, count: number, opts: { fileNamePrefix?: string; sender?: string; ftsSeed?: boolean } = {}): string[] {
  runCognitiveMemoryMigrations(db);
  const reg = new DocumentRegistry(db);
  const fts = new FtsIndexService(db);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const fileName = `${opts.fileNamePrefix ?? 'doc'}-${i}.pdf`;
    const doc = reg.create({
      file_name: fileName,
      file_type: 'pdf',
      mime_type: 'application/pdf',
      content_type: 'document',
      origin_type: 'born_digital',
      title: `Document ${i}`,
      sender: opts.sender ?? null as unknown as string,
      page_count: 1, chunk_count: 1, ocr_required: false, ocr_completed: false,
      classification_label: 'document', classification_confidence: 1.0, classification_method: 'manual',
      extraction_status: 'extracted', indexing_status: 'indexed',
      content_hash: `h-${fileName}-${Math.random()}`,
    });
    ids.push(doc.document_id);
    if (opts.ftsSeed && opts.sender) {
      fts.upsertDocumentFts(doc.document_id, {
        title: `Document ${i}`,
        sender: opts.sender, recipient: '', subject: '',
        content: `mentions ${opts.sender}`,
        file_name: doc.file_name,
      });
    }
  }
  return ids;
}

function seedEntityFor(db: Database.Database, canonical: string, normalized: string, documentIds: string[], type = 'PERSON'): string {
  const ent = new EntityIndexService(db);
  const entity = ent.upsertEntity({
    canonical_form: canonical, entity_type: type, normalized_form: normalized, metadata: {},
  });
  for (let i = 0; i < documentIds.length; i++) {
    ent.upsertMention({
      mention_id: `m-${entity.entity_id}-${i}-${Math.random()}`,
      entity_id: entity.entity_id,
      document_id: documentIds[i],
      mention_text: canonical,
    });
  }
  return entity.entity_id;
}

describe('R6 — entity-only result has source=entity', () => {
  it('entity matches all docs FTS would match — no new docs from FTS → source=entity', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const docs = seedDocs(db, 4, { sender: 'robert moyes', ftsSeed: true });
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', docs);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('entity');
    expect(meta.retrievalMatchCount).toBe(4);
    await agent.shutdown?.();
  });

  it('entity-only with no FTS data → source=entity', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const docs = seedDocs(db, 3); // no FTS seed
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', docs);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('entity');
    expect(meta.retrievalMatchCount).toBe(3);
    await agent.shutdown?.();
  });
});

describe('R6 — FTS-only fallback has source=fts', () => {
  it('no entity rows but FTS finds matches → source=fts', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    seedDocs(db, 4, { sender: 'robert moyes', ftsSeed: true });
    // No seedEntityFor — entity index is empty.
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('fts');
    expect(meta.retrievalMatchCount).toBe(4);
    await agent.shutdown?.();
  });

  it('entity miss + FTS miss → source=fts, 0 results', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    runCognitiveMemoryMigrations(getDb(agent));
    stubProvider(agent);
    await agent.chat('show all references to nobody');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('fts');
    expect(meta.retrievalMatchCount).toBe(0);
    await agent.shutdown?.();
  });
});

describe('R6 — entity + FTS both contribute → source=mixed', () => {
  it('entity finds 2 docs; FTS finds 3 different docs; → source=mixed, 5 unique docs', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    // Group A: 2 docs with entity mentions (no FTS content)
    const entityDocs = seedDocs(db, 2, { fileNamePrefix: 'entity' });
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', entityDocs);
    // Group B: 3 docs with FTS content (no entity registration)
    const ftsDocs = seedDocs(db, 3, { fileNamePrefix: 'fts', sender: 'robert moyes', ftsSeed: true });
    void ftsDocs;
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('mixed');
    expect(meta.retrievalMatchCount).toBe(5);
    // All 5 unique document_ids should appear
    const got = new Set(meta.retrievalDocuments.map(d => d.document_id));
    expect(got.size).toBe(5);
    await agent.shutdown?.();
  });

  it('entity returns < default topK; FTS supplement adds new docs → source=mixed', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    // 2 entity docs + 4 FTS-only docs; default topK=10
    const e = seedDocs(db, 2, { fileNamePrefix: 'e' });
    seedEntityFor(db, 'Jane Doe', 'jane doe', e);
    const f = seedDocs(db, 4, { fileNamePrefix: 'f', sender: 'jane doe', ftsSeed: true });
    void f;
    stubProvider(agent);
    await agent.chat('which documents mention jane doe');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('mixed');
    expect(meta.retrievalMatchCount).toBe(6);
    await agent.shutdown?.();
  });
});

describe('R6 — duplicate documents across entity+FTS appear once', () => {
  it('docs in BOTH entity and FTS are not double-counted', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    // Same docs registered in BOTH entity and FTS — should still produce 4 unique docs
    const docs = seedDocs(db, 4, { sender: 'robert moyes', ftsSeed: true });
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', docs);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalMatchCount).toBe(4);
    expect(new Set(meta.retrievalDocuments.map(d => d.document_id)).size).toBe(4);
    // Source: 'entity' because FTS contributed no new docs
    expect(meta.retrievalSource).toBe('entity');
    await agent.shutdown?.();
  });

  it('entity finds A,B; FTS finds B,C — final set is A,B,C with B once', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    // Doc A: entity-only
    const entA = seedDocs(db, 1, { fileNamePrefix: 'a' })[0];
    // Doc B: BOTH entity and FTS
    const docB = seedDocs(db, 1, { fileNamePrefix: 'b', sender: 'robert moyes', ftsSeed: true })[0];
    // Doc C: FTS-only
    const docC = seedDocs(db, 1, { fileNamePrefix: 'c', sender: 'robert moyes', ftsSeed: true })[0];

    seedEntityFor(db, 'Robert Moyes', 'robert moyes', [entA, docB]);

    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('mixed');
    expect(meta.retrievalMatchCount).toBe(3);
    const ids = new Set(meta.retrievalDocuments.map(d => d.document_id));
    expect(ids.has(entA)).toBe(true);
    expect(ids.has(docB)).toBe(true);
    expect(ids.has(docC)).toBe(true);
    expect(ids.size).toBe(3);
    await agent.shutdown?.();
  });
});

describe('R6 — "show all references" still returns all across mixed sources', () => {
  it('25 entity docs + 25 FTS-only docs, all-mode lifts cap → all 50 returned, source=mixed', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const ent = seedDocs(db, 25, { fileNamePrefix: 'e' });
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', ent);
    const fts = seedDocs(db, 25, { fileNamePrefix: 'f', sender: 'robert moyes', ftsSeed: true });
    void fts;
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('mixed');
    expect(meta.retrievalMatchCount).toBe(50);
    expect(new Set(meta.retrievalDocuments.map(d => d.document_id)).size).toBe(50);
    await agent.shutdown?.();
  });
});

describe('R6 — feature flag off unchanged', () => {
  it('flag off — no retrieval metadata, no entity or FTS calls', async () => {
    const agent = buildAgent({ retrieval: { enabled: false } });
    const db = getDb(agent);
    runCognitiveMemoryMigrations(db);
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', seedDocs(db, 3));
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    expect(agent.getLastRetrievalMetadata()).toBeNull();
    await agent.shutdown?.();
  });
});

describe('R6 — direct RetrievalService.source labelling', () => {
  it('exposes source on RetrievalResponse for mixed case', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const ent = seedDocs(db, 2, { fileNamePrefix: 'e' });
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', ent);
    seedDocs(db, 3, { fileNamePrefix: 'f', sender: 'robert moyes', ftsSeed: true });
    const svc = (agent as unknown as { _retrievalService: { retrieve(q: string): Promise<{ source: string; results: unknown[] }> } })._retrievalService;
    const r = await svc.retrieve('show all references to robert moyes');
    expect(r.source).toBe('mixed');
    expect(r.results.length).toBe(5);
    await agent.shutdown?.();
  });
});
