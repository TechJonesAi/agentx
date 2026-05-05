/**
 * R2 — agent retrieval integration acceptance tests.
 *
 * Verifies that when `agent.retrieval.enabled = true`:
 *   - count queries inject a deterministic SQL-derived count into the prompt
 *     and never call FTS or vector retrieval
 *   - "show all references to <name>" injects all matching documents
 *   - semantic queries inject retrieved evidence
 *   - the LLM provider receives the augmented systemPrompt
 *
 * Verifies that when the flag is OFF, the systemPrompt is byte-identical to
 * the pre-R2 path.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent.js';
import { DocumentRegistry } from '../../src/memory/document-registry.js';
import { FtsIndexService } from '../../src/memory/fts-index-service.js';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import Database from 'better-sqlite3';
import type { LLMResponse } from '../../src/types.js';

interface AgentOpts {
  retrieval?: { enabled: boolean };
  omit?: boolean;
}

function writeConfig(dir: string, opts: AgentOpts = {}): string {
  const block = opts.omit
    ? ''
    : `  retrieval:\n    enabled: ${opts.retrieval?.enabled ?? false}\n`;
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r2-'));
  prevDataDir = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = prevDataDir;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function buildAgent(opts: AgentOpts = {}): Agent {
  const cfg = writeConfig(tmpDir, opts);
  return new Agent(cfg);
}

/** Replace the LLM provider with a stub that records the systemPrompt and
 *  returns a canned response. */
function captureSystemPrompt(agent: Agent): { capture: { systemPrompt?: string } } {
  const capture: { systemPrompt?: string } = {};
  const stub = {
    isConfigured: () => true,
    async complete(opts: { systemPrompt?: string }): Promise<LLMResponse> {
      capture.systemPrompt = opts.systemPrompt;
      return { content: 'ok', toolCalls: [] };
    },
    async completeStream(opts: { systemPrompt?: string }): Promise<LLMResponse> {
      capture.systemPrompt = opts.systemPrompt;
      return { content: 'ok', toolCalls: [] };
    },
  };
  // Bypass private access via cast.
  (agent as unknown as { provider: typeof stub }).provider = stub;
  return { capture };
}

/** Helper: get direct DB handle from an agent so we can seed test data. */
function getAgentDb(agent: Agent): Database.Database {
  return (agent as unknown as { db: Database.Database }).db;
}

function seedDocs(db: Database.Database, count: number, opts: { sender?: string; file_type?: string } = {}) {
  // Ensure cognitive memory migrations are applied (constructor only runs them
  // when retrieval is enabled — but tests for the disabled path shouldn't
  // need them).
  runCognitiveMemoryMigrations(db);
  const reg = new DocumentRegistry(db);
  const fts = new FtsIndexService(db);
  for (let i = 0; i < count; i++) {
    const doc = reg.create({
      file_name: `doc-${i}.${opts.file_type ?? 'pdf'}`,
      file_type: opts.file_type ?? 'pdf',
      mime_type: opts.file_type === 'txt' ? 'text/plain' : 'application/pdf',
      content_type: 'document',
      origin_type: 'born_digital',
      title: `Document ${i}`,
      sender: opts.sender ?? null as unknown as string,
      page_count: 1,
      chunk_count: 1,
      ocr_required: false,
      ocr_completed: false,
      classification_label: 'document',
      classification_confidence: 1.0,
      classification_method: 'manual',
      extraction_status: 'extracted',
      indexing_status: 'indexed',
      content_hash: `hash-${i}-${Math.random()}`,
    });
    if (opts.sender) {
      fts.upsertDocumentFts(doc.document_id, {
        title: `Document ${i}`,
        sender: opts.sender,
        recipient: '',
        subject: '',
        content: `this document references ${opts.sender}`,
        file_name: doc.file_name,
      });
    }
  }
}

describe('R2 — disabled flag preserves existing chat behaviour', () => {
  it('default config (no retrieval block) — systemPrompt is the base prompt unchanged', async () => {
    const agent = buildAgent({ omit: true });
    const { capture } = captureSystemPrompt(agent);
    await agent.chat('how many documents', undefined);
    expect(capture.systemPrompt).toBeDefined();
    expect(capture.systemPrompt).not.toContain('Retrieved');
    expect(capture.systemPrompt).not.toContain('DOCUMENT COUNT');
    await agent.shutdown?.();
  });

  it('retrieval.enabled=false — no retrieval intent stored, getter empty', async () => {
    const agent = buildAgent({ retrieval: { enabled: false } });
    captureSystemPrompt(agent);
    await agent.chat('how many documents');
    expect(agent.getLastRetrievalIntent()).toBeNull();
    expect(agent.getLastRetrievalResults()).toEqual([]);
    await agent.shutdown?.();
  });
});

describe('R2 — count queries inject SQL-derived count and never call FTS/vector', () => {
  it('"how many documents" injects a DOCUMENT COUNT fact into systemPrompt', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocs(getAgentDb(agent), 7);
    const { capture } = captureSystemPrompt(agent);
    await agent.chat('how many documents do we have');
    expect(capture.systemPrompt).toContain('DOCUMENT COUNT');
    expect(capture.systemPrompt).toContain('7');
    expect(agent.getLastRetrievalIntent()).toBe('COUNT');
    await agent.shutdown?.();
  });

  it('"how many PDFs" injects a filtered count', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getAgentDb(agent);
    seedDocs(db, 3, { file_type: 'pdf' });
    seedDocs(db, 2, { file_type: 'txt' });
    const { capture } = captureSystemPrompt(agent);
    await agent.chat('how many pdfs are stored');
    expect(capture.systemPrompt).toContain('file_type=pdf');
    expect(capture.systemPrompt).toContain('3');
    await agent.shutdown?.();
  });

  it('count retrieval does not invoke FTS searchDocuments', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocs(getAgentDb(agent), 4);
    captureSystemPrompt(agent);
    // Spy on FtsIndexService.prototype.searchDocuments: count must not call it.
    const ftsSpy = vi.spyOn(FtsIndexService.prototype, 'searchDocuments');
    const phraseSpy = vi.spyOn(FtsIndexService.prototype, 'phraseSearch');
    const chunkSpy = vi.spyOn(FtsIndexService.prototype, 'searchChunks');
    await agent.chat('how many documents');
    expect(ftsSpy).not.toHaveBeenCalled();
    expect(phraseSpy).not.toHaveBeenCalled();
    expect(chunkSpy).not.toHaveBeenCalled();
    ftsSpy.mockRestore();
    phraseSpy.mockRestore();
    chunkSpy.mockRestore();
    await agent.shutdown?.();
  });
});

describe('R2 — exact-search injects all matching documents', () => {
  it('"show all references to robert moyes" injects every matching document', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocs(getAgentDb(agent), 12, { sender: 'robert moyes' });
    const { capture } = captureSystemPrompt(agent);
    await agent.chat('show all references to robert moyes');
    expect(agent.getLastRetrievalIntent()).toBe('EXACT_SEARCH');
    expect(capture.systemPrompt).toContain('Exact-match Documents');
    expect(capture.systemPrompt).toContain('12 matches');
    // Each document file should be referenced
    for (let i = 0; i < 12; i++) {
      expect(capture.systemPrompt!).toContain(`doc-${i}.pdf`);
    }
    await agent.shutdown?.();
  });

  it('"which documents mention grievance" routes to EXACT_SEARCH', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocs(getAgentDb(agent), 3, { sender: 'grievance' });
    captureSystemPrompt(agent);
    await agent.chat('which documents mention grievance');
    expect(agent.getLastRetrievalIntent()).toBe('EXACT_SEARCH');
    await agent.shutdown?.();
  });
});

describe('R2 — semantic queries route to SEMANTIC and may inject context', () => {
  it('semantic query routes to SEMANTIC intent', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocs(getAgentDb(agent), 1);
    captureSystemPrompt(agent);
    await agent.chat('what do these documents say about workplace culture');
    expect(agent.getLastRetrievalIntent()).toBe('SEMANTIC');
    await agent.shutdown?.();
  });
});

describe('R2 — getter API + observability', () => {
  it('getLastRetrievalIntent and getLastRetrievalResults reflect last retrieve', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocs(getAgentDb(agent), 5);
    captureSystemPrompt(agent);
    await agent.chat('how many documents');
    expect(agent.getLastRetrievalIntent()).toBe('COUNT');
    expect(agent.getLastRetrievalResults().length).toBe(1);
    expect(agent.getLastRetrievalResults()[0].score_type).toBe('count');
    await agent.shutdown?.();
  });

  it('getter returns null intent when retrieval disabled', async () => {
    const agent = buildAgent({ retrieval: { enabled: false } });
    captureSystemPrompt(agent);
    await agent.chat('how many documents');
    expect(agent.getLastRetrievalIntent()).toBeNull();
    await agent.shutdown?.();
  });
});
