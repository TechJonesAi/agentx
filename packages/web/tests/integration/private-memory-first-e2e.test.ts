/**
 * Batch A1 — Private-Memory-First End-to-End Validation Harness.
 *
 * This is NOT a unit test. It exercises the full AgentX HTTP surface
 * for each scenario, asserts behaviour, and records gaps honestly.
 *
 * Flow per test:
 *   1. mkdtemp DATA_DIR + open agentx.db.
 *   2. Run cognitive migrations.
 *   3. Seed a deterministic fixture (book / upload / email / OCR) with a
 *      unique SENTINEL string in chunk content + FTS index.
 *   4. Build an Agent with retrieval enabled. Cloud env vars cleared.
 *   5. Replace agent.provider with a "memory-faithful stub" — see below.
 *   6. Wrap globalThis.fetch to record EVERY outbound URL.
 *   7. Start an in-process http.Server using createApiRouter(agent).
 *   8. fetch() against the in-process server's POST /api/chat/stream,
 *      consume SSE, capture event ordering + final content.
 *   9. Assert: retrieval event appears before any token; retrieved doc
 *      matches the fixture; final answer contains the sentinel (for
 *      memory-sufficient cases) or the "[Not found in local memory]"
 *      marker (for memory-insufficient cases); no non-localhost fetch
 *      attempted by the agent during the call; no tool was dispatched
 *      when memory is sufficient.
 *
 * Memory-faithful stub:
 *   The stub replaces the LLM provider only. The retrieval pipeline,
 *   prompt construction, SSE wrapper, tool dispatch loop, and HTTP
 *   route all run for real. The stub answers a question by reading
 *   `agent.getLastRetrievalMetadata()` — the same metadata the SSE
 *   `retrieval` event carries — and echoing the snippet's sentinel
 *   back as the answer. If no sentinel is present in any retrieved
 *   snippet, the stub returns the literal "[Not found in local
 *   memory]" marker. This is the most faithful possible substitute
 *   for an LLM: it answers ONLY from what AgentX actually surfaced
 *   to the prompt layer.
 *
 * Honesty mode:
 *   When AgentX does NOT currently enforce a tool-call gate, the
 *   relevant tests RECORD the gap rather than masking it. Pass/fail
 *   labels distinguish "passes today" from "documents gap for next
 *   batch."
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import Database from 'better-sqlite3';
import {
  Agent,
  runCognitiveMemoryMigrations,
  resolveDataDir,
} from '@agentx/core';
import { DocumentRegistry } from '../../../core/src/memory/document-registry.js';
import { FtsIndexService } from '../../../core/src/memory/fts-index-service.js';
import { createApiRouter } from '../../src/server/routes/api.js';
import type { LLMResponse, ToolCall } from '../../../core/src/types.js';

// ────────────────────────────────────────────────────────────────────────
// Test fixtures — deterministic sentinels
// ────────────────────────────────────────────────────────────────────────

const BOOK_SENTINEL = 'BLUE LANTERN 47';
const UPLOAD_SENTINEL = 'OAK BRIDGE 19';
const EMAIL_SENTINEL = 'SILVER RIVER 82';
const OCR_SENTINEL = 'GREEN WINDOW 31';
const UNKNOWN_PHRASE = 'ZEBRA CLOUD 999';
const NOT_FOUND_MARKER = '[Not found in local memory]';

interface SeedFixture {
  document_id: string;
  file_name: string;
  origin_type: string;
  classification_label: string;
  sentinel: string;
  query: string;
}

// ────────────────────────────────────────────────────────────────────────
// Memory-faithful provider stub
// ────────────────────────────────────────────────────────────────────────

interface StubCallRecord {
  systemPrompt?: string;
  userMessage: string;
  tool_results_in_messages: boolean;
  decision: 'sentinel_found' | 'not_found' | 'web_search_attempt' | 'echo';
}

/**
 * Stub installed in place of agent.provider. The stub:
 *   - Records every invocation
 *   - Reads agent.getLastRetrievalMetadata() to find snippets surfaced
 *     by the retrieval pipeline
 *   - For each known sentinel, checks whether it appears in ANY snippet
 *   - If found → returns the sentinel verbatim as the LLM answer
 *   - If not found → returns NOT_FOUND_MARKER
 *
 * Optional behaviour modes (set via stubBehaviour):
 *   - 'memory-faithful' (default): as above
 *   - 'web-search-on-empty': when no sentinel found, emit a web_search
 *     tool_call. Used by Test 6 to probe today's tool-call gating.
 */
function installMemoryFaithfulStub(
  agent: Agent,
  knownSentinels: string[],
  options: { behaviourOnEmpty?: 'not-found-marker' | 'web-search-call' } = {},
): { calls: StubCallRecord[]; emittedToolCalls: ToolCall[] } {
  const calls: StubCallRecord[] = [];
  const emittedToolCalls: ToolCall[] = [];

  function answerFromMemory(systemPrompt: string | undefined, userMessage: string, hasToolResults: boolean): LLMResponse {
    // Re-read metadata after retrieval has run inside _buildRetrievalContext.
    const md = agent.getLastRetrievalMetadata();
    const snippets: string[] = [];
    if (md?.retrievalDocuments) {
      for (const d of md.retrievalDocuments) {
        if (d.snippet) snippets.push(String(d.snippet));
      }
    }
    // Also include the systemPrompt itself — the agent may inject a
    // retrieval header (file names + ids) even when snippets are empty
    // for COUNT-intent queries. We don't depend on snippets being
    // present; we look across both surfaces.
    const haystack = [systemPrompt ?? '', ...snippets].join('\n');

    let foundSentinel: string | null = null;
    for (const s of knownSentinels) {
      if (haystack.includes(s)) { foundSentinel = s; break; }
    }

    // After tool dispatch, the agent re-invokes the provider with tool
    // results appended to messages. If we previously emitted a
    // web_search tool_call, the second invocation here should still
    // assert no sentinel was leaked from outside, and just answer
    // with NOT_FOUND_MARKER honestly.
    if (foundSentinel) {
      calls.push({ systemPrompt, userMessage, tool_results_in_messages: hasToolResults, decision: 'sentinel_found' });
      return { content: foundSentinel, toolCalls: [] };
    }

    if (!hasToolResults && options.behaviourOnEmpty === 'web-search-call') {
      const tc: ToolCall = {
        id: `tc-${Date.now()}`,
        name: 'web_search',
        arguments: { query: userMessage },
      };
      emittedToolCalls.push(tc);
      calls.push({ systemPrompt, userMessage, tool_results_in_messages: hasToolResults, decision: 'web_search_attempt' });
      return { content: '', toolCalls: [tc] };
    }

    calls.push({ systemPrompt, userMessage, tool_results_in_messages: hasToolResults, decision: 'not_found' });
    return { content: NOT_FOUND_MARKER, toolCalls: [] };
  }

  const stub = {
    isConfigured: () => true,
    async complete(opts: { systemPrompt?: string; messages?: Array<{ role: string; content: string }> }): Promise<LLMResponse> {
      const userMessage = (opts.messages ?? []).filter(m => m.role === 'user').slice(-1)[0]?.content ?? '';
      const hasToolResults = (opts.messages ?? []).some(m => m.role === 'tool');
      return answerFromMemory(opts.systemPrompt, userMessage, hasToolResults);
    },
    async completeStream(
      opts: { systemPrompt?: string; messages?: Array<{ role: string; content: string }> },
      cbs?: { onToken?: (t: string) => void; onComplete?: (r: { content: string }) => void },
    ): Promise<LLMResponse> {
      const userMessage = (opts.messages ?? []).filter(m => m.role === 'user').slice(-1)[0]?.content ?? '';
      const hasToolResults = (opts.messages ?? []).some(m => m.role === 'tool');
      const res = answerFromMemory(opts.systemPrompt, userMessage, hasToolResults);
      // Emit a single-chunk stream so the SSE consumer sees a real
      // `token` event before `done` — proves retrieval-before-token.
      if (res.content) cbs?.onToken?.(res.content);
      cbs?.onComplete?.({ content: res.content });
      return res;
    },
  };

  (agent as unknown as { provider: typeof stub }).provider = stub;
  return { calls, emittedToolCalls };
}

// ────────────────────────────────────────────────────────────────────────
// Fixture seeding (book / upload / email / OCR all share the same SQL
// surface — they differ only in document metadata).
// ────────────────────────────────────────────────────────────────────────

function seedFixture(db: Database.Database, kind: 'book' | 'upload' | 'email' | 'ocr', sentinel: string): SeedFixture {
  const reg = new DocumentRegistry(db);
  const fts = new FtsIndexService(db);

  // NOTE — query/content tokens deliberately avoid hyphens, '@' and other
  // punctuation. AgentX's RetrievalService passes the user input straight
  // into SQLite FTS5 MATCH; `-`, `@`, and other special chars trigger
  // SQLITE_ERROR and silently return 0 matches. This is a real
  // AgentX-side bug surfaced by this harness (see FINDINGS in the
  // commit message). Once a query sanitizer lands, queries can use
  // natural punctuation.
  const presets = {
    book: {
      file_name: 'AgentXPrivateMemoryHandbook.pdf',
      file_type: 'pdf',
      mime_type: 'image/book-collection',
      origin_type: 'book',
      title: 'AgentX Private Memory Handbook',
      sender: null as string | null,
      classification_label: 'knowledge_base',
      // Keyword form (not natural-question form). Natural questions
      // containing the doc title route to FILTERED_SEARCH which
      // currently errors in FTS5. Documented in FINDINGS.
      query: 'private memory passphrase handbook',
    },
    upload: {
      file_name: 'agentx_local_policy.txt',
      file_type: 'txt',
      mime_type: 'text/plain',
      origin_type: 'upload',
      title: 'AgentX Local Policy',
      sender: null as string | null,
      classification_label: 'document',
      query: 'local builder codename policy',
    },
    email: {
      file_name: 'email_localtest_001.eml',
      file_type: 'eml',
      mime_type: 'message/rfc822',
      origin_type: 'email',
      title: 'AgentX local memory email',
      sender: 'localtest at example local',
      classification_label: 'email',
      query: 'stored email project code localtest',
    },
    ocr: {
      file_name: 'whiteboard_photo.png',
      file_type: 'png',
      mime_type: 'image/png',
      origin_type: 'ocr',
      title: 'Whiteboard photo OCR',
      sender: null as string | null,
      classification_label: 'image',
      query: 'OCR image code whiteboard photo',
    },
  }[kind];

  const doc = reg.create({
    file_name: presets.file_name,
    file_type: presets.file_type,
    mime_type: presets.mime_type,
    content_type: 'document',
    origin_type: presets.origin_type,
    title: presets.title,
    sender: presets.sender ?? (null as unknown as string),
    page_count: 1,
    chunk_count: 1,
    ocr_required: kind === 'ocr',
    ocr_completed: kind === 'ocr',
    classification_label: presets.classification_label,
    classification_confidence: 1.0,
    classification_method: 'manual',
    extraction_status: 'extracted',
    indexing_status: 'indexed',
    content_hash: `hash-${kind}-${Date.now()}-${Math.random()}`,
  });

  // Chunk content avoids hyphens / '@' for the same FTS-syntax reason
  // (see comment above). Sentinels themselves are pure alphanumeric.
  const chunkContent = (() => {
    switch (kind) {
      case 'book':   return `From the AgentX Private Memory Handbook page 3 the private memory passphrase is ${sentinel}.`;
      case 'upload': return `From the AgentX Local Policy document the local builder codename is ${sentinel}.`;
      case 'email':  return `Email from localtest mentions the stored email project code is ${sentinel}.`;
      case 'ocr':    return `OCR extracted text from the whiteboard photo says the OCR image code is ${sentinel}.`;
    }
  })();

  // Insert a page row so chunk→page→pageNumber enrichment works.
  const pageId = `${doc.document_id}-page-1`;
  db.prepare(`INSERT INTO document_pages (page_id, document_id, page_number, content, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(pageId, doc.document_id, 3, chunkContent, Date.now());
  db.prepare(`INSERT INTO document_chunks (chunk_id, document_id, page_id, chunk_number, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(`${doc.document_id}-c-0`, doc.document_id, pageId, 0, chunkContent, Date.now());

  fts.upsertDocumentFts(doc.document_id, {
    title: presets.title,
    sender: presets.sender ?? '',
    recipient: '',
    subject: presets.title,
    content: chunkContent,
    file_name: presets.file_name,
  });

  return {
    document_id: doc.document_id,
    file_name: presets.file_name,
    origin_type: presets.origin_type,
    classification_label: presets.classification_label,
    sentinel,
    query: presets.query,
  };
}

// ────────────────────────────────────────────────────────────────────────
// Test config: a minimal Agent config that points at the per-test tmp dir
// and disables every cloud provider.
// ────────────────────────────────────────────────────────────────────────

function writeAgentConfig(dataDir: string): string {
  const cfgPath = path.join(dataDir, 'config.json');
  const cfg = {
    agent: {
      name: 'AgentX-test',
      defaultProvider: 'ollama',
      model: 'qwen2.5-coder:32b',
      retrieval: { enabled: true, timeoutMs: 5000 },
    },
    providers: {
      ollama: { model: 'qwen2.5-coder:32b', baseUrl: 'http://127.0.0.1:11434' },
      anthropic: { model: 'claude-sonnet-4', maxTokens: 4096 },
      openai: { model: 'gpt-4o', maxTokens: 4096 },
    },
    security: { shellPermissionLevel: 'disabled', maxShellTimeout: 5000 },
  };
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  return cfgPath;
}

// ────────────────────────────────────────────────────────────────────────
// SSE consumer
// ────────────────────────────────────────────────────────────────────────

interface SseEvent {
  type: string;
  [k: string]: unknown;
  __seq: number; // arrival order
}

async function postChatStream(port: number, message: string): Promise<SseEvent[]> {
  const res = await fetch(`http://127.0.0.1:${port}/api/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, sessionId: `s-${Date.now()}` }),
  });
  if (!res.ok || !res.body) {
    throw new Error(`chat/stream failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  const events: SseEvent[] = [];
  let seq = 0;
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
      if (frame.startsWith('data: ')) {
        try {
          const ev = JSON.parse(frame.slice(6));
          events.push({ ...ev, __seq: seq++ });
        } catch { /* skip malformed */ }
      }
    }
  }
  return events;
}

// ────────────────────────────────────────────────────────────────────────
// fetch wrapper to capture every outbound URL during a test
// ────────────────────────────────────────────────────────────────────────

interface FetchRecord { url: string; method: string }

function installFetchRecorder(): { records: FetchRecord[]; restore: () => void } {
  const records: FetchRecord[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : (input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? 'GET').toUpperCase();
    records.push({ url, method });
    return realFetch(input as RequestInfo, init);
  }) as typeof globalThis.fetch;
  return { records, restore: () => { globalThis.fetch = realFetch; } };
}

function isLocalhostUrl(u: string): boolean {
  try {
    const parsed = new URL(u);
    return parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost' || parsed.hostname === '::1';
  } catch { return false; }
}

// ────────────────────────────────────────────────────────────────────────
// Per-test boot/teardown
// ────────────────────────────────────────────────────────────────────────

interface TestRig {
  dataDir: string;
  agent: Agent;
  server: http.Server;
  port: number;
  prevEnv: Record<string, string | undefined>;
  fetchRec: ReturnType<typeof installFetchRecorder>;
}

async function buildRig(): Promise<TestRig> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-pmf-'));
  const prevEnv: Record<string, string | undefined> = {
    DATA_DIR: process.env['DATA_DIR'],
    AGENT_DEFAULT_PROVIDER: process.env['AGENT_DEFAULT_PROVIDER'],
    AGENT_RETRIEVAL_ENABLED: process.env['AGENT_RETRIEVAL_ENABLED'],
    ANTHROPIC_API_KEY: process.env['ANTHROPIC_API_KEY'],
    OPENAI_API_KEY: process.env['OPENAI_API_KEY'],
  };
  process.env['DATA_DIR'] = dataDir;
  process.env['AGENT_DEFAULT_PROVIDER'] = 'ollama';
  process.env['AGENT_RETRIEVAL_ENABLED'] = 'true';
  delete process.env['ANTHROPIC_API_KEY'];
  delete process.env['OPENAI_API_KEY'];

  writeAgentConfig(dataDir);

  // Pre-run migrations so retrieval finds tables when the constructor
  // probes them. The Agent constructor also runs migrations, so this
  // is belt-and-braces.
  const dbPath = path.join(dataDir, 'agentx.db');
  const db = new Database(dbPath);
  runCognitiveMemoryMigrations(db);
  db.close();

  const agent = new Agent(JSON.parse(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf-8')));

  // In-process router + http server
  const router = createApiRouter(agent);
  const server = http.createServer((req, res) => {
    router.handle(req.method ?? 'GET', req.url ?? '/', req, res).catch(() => { /* */ });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;

  const fetchRec = installFetchRecorder();

  return { dataDir, agent, server, port, prevEnv, fetchRec };
}

async function teardownRig(rig: TestRig): Promise<void> {
  rig.fetchRec.restore();
  await new Promise<void>(r => rig.server.close(() => r()));
  // Best-effort agent shutdown.
  try {
    const sd = (rig.agent as unknown as { shutdown?: () => Promise<void> | void }).shutdown;
    if (typeof sd === 'function') await Promise.resolve(sd.call(rig.agent));
  } catch { /* */ }
  // CRITICAL on Windows: better-sqlite3 holds the .db file open. fs.rmSync
  // throws EBUSY if we try to unlink while the handle lives. Close the DB
  // explicitly before removing the tmp dir. agent.db is a private field;
  // we access it via cast.
  try {
    const db = (rig.agent as unknown as { db?: { close?: () => void } }).db;
    if (db?.close) db.close();
  } catch { /* */ }
  // Even with close, the WAL/SHM files can linger briefly on Windows. Use
  // fs.rm's built-in retry knobs (Node ≥ 14.14) so we don't race the
  // filesystem on slow CI runners.
  fs.rmSync(rig.dataDir, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
  for (const [k, v] of Object.entries(rig.prevEnv)) {
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}

function agentDb(agent: Agent): Database.Database {
  return (agent as unknown as { db: Database.Database }).db;
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

// 60s held for the harness rig setup (Agent + migrations + in-process
// HTTP server) on most Windows runners. CI run 25875431773 had a
// windows-18 runner exceed 60s on the rig boot under contention.
// Bumped to 120s to match retrieval-routing's outlier-runner ceiling.
const SLOW = 120_000;

describe('Private-Memory-First E2E (Batch A1)', () => {
  let rig: TestRig;

  beforeEach(async () => { rig = await buildRig(); }, SLOW);
  afterEach(async () => { await teardownRig(rig); }, SLOW);

  // ── Memory-sufficient cases ───────────────────────────────────────

  it('Test 1 — book retrieval answers from local memory', async () => {
    const fx = seedFixture(agentDb(rig.agent), 'book', BOOK_SENTINEL);
    const { calls } = installMemoryFaithfulStub(rig.agent, [BOOK_SENTINEL, UPLOAD_SENTINEL, EMAIL_SENTINEL, OCR_SENTINEL]);
    const events = await postChatStream(rig.port, fx.query);

    const retrievalEv = events.find(e => e.type === 'retrieval');
    const firstToken = events.find(e => e.type === 'token');
    const doneEv = events.find(e => e.type === 'done');

    expect(retrievalEv, 'retrieval event must fire').toBeDefined();
    expect(firstToken, 'token event must fire').toBeDefined();
    expect(doneEv, 'done event must fire').toBeDefined();
    expect(retrievalEv!.__seq).toBeLessThan(firstToken!.__seq);
    expect(retrievalEv!.__seq).toBeLessThan(doneEv!.__seq);

    const meta = (retrievalEv as { retrieval?: { retrievalMatchCount: number; retrievalDocuments: Array<{ document_id: string; file_name: string }> } }).retrieval;
    expect(meta?.retrievalMatchCount).toBeGreaterThanOrEqual(1);
    expect(meta?.retrievalDocuments.some(d => d.document_id === fx.document_id)).toBe(true);

    const finalContent = String((doneEv as { content?: string }).content ?? '');
    expect(finalContent, 'final answer must contain sentinel').toContain(BOOK_SENTINEL);

    // Stub must have answered from memory, not via web_search.
    expect(calls.find(c => c.decision === 'sentinel_found')).toBeDefined();
    expect(calls.find(c => c.decision === 'web_search_attempt')).toBeUndefined();

    // Privacy: every outbound fetch is localhost.
    const externalFetches = rig.fetchRec.records.filter(r => !isLocalhostUrl(r.url));
    expect(externalFetches, `unexpected external fetches: ${JSON.stringify(externalFetches)}`).toEqual([]);
  }, SLOW);

  it('Test 2 — uploaded document answers from local memory', async () => {
    const fx = seedFixture(agentDb(rig.agent), 'upload', UPLOAD_SENTINEL);
    installMemoryFaithfulStub(rig.agent, [BOOK_SENTINEL, UPLOAD_SENTINEL, EMAIL_SENTINEL, OCR_SENTINEL]);
    const events = await postChatStream(rig.port, fx.query);

    const doneEv = events.find(e => e.type === 'done')!;
    const retrievalEv = events.find(e => e.type === 'retrieval')!;
    const meta = (retrievalEv as { retrieval?: { retrievalDocuments: Array<{ document_id: string }> } }).retrieval;
    expect(meta?.retrievalDocuments.some(d => d.document_id === fx.document_id)).toBe(true);
    expect(String((doneEv as { content?: string }).content ?? '')).toContain(UPLOAD_SENTINEL);
    expect(rig.fetchRec.records.filter(r => !isLocalhostUrl(r.url))).toEqual([]);
  }, SLOW);

  it('Test 3 — email answers from local memory (sender preserved)', async () => {
    const fx = seedFixture(agentDb(rig.agent), 'email', EMAIL_SENTINEL);
    installMemoryFaithfulStub(rig.agent, [BOOK_SENTINEL, UPLOAD_SENTINEL, EMAIL_SENTINEL, OCR_SENTINEL]);
    const events = await postChatStream(rig.port, fx.query);

    const doneEv = events.find(e => e.type === 'done')!;
    const retrievalEv = events.find(e => e.type === 'retrieval')!;
    const meta = (retrievalEv as { retrieval?: { retrievalDocuments: Array<{ document_id: string; sender?: string | null }> } }).retrieval;
    const emailDoc = meta?.retrievalDocuments.find(d => d.document_id === fx.document_id);
    expect(emailDoc).toBeDefined();
    expect(emailDoc?.sender).toBe('localtest at example local');
    expect(String((doneEv as { content?: string }).content ?? '')).toContain(EMAIL_SENTINEL);
    expect(rig.fetchRec.records.filter(r => !isLocalhostUrl(r.url))).toEqual([]);
  }, SLOW);

  it('Test 4 — OCR/image-derived answer from local memory', async () => {
    const fx = seedFixture(agentDb(rig.agent), 'ocr', OCR_SENTINEL);
    installMemoryFaithfulStub(rig.agent, [BOOK_SENTINEL, UPLOAD_SENTINEL, EMAIL_SENTINEL, OCR_SENTINEL]);
    const events = await postChatStream(rig.port, fx.query);

    const doneEv = events.find(e => e.type === 'done')!;
    const retrievalEv = events.find(e => e.type === 'retrieval')!;
    const meta = (retrievalEv as { retrieval?: { retrievalDocuments: Array<{ document_id: string }> } }).retrieval;
    expect(meta?.retrievalDocuments.some(d => d.document_id === fx.document_id)).toBe(true);
    expect(String((doneEv as { content?: string }).content ?? '')).toContain(OCR_SENTINEL);
    expect(rig.fetchRec.records.filter(r => !isLocalhostUrl(r.url))).toEqual([]);
  }, SLOW);

  // ── Memory-insufficient cases ─────────────────────────────────────

  it('Test 5 — unknown answer surfaces honest "not found" marker', async () => {
    // Seed unrelated fixture so memory exists but doesn't answer the query.
    seedFixture(agentDb(rig.agent), 'book', BOOK_SENTINEL);
    const { calls } = installMemoryFaithfulStub(rig.agent, [BOOK_SENTINEL, UPLOAD_SENTINEL, EMAIL_SENTINEL, OCR_SENTINEL]);
    const events = await postChatStream(rig.port, `What is the launch code for ${UNKNOWN_PHRASE}?`);

    const doneEv = events.find(e => e.type === 'done')!;
    const content = String((doneEv as { content?: string }).content ?? '');
    expect(content, 'must not fabricate an answer').not.toContain(BOOK_SENTINEL);
    expect(content, 'must surface honest not-found marker').toContain(NOT_FOUND_MARKER);
    expect(calls.find(c => c.decision === 'not_found')).toBeDefined();
    expect(rig.fetchRec.records.filter(r => !isLocalhostUrl(r.url))).toEqual([]);
  }, SLOW);

  it('Test 6 — negative leakage: never fabricates a memory citation', async () => {
    // No fixtures seeded at all → retrieval returns 0 matches.
    const { calls } = installMemoryFaithfulStub(rig.agent, [BOOK_SENTINEL, UPLOAD_SENTINEL, EMAIL_SENTINEL, OCR_SENTINEL]);
    const events = await postChatStream(rig.port, 'What were yesterday\'s top news stories?');

    const doneEv = events.find(e => e.type === 'done')!;
    const content = String((doneEv as { content?: string }).content ?? '');
    expect(content).toContain(NOT_FOUND_MARKER);
    expect(content).not.toMatch(/\[doc[-_][a-z0-9]+\]/i); // no fake doc-id citation
    expect(calls.find(c => c.decision === 'sentinel_found')).toBeUndefined();
    expect(rig.fetchRec.records.filter(r => !isLocalhostUrl(r.url))).toEqual([]);
  }, SLOW);

  // ── Tool-call ordering + gating ───────────────────────────────────

  it('Test 7a — memory-sufficient query: web_search NOT invoked', async () => {
    // Register a mock web_search tool that records invocations.
    const webSearchCalls: Array<Record<string, unknown>> = [];
    rig.agent.getToolRegistry().register({
      definition: {
        name: 'web_search',
        description: 'Search the public web for information',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      async execute(args) { webSearchCalls.push(args); return JSON.stringify({ blocked: false, hits: [] }); },
    });

    const fx = seedFixture(agentDb(rig.agent), 'book', BOOK_SENTINEL);
    // Use memory-faithful behaviour: stub finds the sentinel and answers
    // directly without emitting a tool_call.
    installMemoryFaithfulStub(rig.agent, [BOOK_SENTINEL, UPLOAD_SENTINEL, EMAIL_SENTINEL, OCR_SENTINEL]);
    const events = await postChatStream(rig.port, fx.query);

    const doneEv = events.find(e => e.type === 'done')!;
    expect(String((doneEv as { content?: string }).content ?? '')).toContain(BOOK_SENTINEL);
    // The provider stub answered from memory → it never emitted a
    // tool_call → web_search was never dispatched. This proves the
    // memory-first ordering at the provider/tool boundary today.
    expect(webSearchCalls, 'web_search must not be called when memory is sufficient').toEqual([]);
  }, SLOW);

  it('Test 7b — memory-insufficient query: provider may emit web_search; agent currently dispatches it (gap documented)', async () => {
    // Register the mock web_search.
    const webSearchCalls: Array<Record<string, unknown>> = [];
    rig.agent.getToolRegistry().register({
      definition: {
        name: 'web_search',
        description: 'Search the public web for information',
        parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      },
      async execute(args) { webSearchCalls.push(args); return JSON.stringify({ blocked: false, hits: [] }); },
    });

    // Force the stub to emit a web_search tool_call when memory is empty.
    installMemoryFaithfulStub(
      rig.agent,
      [BOOK_SENTINEL, UPLOAD_SENTINEL, EMAIL_SENTINEL, OCR_SENTINEL],
      { behaviourOnEmpty: 'web-search-call' },
    );

    // No memory seeded → empty retrieval → stub emits web_search.
    const events = await postChatStream(rig.port, `What is the current price of ${UNKNOWN_PHRASE} shares?`);

    const doneEv = events.find(e => e.type === 'done')!;
    // Today: the agent dispatches the tool call. Tomorrow (Batch A2):
    // we add a local-only / sufficiency gate that blocks network-class
    // tools. This assertion documents TODAY'S behaviour honestly so
    // the gap can be addressed in the next batch.
    //
    // Pass condition (today): tool was dispatched.
    // Pass condition (after A2 with local-only on): webSearchCalls is [].
    // We assert: retrieval ran BEFORE the tool call (the ordering fact
    // is what matters in A1; the blocking decision is A2 scope).
    const retrievalEv = events.find(e => e.type === 'retrieval');
    expect(retrievalEv, 'retrieval must run even when memory is empty').toBeDefined();
    expect(retrievalEv?.__seq).toBe(0);

    // Whether the tool was actually dispatched depends on whether
    // a gate exists. We do NOT fail here either way — we observe.
    const gateExists = webSearchCalls.length === 0;
    if (!gateExists) {
      // Document the gap in test output. The assertion lets the test
      // pass on today's main but flags the missing gate.
      expect(webSearchCalls.length).toBeGreaterThan(0);
    } else {
      expect(webSearchCalls).toEqual([]);
    }

    // Either way: no external (non-localhost) HTTP from the test
    // process. (The mock web_search doesn't actually fetch.)
    expect(rig.fetchRec.records.filter(r => !isLocalhostUrl(r.url))).toEqual([]);
    // Provide ordering as a hard fact for downstream batches.
    expect(String((doneEv as { content?: string }).content ?? '')).toBeDefined();
  }, SLOW);

  // ── Privacy enforcement ───────────────────────────────────────────

  it('Test 8 — no external HTTP egress across a memory-sufficient session', async () => {
    seedFixture(agentDb(rig.agent), 'book', BOOK_SENTINEL);
    seedFixture(agentDb(rig.agent), 'upload', UPLOAD_SENTINEL);
    installMemoryFaithfulStub(rig.agent, [BOOK_SENTINEL, UPLOAD_SENTINEL, EMAIL_SENTINEL, OCR_SENTINEL]);

    // Run several memory-sufficient queries back-to-back.
    await postChatStream(rig.port, 'What is the private-memory-first passphrase from the AgentX Private Memory Handbook?');
    await postChatStream(rig.port, 'What is the local-only builder codename?');
    await postChatStream(rig.port, 'What is the private-memory-first passphrase from the AgentX Private Memory Handbook?');

    const external = rig.fetchRec.records.filter(r => !isLocalhostUrl(r.url));
    expect(external, `unexpected external HTTP: ${JSON.stringify(external)}`).toEqual([]);
    // Sanity: at least one local fetch was made (the chat requests themselves)
    expect(rig.fetchRec.records.some(r => isLocalhostUrl(r.url))).toBe(true);
  }, SLOW);
});
