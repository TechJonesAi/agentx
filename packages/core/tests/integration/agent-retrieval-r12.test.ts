/**
 * R12 — semantic query normalization integration tests.
 *
 * Verifies that:
 *   - natural-language semantic queries retrieve overlapping content
 *     (the R12 fix to FTS5 stop-word handling)
 *   - COUNT queries are unchanged (parseCountFilters path is untouched)
 *   - EXACT_SEARCH queries are unchanged (handleExactSearch is untouched)
 *   - quoted phrases pass through to FTS5 phrase syntax
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Agent } from '../../src/agent.js';
import { DocumentRegistry } from '../../src/memory/document-registry.js';
import { FtsIndexService } from '../../src/memory/fts-index-service.js';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import { generateId } from '../../src/memory/id-generator.js';
import type { LLMResponse } from '../../src/types.js';

interface AgentOpts { retrieval?: { enabled: boolean }; omit?: boolean; }

function writeConfig(dir: string, opts: AgentOpts = {}): string {
  const block = opts.omit ? '' : opts.retrieval ? `  retrieval:\n    enabled: ${opts.retrieval.enabled}\n` : '';
  const yaml = [
    'agent:', '  name: AgentX-Test', '  defaultProvider: ollama', '  model: llama3', block,
    'providers:', '  ollama:', '    model: llama3', '    baseUrl: http://localhost:11434',
    'memory:', '  maxConversationHistory: 100', '  summarizeAfter: 50', '  embeddingProvider: local',
    'sessions:', '  persistToDisk: false', '  ttlMinutes: 60',
    'skills:', '  directory: ./skills', '  autoReload: false',
    'browser:', '  headless: true', '  timeout: 30000',
    'health:', '  enabled: false', '  port: 9090', '',
  ].join('\n');
  const p = path.join(dir, 'agentx.yaml');
  fs.writeFileSync(p, yaml, 'utf-8');
  return p;
}

let tmpDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r12-'));
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

function stubProvider(agent: Agent): { systemPrompt?: string } {
  const captured: { systemPrompt?: string } = {};
  const stub = {
    isConfigured: () => true,
    async complete(o: { systemPrompt?: string }): Promise<LLMResponse> {
      captured.systemPrompt = o.systemPrompt;
      return { content: 'ok', toolCalls: [] };
    },
    async completeStream(o: { systemPrompt?: string }): Promise<LLMResponse> {
      captured.systemPrompt = o.systemPrompt;
      return { content: 'ok', toolCalls: [] };
    },
  };
  (agent as unknown as { provider: typeof stub }).provider = stub;
  return captured;
}

function getDb(agent: Agent): Database.Database {
  return (agent as unknown as { db: Database.Database }).db;
}

function seedDocWithChunk(db: Database.Database, fileName: string, fileType: string, chunkContent: string): string {
  runCognitiveMemoryMigrations(db);
  const reg = new DocumentRegistry(db);
  const fts = new FtsIndexService(db);
  const doc = reg.create({
    file_name: fileName,
    file_type: fileType,
    mime_type: fileType === 'pdf' ? 'application/pdf' : 'text/plain',
    content_type: 'document', origin_type: 'born_digital',
    title: 'Doc', page_count: 1, chunk_count: 1,
    ocr_required: false, ocr_completed: false,
    classification_label: 'document', classification_confidence: 1.0, classification_method: 'manual',
    extraction_status: 'extracted', indexing_status: 'indexed',
    content_hash: `h-${fileName}-${Math.random()}`,
  });
  const chunkId = generateId('chunk');
  db.prepare(`
    INSERT INTO document_chunks (chunk_id, document_id, page_id, chunk_number, content, token_count, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(chunkId, doc.document_id, null, 0, chunkContent, chunkContent.length, Date.now());
  fts.upsertDocumentFts(doc.document_id, {
    title: 'Doc', sender: '', recipient: '', subject: '',
    content: chunkContent, file_name: fileName,
  });
  return doc.document_id;
}

describe('R12 — natural-language semantic retrieval (the spec failure case)', () => {
  it('"What documents are about HR escalation and payroll issues?" retrieves the matching chunk', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    seedDocWithChunk(db, 'grievance.pdf', 'pdf',
      'Robert Moyes attended the grievance meeting. The grievance related to payroll, absence records, and HR escalation.');
    seedDocWithChunk(db, 'unrelated.pdf', 'pdf',
      'Annual leave requests must be submitted through the HR portal.');
    stubProvider(agent);
    await agent.chat('What documents are about HR escalation and payroll issues?');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalIntent).toBe('SEMANTIC');
    expect(meta.retrievalDocuments.map(d => d.file_name)).toContain('grievance.pdf');
    await agent.shutdown?.();
  });

  it('keyword-only query still works (idempotent on clean input)', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocWithChunk(getDb(agent), 'grievance.pdf', 'pdf', 'HR escalation and payroll details.');
    stubProvider(agent);
    await agent.chat('HR escalation payroll');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalIntent).toBe('SEMANTIC');
    expect(meta.retrievalDocuments.map(d => d.file_name)).toContain('grievance.pdf');
    await agent.shutdown?.();
  });

  it('quoted phrase passes through to FTS5 phrase matching', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    seedDocWithChunk(db, 'a.pdf', 'pdf', 'The case number 12345 was assigned today.');
    seedDocWithChunk(db, 'b.pdf', 'pdf', 'A different case with a different number was opened.');
    stubProvider(agent);
    // After R12 normalization, this reduces to just `"case number 12345"`
    // (a single FTS5 phrase token) — only a.pdf has that exact sequence.
    await agent.chat('what about "case number 12345"');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalDocuments.map(d => d.file_name)).toContain('a.pdf');
    expect(meta.retrievalDocuments.map(d => d.file_name)).not.toContain('b.pdf');
    await agent.shutdown?.();
  });
});

describe('R12 — non-regression: COUNT path is unchanged', () => {
  it('"how many documents" still routes to COUNT/sql with the right number', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    seedDocWithChunk(db, 'a.pdf', 'pdf', 'one');
    seedDocWithChunk(db, 'b.pdf', 'pdf', 'two');
    seedDocWithChunk(db, 'c.txt', 'txt', 'three');
    stubProvider(agent);
    await agent.chat('how many documents');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalIntent).toBe('COUNT');
    expect(meta.retrievalSource).toBe('sql');
    expect(meta.retrievalCount).toBe(3);
    await agent.shutdown?.();
  });

  it('"how many pdfs" still filters by file_type=pdf', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    seedDocWithChunk(db, 'a.pdf', 'pdf', 'one');
    seedDocWithChunk(db, 'b.pdf', 'pdf', 'two');
    seedDocWithChunk(db, 'c.txt', 'txt', 'three');
    stubProvider(agent);
    await agent.chat('how many pdfs');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalIntent).toBe('COUNT');
    expect(meta.retrievalCount).toBe(2);
    await agent.shutdown?.();
  });
});

describe('R12 — non-regression: EXACT_SEARCH path is unchanged', () => {
  it('"show all references to robert moyes" still routes to EXACT_SEARCH', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    seedDocWithChunk(db, 'a.pdf', 'pdf', 'Robert Moyes attended.');
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalIntent).toBe('EXACT_SEARCH');
    // Note: source is 'fts' here because no entity is registered (R6 fallback)
    expect(['fts', 'entity', 'mixed']).toContain(meta.retrievalSource);
    expect(meta.retrievalDocuments.map(d => d.file_name)).toContain('a.pdf');
    await agent.shutdown?.();
  });

  it('"which documents mention grievance" still routes to EXACT_SEARCH', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocWithChunk(getDb(agent), 'a.pdf', 'pdf', 'The grievance procedure.');
    stubProvider(agent);
    await agent.chat('which documents mention grievance');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalIntent).toBe('EXACT_SEARCH');
    await agent.shutdown?.();
  });
});

describe('R12 — fallback when normalization yields empty', () => {
  it('all-stop-words query falls back to the raw query for FTS', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    runCognitiveMemoryMigrations(getDb(agent));
    stubProvider(agent);
    // "what is it about" — all stop words → normalized = ""; falls back to raw
    // Query routes to SEMANTIC (no count/exact patterns), passes raw to FTS,
    // returns 0 docs (none match). Should NOT crash, metadata is set.
    await agent.chat('what is it about');
    const meta = agent.getLastRetrievalMetadata();
    // Either SEMANTIC with 0 results, or no metadata if 0 + non-COUNT;
    // either way, no crash.
    expect(agent.getLastRetrievalError()).toBeNull();
    if (meta) expect(meta.retrievalIntent).toBe('SEMANTIC');
    await agent.shutdown?.();
  });
});
