/**
 * R3 — retrieval metadata exposure tests.
 *
 * Verifies that:
 *   - getLastRetrievalMetadata() returns structured metadata when retrieval is enabled
 *   - the metadata exposes intent / source / matchCount / documents[] (+ count for COUNT)
 *   - chatStream() invokes onRetrieval BEFORE any token streaming
 *   - when the flag is OFF, getLastRetrievalMetadata() is null and onRetrieval never fires
 *   - core reasoning behaviour is unchanged (systemPrompt injection still works)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent.js';
import { DocumentRegistry } from '../../src/memory/document-registry.js';
import { FtsIndexService } from '../../src/memory/fts-index-service.js';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import Database from 'better-sqlite3';
import type { LLMResponse, RetrievalMetadata } from '../../src/types.js';

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r3-'));
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

function stubProvider(agent: Agent): { tokensRecorded: string[] } {
  const tokensRecorded: string[] = [];
  const stub = {
    isConfigured: () => true,
    async complete(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
    async completeStream(_opts: unknown, callbacks?: { onToken?: (t: string) => void }): Promise<LLMResponse> {
      // Simulate a couple of streamed tokens
      callbacks?.onToken?.('hello');
      tokensRecorded.push('hello');
      callbacks?.onToken?.(' world');
      tokensRecorded.push(' world');
      return { content: 'hello world', toolCalls: [] };
    },
  };
  (agent as unknown as { provider: typeof stub }).provider = stub;
  return { tokensRecorded };
}

function getDb(agent: Agent): Database.Database {
  return (agent as unknown as { db: Database.Database }).db;
}

function seed(db: Database.Database, count: number, opts: { sender?: string; file_type?: string } = {}) {
  runCognitiveMemoryMigrations(db);
  const reg = new DocumentRegistry(db);
  const fts = new FtsIndexService(db);
  for (let i = 0; i < count; i++) {
    const doc = reg.create({
      file_name: `doc-${i}.${opts.file_type ?? 'pdf'}`,
      file_type: opts.file_type ?? 'pdf',
      mime_type: opts.file_type === 'txt' ? 'text/plain' : 'application/pdf',
      content_type: 'document', origin_type: 'born_digital',
      title: `Document ${i}`,
      sender: opts.sender ?? null as unknown as string,
      page_count: 1, chunk_count: 1, ocr_required: false, ocr_completed: false,
      classification_label: 'document', classification_confidence: 1.0, classification_method: 'manual',
      extraction_status: 'extracted', indexing_status: 'indexed',
      content_hash: `h${i}-${Math.random()}`,
    });
    if (opts.sender) {
      fts.upsertDocumentFts(doc.document_id, {
        title: `Document ${i}`, sender: opts.sender, recipient: '', subject: '',
        content: `references ${opts.sender}`, file_name: doc.file_name,
      });
    }
  }
}

describe('R3 — retrieval metadata exposure (flag on)', () => {
  it('getLastRetrievalMetadata returns full structured metadata for COUNT', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seed(getDb(agent), 5);
    stubProvider(agent);
    await agent.chat('how many documents');
    const meta = agent.getLastRetrievalMetadata();
    expect(meta).not.toBeNull();
    expect(meta!.retrievalIntent).toBe('COUNT');
    expect(meta!.retrievalSource).toBe('sql');
    expect(meta!.retrievalMatchCount).toBe(5);
    expect(meta!.retrievalCount).toBe(5);
    expect(meta!.retrievalDocuments).toEqual([]);
    await agent.shutdown?.();
  });

  it('COUNT metadata for "how many PDFs" reflects the filtered count and uses sql source', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    seed(db, 3, { file_type: 'pdf' });
    seed(db, 2, { file_type: 'txt' });
    stubProvider(agent);
    await agent.chat('how many pdfs');
    const meta = agent.getLastRetrievalMetadata();
    expect(meta!.retrievalSource).toBe('sql');
    expect(meta!.retrievalCount).toBe(3);
    expect(meta!.retrievalMatchCount).toBe(3);
    await agent.shutdown?.();
  });

  it('EXACT_SEARCH metadata exposes ALL matching documents with id/title/file metadata', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seed(getDb(agent), 12, { sender: 'robert moyes' });
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata();
    expect(meta!.retrievalIntent).toBe('EXACT_SEARCH');
    expect(meta!.retrievalSource).toBe('fts');
    expect(meta!.retrievalMatchCount).toBe(12);
    expect(meta!.retrievalDocuments.length).toBe(12);
    // Verify shape of each document entry
    for (const d of meta!.retrievalDocuments) {
      expect(d).toHaveProperty('document_id');
      expect(d).toHaveProperty('file_name');
      expect(d.file_name).toMatch(/^doc-\d+\.pdf$/);
      expect(d.title).toMatch(/^Document \d+$/);
      expect(d.file_type).toBe('pdf');
      expect(d.sender).toBe('robert moyes');
    }
    await agent.shutdown?.();
  });

  it('SEMANTIC intent metadata uses vector source label', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seed(getDb(agent), 1);
    stubProvider(agent);
    await agent.chat('what do these documents say about workplace culture');
    const meta = agent.getLastRetrievalMetadata();
    expect(meta!.retrievalIntent).toBe('SEMANTIC');
    expect(meta!.retrievalSource).toBe('vector');
    await agent.shutdown?.();
  });

  it('prompt injection still works alongside metadata exposure (R2 behaviour preserved)', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seed(getDb(agent), 4);
    let capturedPrompt = '';
    const stub = {
      isConfigured: () => true,
      async complete(opts: { systemPrompt?: string }): Promise<LLMResponse> {
        capturedPrompt = opts.systemPrompt ?? '';
        return { content: 'ok', toolCalls: [] };
      },
      async completeStream(opts: { systemPrompt?: string }): Promise<LLMResponse> {
        capturedPrompt = opts.systemPrompt ?? '';
        return { content: 'ok', toolCalls: [] };
      },
    };
    (agent as unknown as { provider: typeof stub }).provider = stub;
    await agent.chat('how many documents');
    expect(capturedPrompt).toContain('DOCUMENT COUNT');
    expect(agent.getLastRetrievalMetadata()).not.toBeNull();
    await agent.shutdown?.();
  });
});

describe('R3 — flag off exposes nothing', () => {
  it('default config — getLastRetrievalMetadata is null', async () => {
    const agent = buildAgent({ omit: true });
    stubProvider(agent);
    await agent.chat('how many documents');
    expect(agent.getLastRetrievalMetadata()).toBeNull();
    await agent.shutdown?.();
  });

  it('explicit retrieval.enabled=false — getLastRetrievalMetadata is null', async () => {
    const agent = buildAgent({ retrieval: { enabled: false } });
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    expect(agent.getLastRetrievalMetadata()).toBeNull();
    await agent.shutdown?.();
  });
});

describe('R3 — chatStream emits onRetrieval before first token', () => {
  it('onRetrieval fires once, before any onToken, with full metadata', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seed(getDb(agent), 6);
    const events: Array<{ type: string; payload?: unknown }> = [];
    const stub = {
      isConfigured: () => true,
      async complete(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
      async completeStream(_opts: unknown, cbs?: { onToken?: (t: string) => void }): Promise<LLMResponse> {
        cbs?.onToken?.('a');
        events.push({ type: 'token-from-stub' });
        return { content: 'a', toolCalls: [] };
      },
    };
    (agent as unknown as { provider: typeof stub }).provider = stub;

    await agent.chatStream('how many documents', {
      onRetrieval: (metadata: RetrievalMetadata) => events.push({ type: 'retrieval', payload: metadata }),
      onToken: () => events.push({ type: 'onToken-callback' }),
      onComplete: () => events.push({ type: 'onComplete-callback' }),
    });

    // First event MUST be onRetrieval
    expect(events[0].type).toBe('retrieval');
    const retrievalEvent = events[0].payload as RetrievalMetadata;
    expect(retrievalEvent.retrievalIntent).toBe('COUNT');
    expect(retrievalEvent.retrievalCount).toBe(6);

    // No onToken before retrieval
    const tokenIdx = events.findIndex(e => e.type === 'onToken-callback');
    if (tokenIdx >= 0) {
      expect(tokenIdx).toBeGreaterThan(0);
    }
    await agent.shutdown?.();
  });

  it('onRetrieval does NOT fire when flag is off', async () => {
    const agent = buildAgent({ retrieval: { enabled: false } });
    let retrievalFired = 0;
    const stub = {
      isConfigured: () => true,
      async complete(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
      async completeStream(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
    };
    (agent as unknown as { provider: typeof stub }).provider = stub;
    await agent.chatStream('how many documents', {
      onRetrieval: () => { retrievalFired++; },
    });
    expect(retrievalFired).toBe(0);
    await agent.shutdown?.();
  });

  it('onRetrieval emits with empty documents[] when retrieval runs but matches nothing', async () => {
    // No seeded documents — retrieval runs and returns 0 docs, but the event
    // still fires so the UI can render an honest "0 matches" status.
    const agent = buildAgent({ retrieval: { enabled: true } });
    runCognitiveMemoryMigrations(getDb(agent));
    const fired: RetrievalMetadata[] = [];
    const stub = {
      isConfigured: () => true,
      async complete(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
      async completeStream(): Promise<LLMResponse> { return { content: 'ok', toolCalls: [] }; },
    };
    (agent as unknown as { provider: typeof stub }).provider = stub;
    await agent.chatStream('what do these documents say about culture', {
      onRetrieval: (m) => fired.push(m),
    });
    expect(fired.length).toBe(1);
    expect(fired[0].retrievalIntent).toBe('SEMANTIC');
    expect(fired[0].retrievalMatchCount).toBe(0);
    expect(fired[0].retrievalDocuments).toEqual([]);
    await agent.shutdown?.();
  });
});

describe('R3 — metadata shape is JSON-serialisable', () => {
  it('full metadata round-trips through JSON.stringify / parse', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seed(getDb(agent), 3, { sender: 'jane doe' });
    stubProvider(agent);
    await agent.chat('show all references to jane doe');
    const meta = agent.getLastRetrievalMetadata()!;
    const json = JSON.stringify(meta);
    const parsed = JSON.parse(json) as RetrievalMetadata;
    expect(parsed.retrievalIntent).toBe(meta.retrievalIntent);
    expect(parsed.retrievalDocuments.length).toBe(meta.retrievalDocuments.length);
    expect(parsed.retrievalDocuments[0].document_id).toBe(meta.retrievalDocuments[0].document_id);
    await agent.shutdown?.();
  });
});
