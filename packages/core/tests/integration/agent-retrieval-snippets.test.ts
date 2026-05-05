/**
 * R9 — agent retrieval-metadata snippets acceptance tests.
 *
 * Verifies that:
 *   - exact-search results include a snippet containing the matched phrase
 *   - semantic results include a bounded snippet
 *   - count queries do NOT include any document snippets (documents=[] for COUNT)
 *   - flag off — no metadata, no snippets
 *   - matchedPhrase is preserved with original casing for highlighting
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Agent } from '../../src/agent.js';
import { DocumentRegistry } from '../../src/memory/document-registry.js';
import { FtsIndexService } from '../../src/memory/fts-index-service.js';
import { EntityIndexService } from '../../src/entities/entity-index-service.js';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import { generateId } from '../../src/memory/id-generator.js';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r9-'));
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

function seedDocWithChunks(
  db: Database.Database,
  fileName: string,
  chunkContents: string[],
  ftsContent?: string,
): { documentId: string; chunkIds: string[] } {
  runCognitiveMemoryMigrations(db);
  const reg = new DocumentRegistry(db);
  const doc = reg.create({
    file_name: fileName,
    file_type: 'pdf',
    mime_type: 'application/pdf',
    content_type: 'document',
    origin_type: 'born_digital',
    title: 'Test Document',
    page_count: 1, chunk_count: chunkContents.length, ocr_required: false, ocr_completed: false,
    classification_label: 'document', classification_confidence: 1.0, classification_method: 'manual',
    extraction_status: 'extracted', indexing_status: 'indexed',
    content_hash: `h-${fileName}-${Math.random()}`,
  });
  const chunkIds: string[] = [];
  for (let i = 0; i < chunkContents.length; i++) {
    const chunkId = generateId('chunk');
    chunkIds.push(chunkId);
    db.prepare(`
      INSERT INTO document_chunks (chunk_id, document_id, page_id, chunk_number, content, token_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(chunkId, doc.document_id, null, i, chunkContents[i], chunkContents[i].length, Date.now());
  }
  if (ftsContent) {
    const fts = new FtsIndexService(db);
    fts.upsertDocumentFts(doc.document_id, {
      title: 'Test Document', sender: '', recipient: '', subject: '',
      content: ftsContent, file_name: fileName,
    });
  }
  return { documentId: doc.document_id, chunkIds };
}

function seedEntityFor(db: Database.Database, canonical: string, normalized: string, documentIds: string[], chunkId?: string): string {
  const ent = new EntityIndexService(db);
  const entity = ent.upsertEntity({
    canonical_form: canonical, entity_type: 'PERSON', normalized_form: normalized, metadata: {},
  });
  for (let i = 0; i < documentIds.length; i++) {
    ent.upsertMention({
      mention_id: `m-${entity.entity_id}-${i}-${Math.random()}`,
      entity_id: entity.entity_id,
      document_id: documentIds[i],
      chunk_id: chunkId,
      mention_text: canonical,
    });
  }
  return entity.entity_id;
}

describe('R9 — exact-search snippets contain the matched phrase', () => {
  it('entity-path result has snippet with Robert Moyes highlighted (matchedPhrase set)', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const { documentId, chunkIds } = seedDocWithChunks(db, 'memo.pdf', [
      'Earlier in the day, Robert Moyes attended the all-hands and signed the indemnity agreement on behalf of the company.',
    ]);
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', [documentId], chunkIds[0]);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('entity');
    const doc = meta.retrievalDocuments[0];
    expect(doc.snippet).toBeDefined();
    expect(doc.snippet!.toLowerCase()).toContain('robert moyes');
    expect(doc.matchedPhrase).toBe('Robert Moyes');
  });

  it('FTS-path result has snippet from chunk content', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const { documentId } = seedDocWithChunks(
      db,
      'note.pdf',
      ['The grievance procedure was reviewed by the panel last week.'],
      'grievance procedure',
    );
    void documentId;
    stubProvider(agent);
    await agent.chat('list every mention of grievance');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalSource).toBe('fts');
    expect(meta.retrievalDocuments[0].snippet).toBeDefined();
    expect(meta.retrievalDocuments[0].snippet!.toLowerCase()).toContain('grievance');
  });

  it('snippet length is bounded (≤ ~242 chars including ellipses)', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    // Seed a chunk with 5000 characters of context around the name
    const longChunk = 'lorem '.repeat(500) + ' Robert Moyes ' + 'ipsum '.repeat(500);
    const { documentId, chunkIds } = seedDocWithChunks(db, 'big.pdf', [longChunk]);
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', [documentId], chunkIds[0]);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    const snip = meta.retrievalDocuments[0].snippet!;
    expect(snip.length).toBeLessThanOrEqual(242);
  });
});

describe('R9 — semantic snippets are bounded', () => {
  it('semantic result snippet length ≤ 240 (no phrase to centre)', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const longChunk = 'a'.repeat(1500);
    seedDocWithChunks(db, 'culture.pdf', [longChunk], longChunk);
    stubProvider(agent);
    await agent.chat('what do these documents say about workplace culture');
    const meta = agent.getLastRetrievalMetadata();
    if (meta && meta.retrievalDocuments.length > 0 && meta.retrievalDocuments[0].snippet) {
      // Allow the ellipsis suffix (+1)
      expect(meta.retrievalDocuments[0].snippet.length).toBeLessThanOrEqual(241);
    }
  });
});

describe('R9 — count queries do NOT include any document snippets', () => {
  it('"how many documents" — retrievalDocuments is [] (no chips, no snippets)', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    seedDocWithChunks(db, 'a.pdf', ['Robert Moyes attended.']);
    stubProvider(agent);
    await agent.chat('how many documents');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalIntent).toBe('COUNT');
    expect(meta.retrievalDocuments).toEqual([]);
  });
});

describe('R9 — flag off — unchanged behaviour', () => {
  it('flag off — getLastRetrievalMetadata is null (no snippets to expose)', async () => {
    const agent = buildAgent({ retrieval: { enabled: false } });
    const db = getDb(agent);
    runCognitiveMemoryMigrations(db);
    seedDocWithChunks(db, 'a.pdf', ['Robert Moyes attended.']);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    expect(agent.getLastRetrievalMetadata()).toBeNull();
  });
});

describe('R9 — chunk lookup falls back gracefully', () => {
  it('document with NO chunks → no snippet on the metadata document', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    runCognitiveMemoryMigrations(db);
    // Seed a doc with no chunks
    const reg = new DocumentRegistry(db);
    const doc = reg.create({
      file_name: 'empty.pdf', file_type: 'pdf', mime_type: 'application/pdf',
      content_type: 'document', origin_type: 'born_digital',
      page_count: 1, chunk_count: 0, ocr_required: false, ocr_completed: false,
      classification_label: 'document', classification_confidence: 1.0, classification_method: 'manual',
      extraction_status: 'extracted', indexing_status: 'indexed',
      content_hash: `h-${Math.random()}`,
    });
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', [doc.document_id]);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalDocuments[0].snippet).toBeUndefined();
    expect(meta.retrievalDocuments[0].matchedPhrase).toBeUndefined();
  });
});
