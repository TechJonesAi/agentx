/**
 * R10 — production-hardening acceptance tests.
 *
 * Verifies:
 *   - retrieval exception inside RetrievalService.retrieve does not crash
 *     chat — chat completes, getLastRetrievalMetadata is null, an error
 *     is recorded on the agent for observability
 *   - timeout fires when retrieve hangs longer than agent.retrieval.timeoutMs
 *   - all-mode metadata is capped at agent.retrieval.maxMetadataDocs while
 *     retrievalMatchCount remains the FULL match count
 *   - flag off — unchanged (no stats, no error, no metadata)
 *   - getLastRetrievalStats returns intent/source/matchCount/elapsedMs after
 *     a successful retrieval
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Agent } from '../../src/agent.js';
import { DocumentRegistry } from '../../src/memory/document-registry.js';
import { EntityIndexService } from '../../src/entities/entity-index-service.js';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import type { LLMResponse } from '../../src/types.js';

interface AgentOpts {
  retrieval?: { enabled: boolean; timeoutMs?: number; maxMetadataDocs?: number };
  omit?: boolean;
}

function writeConfig(dir: string, opts: AgentOpts = {}): string {
  const lines: string[] = [];
  if (!opts.omit && opts.retrieval) {
    lines.push('  retrieval:');
    lines.push(`    enabled: ${opts.retrieval.enabled}`);
    if (opts.retrieval.timeoutMs !== undefined) lines.push(`    timeoutMs: ${opts.retrieval.timeoutMs}`);
    if (opts.retrieval.maxMetadataDocs !== undefined) lines.push(`    maxMetadataDocs: ${opts.retrieval.maxMetadataDocs}`);
  }
  const yaml = [
    'agent:',
    '  name: AgentX-Test',
    '  defaultProvider: ollama',
    '  model: llama3',
    ...lines,
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r10-'));
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

function stubProvider(agent: Agent, captured?: { systemPrompt?: string }): void {
  const stub = {
    isConfigured: () => true,
    async complete(o: { systemPrompt?: string }): Promise<LLMResponse> {
      if (captured) captured.systemPrompt = o.systemPrompt;
      return { content: 'ok', toolCalls: [] };
    },
    async completeStream(o: { systemPrompt?: string }): Promise<LLMResponse> {
      if (captured) captured.systemPrompt = o.systemPrompt;
      return { content: 'ok', toolCalls: [] };
    },
  };
  (agent as unknown as { provider: typeof stub }).provider = stub;
}

function getDb(agent: Agent): Database.Database {
  return (agent as unknown as { db: Database.Database }).db;
}

function seedDocs(db: Database.Database, count: number, fileNamePrefix = 'doc'): string[] {
  runCognitiveMemoryMigrations(db);
  const reg = new DocumentRegistry(db);
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const doc = reg.create({
      file_name: `${fileNamePrefix}-${i}.pdf`,
      file_type: 'pdf', mime_type: 'application/pdf',
      content_type: 'document', origin_type: 'born_digital',
      title: `Document ${i}`,
      page_count: 1, chunk_count: 0, ocr_required: false, ocr_completed: false,
      classification_label: 'document', classification_confidence: 1.0, classification_method: 'manual',
      extraction_status: 'extracted', indexing_status: 'indexed',
      content_hash: `h-${i}-${Math.random()}`,
    });
    ids.push(doc.document_id);
  }
  return ids;
}

function seedEntityFor(db: Database.Database, canonical: string, normalized: string, ids: string[]): void {
  const ent = new EntityIndexService(db);
  const e = ent.upsertEntity({ canonical_form: canonical, entity_type: 'PERSON', normalized_form: normalized, metadata: {} });
  for (let i = 0; i < ids.length; i++) {
    ent.upsertMention({
      mention_id: `m-${e.entity_id}-${i}`,
      entity_id: e.entity_id,
      document_id: ids[i],
      mention_text: canonical,
    });
  }
}

/** Replace the agent's RetrievalService with a stub. */
function setRetrievalStub(agent: Agent, stub: { retrieve(q: string): Promise<unknown> }): void {
  (agent as unknown as { _retrievalService: typeof stub })._retrievalService = stub;
}

describe('R10 — retrieval exception fallback', () => {
  it('retrieve() throwing does not crash chat; metadata is null; error is captured', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    setRetrievalStub(agent, {
      async retrieve(): Promise<unknown> { throw new Error('synthetic failure'); },
    });
    const captured: { systemPrompt?: string } = {};
    stubProvider(agent, captured);

    // chat must complete without throwing
    const reply = await agent.chat('how many documents');
    expect(reply).toBe('ok');

    // metadata is null
    expect(agent.getLastRetrievalMetadata()).toBeNull();
    // error captured for observability
    const err = agent.getLastRetrievalError();
    expect(err).toBeDefined();
    expect(err).toContain('synthetic failure');
    // stats null on failure
    expect(agent.getLastRetrievalStats()).toBeNull();
    // system prompt was NOT augmented
    expect(captured.systemPrompt).toBeDefined();
    expect(captured.systemPrompt).not.toContain('DOCUMENT COUNT');
    expect(captured.systemPrompt).not.toContain('Retrieved');
    await agent.shutdown?.();
  });
});

describe('R10 — retrieval timeout fallback', () => {
  it('retrieve that hangs beyond timeoutMs triggers timeout, falls through, error captured', async () => {
    const agent = buildAgent({ retrieval: { enabled: true, timeoutMs: 50 } });
    setRetrievalStub(agent, {
      // Never resolves — simulating a stuck SQL call
      async retrieve(): Promise<unknown> {
        return new Promise(() => { /* never */ });
      },
    });
    stubProvider(agent);
    const reply = await agent.chat('how many documents');
    expect(reply).toBe('ok');
    expect(agent.getLastRetrievalMetadata()).toBeNull();
    const err = agent.getLastRetrievalError();
    expect(err).toBeDefined();
    expect(err).toMatch(/timed out|timeout/i);
    expect(err).toContain('50ms');
    await agent.shutdown?.();
  });

  it('retrieve completing well within the timeout succeeds normally', async () => {
    const agent = buildAgent({ retrieval: { enabled: true, timeoutMs: 5000 } });
    seedDocs(getDb(agent), 3);
    stubProvider(agent);
    await agent.chat('how many documents');
    expect(agent.getLastRetrievalMetadata()).not.toBeNull();
    expect(agent.getLastRetrievalError()).toBeNull();
    expect(agent.getLastRetrievalStats()).not.toBeNull();
    await agent.shutdown?.();
  });
});

describe('R10 — bounded metadata limit (all-mode)', () => {
  it('200 entity-linked docs with default cap=50 → metadata holds 50, matchCount=200', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } }); // default maxMetadataDocs=50
    const db = getDb(agent);
    const ids = seedDocs(db, 200);
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', ids);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalMatchCount).toBe(200); // accurate, full count
    expect(meta.retrievalDocuments.length).toBe(50); // capped
    await agent.shutdown?.();
  }, 30_000);  // Windows IO budget — 200-doc seed loop + entity links + retrieval

  it('explicit maxMetadataDocs=10 caps to 10 while count remains full', async () => {
    const agent = buildAgent({ retrieval: { enabled: true, maxMetadataDocs: 10 } });
    const db = getDb(agent);
    const ids = seedDocs(db, 75);
    seedEntityFor(db, 'Jane Doe', 'jane doe', ids);
    stubProvider(agent);
    await agent.chat('show all references to jane doe');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalMatchCount).toBe(75);
    expect(meta.retrievalDocuments.length).toBe(10);
    await agent.shutdown?.();
  });

  it('count below cap is unchanged (no truncation)', async () => {
    const agent = buildAgent({ retrieval: { enabled: true, maxMetadataDocs: 50 } });
    const db = getDb(agent);
    const ids = seedDocs(db, 5);
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', ids);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const meta = agent.getLastRetrievalMetadata()!;
    expect(meta.retrievalMatchCount).toBe(5);
    expect(meta.retrievalDocuments.length).toBe(5);
    await agent.shutdown?.();
  });
});

describe('R10 — performance stats', () => {
  it('getLastRetrievalStats returns intent / source / matchCount / elapsedMs after success', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    seedDocs(getDb(agent), 5);
    stubProvider(agent);
    await agent.chat('how many documents');
    const s = agent.getLastRetrievalStats();
    expect(s).not.toBeNull();
    expect(s!.intent).toBe('COUNT');
    expect(s!.source).toBe('sql');
    expect(s!.matchCount).toBe(5);
    expect(typeof s!.elapsedMs).toBe('number');
    expect(s!.elapsedMs).toBeGreaterThanOrEqual(0);
    await agent.shutdown?.();
  });

  it('exact-search stats reflect entity source + match count', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const db = getDb(agent);
    const ids = seedDocs(db, 7);
    seedEntityFor(db, 'Robert Moyes', 'robert moyes', ids);
    stubProvider(agent);
    await agent.chat('show all references to robert moyes');
    const s = agent.getLastRetrievalStats()!;
    expect(s.intent).toBe('EXACT_SEARCH');
    expect(s.source).toBe('entity');
    expect(s.matchCount).toBe(7);
    await agent.shutdown?.();
  });

  it('per-call reset: a successful call after a failure clears the prior error', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    // First call: failure
    setRetrievalStub(agent, { async retrieve() { throw new Error('boom'); } });
    stubProvider(agent);
    await agent.chat('how many documents');
    expect(agent.getLastRetrievalError()).toBe('boom');

    // Second call: success — install a real-ish stub that returns minimal result.
    // Must include parseCountFilters since _buildRetrievalContext calls it for COUNT.
    setRetrievalStub(agent, {
      async retrieve(): Promise<unknown> {
        return {
          logId: 'L', intent: 'COUNT', source: 'sql',
          results: [{ result_id: 'r', log_id: 'L', document_id: '', rank: 1, score: 0, score_type: 'count', created_at: 0 }],
          executionMs: 1,
        };
      },
      parseCountFilters() { return {}; },
      extractExactSearchPhrase(q: string) { return q; },
    } as never);
    await agent.chat('how many documents');
    expect(agent.getLastRetrievalError()).toBeNull();
    expect(agent.getLastRetrievalStats()).not.toBeNull();
    await agent.shutdown?.();
  });
});

describe('R10 — flag off unchanged', () => {
  it('flag off — no stats, no error, no metadata', async () => {
    const agent = buildAgent({ retrieval: { enabled: false } });
    stubProvider(agent);
    await agent.chat('how many documents');
    expect(agent.getLastRetrievalMetadata()).toBeNull();
    expect(agent.getLastRetrievalStats()).toBeNull();
    expect(agent.getLastRetrievalError()).toBeNull();
    await agent.shutdown?.();
  });

  it('default config (no retrieval block) — same null-everywhere invariant', async () => {
    const agent = buildAgent({ omit: true });
    stubProvider(agent);
    await agent.chat('any query');
    expect(agent.getLastRetrievalMetadata()).toBeNull();
    expect(agent.getLastRetrievalStats()).toBeNull();
    expect(agent.getLastRetrievalError()).toBeNull();
    await agent.shutdown?.();
  });
});

describe('R10 — config validation', () => {
  it('non-numeric timeoutMs falls back to default (no crash)', async () => {
    // Write yaml with garbage timeoutMs
    const cfg = path.join(tmpDir, 'cfg.yaml');
    fs.writeFileSync(cfg, [
      'agent:',
      '  name: t', '  defaultProvider: ollama', '  model: llama3',
      '  retrieval:',
      '    enabled: true',
      '    timeoutMs: not-a-number',
      'providers:', '  ollama:', '    model: llama3', '    baseUrl: http://localhost:11434',
      'memory:', '  maxConversationHistory: 100', '  summarizeAfter: 50', '  embeddingProvider: local',
      'sessions:', '  persistToDisk: false', '  ttlMinutes: 60',
      'skills:', '  directory: ./skills', '  autoReload: false',
      'browser:', '  headless: true', '  timeout: 30000',
      'health:', '  enabled: false', '  port: 9090', '',
    ].join('\n'), 'utf-8');
    const agent = new Agent(cfg);
    seedDocs(getDb(agent), 1);
    stubProvider(agent);
    // If timeout got applied as garbage it might fire immediately. Default 5000 should not.
    await agent.chat('how many documents');
    expect(agent.getLastRetrievalError()).toBeNull();
    expect(agent.getLastRetrievalMetadata()).not.toBeNull();
    await agent.shutdown?.();
  });
});
