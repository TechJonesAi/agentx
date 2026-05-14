/**
 * Batch A2 — Tool-fallback policy enforcement.
 *
 * Exercises the gate that wraps the agent's executeToolCall(). The gate
 * blocks network-class tools when:
 *   - retrieval sufficiency for the current call is true, OR
 *   - localOnly mode is enabled.
 *
 * Non-network tools (memory_*, current_time, shell) are unaffected.
 *
 * Tests drive the agent directly with a stubbed provider that emits
 * specific tool_calls; we observe whether the mocked web_search tool
 * was actually executed and inspect the decision trace.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent.js';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import { DocumentRegistry } from '../../src/memory/document-registry.js';
import { FtsIndexService } from '../../src/memory/fts-index-service.js';
import type { LLMResponse, Tool, ToolCall } from '../../src/types.js';

let tmpDir: string;
let prevDataDir: string | undefined;

function writeCfg(dir: string, localOnly: boolean): string {
  const cfg = {
    agent: {
      name: 'X', defaultProvider: 'ollama', model: 'llama3',
      retrieval: { enabled: true, timeoutMs: 5000 },
      localOnly,
    },
    providers: {
      ollama: { model: 'llama3', baseUrl: 'http://localhost:11434' },
    },
    memory: { maxConversationHistory: 100, summarizeAfter: 50, embeddingProvider: 'local' },
    sessions: { persistToDisk: false, ttlMinutes: 60 },
    skills: { directory: './skills', autoReload: false },
    browser: { headless: true, timeout: 30000 },
    health: { enabled: false, port: 9090 },
  };
  const p = path.join(dir, 'config.json');
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  return p;
}

beforeEach(() => {
  prevDataDir = process.env['DATA_DIR'];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-policy-'));
  process.env['DATA_DIR'] = tmpDir;
}, 60_000);

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  if (prevDataDir === undefined) delete process.env['DATA_DIR']; else process.env['DATA_DIR'] = prevDataDir;
}, 60_000);

interface MockToolRecorder { calls: Array<{ name: string; args: Record<string, unknown> }> }

function buildAgent(localOnly: boolean): { agent: Agent; rec: MockToolRecorder } {
  const cfgPath = writeCfg(tmpDir, localOnly);
  const agent = new Agent(cfgPath);
  // Seed minimal cognitive schema (the agent ctor already runs it but
  // we want explicit docs).
  const db = (agent as unknown as { db: { exec(s: string): void; prepare(s: string): { run(...a: unknown[]): unknown; all(): unknown[] } } }).db;
  runCognitiveMemoryMigrations(db as never);
  const reg = new DocumentRegistry(db as never);
  const fts = new FtsIndexService(db as never);
  const doc = reg.create({
    file_name: 'AgentXPrivateMemoryHandbook.pdf', file_type: 'pdf', mime_type: 'image/book-collection',
    content_type: 'document', origin_type: 'book', title: 'AgentX Private Memory Handbook',
    page_count: 1, chunk_count: 1, ocr_required: false, ocr_completed: false,
    classification_label: 'knowledge_base', classification_confidence: 1.0, classification_method: 'manual',
    extraction_status: 'extracted', indexing_status: 'indexed',
    content_hash: 'h-policy-' + Math.random(),
  });
  const content = 'From the AgentX Private Memory Handbook page 3 the private memory passphrase is BLUE LANTERN 47.';
  db.prepare(`INSERT INTO document_pages (page_id, document_id, page_number, content, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    doc.document_id + '-p1', doc.document_id, 1, content, Date.now(),
  );
  db.prepare(`INSERT INTO document_chunks (chunk_id, document_id, page_id, chunk_number, content, created_at) VALUES (?, ?, ?, ?, ?, ?)`).run(
    doc.document_id + '-c0', doc.document_id, doc.document_id + '-p1', 0, content, Date.now(),
  );
  fts.upsertDocumentFts(doc.document_id, {
    title: 'AgentX Private Memory Handbook', sender: '', recipient: '', subject: '',
    content, file_name: 'AgentXPrivateMemoryHandbook.pdf',
  });

  // Register a mock web_search tool that records every invocation.
  const rec: MockToolRecorder = { calls: [] };
  const webSearchTool: Tool = {
    definition: {
      name: 'web_search',
      description: 'Search the public web',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
    async execute(args) { rec.calls.push({ name: 'web_search', args }); return JSON.stringify({ hits: ['fake-result'] }); },
  };
  agent.getToolRegistry().register(webSearchTool);
  return { agent, rec };
}

/** Install a provider stub that emits a single web_search tool_call on the
 *  first invocation, then returns plain text on the second (after tool
 *  result is appended to messages). */
function stubProviderEmittingWebSearch(agent: Agent): void {
  let firstCall = true;
  const stub = {
    isConfigured: () => true,
    async complete(): Promise<LLMResponse> {
      if (firstCall) {
        firstCall = false;
        const tc: ToolCall = { id: 'tc-1', name: 'web_search', arguments: { query: 'anything' } };
        return { content: '', toolCalls: [tc] };
      }
      return { content: 'done', toolCalls: [] };
    },
    async completeStream(): Promise<LLMResponse> {
      if (firstCall) {
        firstCall = false;
        const tc: ToolCall = { id: 'tc-1', name: 'web_search', arguments: { query: 'anything' } };
        return { content: '', toolCalls: [tc] };
      }
      return { content: 'done', toolCalls: [] };
    },
  };
  (agent as unknown as { provider: typeof stub }).provider = stub;
}

describe('Tool-fallback policy — Batch A2', () => {
  it('memory-sufficient query: web_search is BLOCKED with reason=sufficient_memory', async () => {
    const { agent, rec } = buildAgent(false /* localOnly */);
    stubProviderEmittingWebSearch(agent);
    await agent.chat('private memory passphrase handbook');
    expect(rec.calls, 'web_search must not run when memory is sufficient').toEqual([]);
    const trace = agent.getLastDecisionTrace();
    const blocked = trace.find((e) => e.event === 'tool_fallback_blocked');
    expect(blocked).toBeDefined();
    expect((blocked as { reason: string }).reason).toBe('sufficient_memory');
  }, 60_000);

  it('memory-insufficient query with localOnly=false: web_search is ALLOWED', async () => {
    const { agent, rec } = buildAgent(false);
    stubProviderEmittingWebSearch(agent);
    await agent.chat('completely unrelated topic xyzzy');
    expect(rec.calls.length).toBe(1);
    const trace = agent.getLastDecisionTrace();
    const allowed = trace.find((e) => e.event === 'tool_fallback_allowed' && (e as { tool: string }).tool === 'web_search');
    expect(allowed).toBeDefined();
  }, 60_000);

  it('memory-insufficient query with localOnly=true: web_search is BLOCKED with reason=local_only', async () => {
    const { agent, rec } = buildAgent(true);
    stubProviderEmittingWebSearch(agent);
    await agent.chat('completely unrelated topic xyzzy');
    expect(rec.calls, 'web_search must be blocked when localOnly=true').toEqual([]);
    const trace = agent.getLastDecisionTrace();
    const blocked = trace.find((e) => e.event === 'tool_fallback_blocked');
    expect(blocked).toBeDefined();
    expect((blocked as { reason: string }).reason).toBe('local_only');
    const ext = trace.find((e) => e.event === 'external_request_blocked');
    expect(ext).toBeDefined();
  }, 60_000);

  it('non-network tools (current_time) are ALLOWED regardless of policy state', async () => {
    const { agent } = buildAgent(true /* even with localOnly */);
    // Stub a provider that emits current_time
    let firstCall = true;
    const stub = {
      isConfigured: () => true,
      async complete(): Promise<LLMResponse> {
        if (firstCall) { firstCall = false; return { content: '', toolCalls: [{ id: 't1', name: 'current_time', arguments: {} }] }; }
        return { content: 'ok', toolCalls: [] };
      },
      async completeStream(): Promise<LLMResponse> {
        if (firstCall) { firstCall = false; return { content: '', toolCalls: [{ id: 't1', name: 'current_time', arguments: {} }] }; }
        return { content: 'ok', toolCalls: [] };
      },
    };
    (agent as unknown as { provider: typeof stub }).provider = stub;
    await agent.chat('what time is it');
    const trace = agent.getLastDecisionTrace();
    const allowed = trace.find((e) => e.event === 'tool_fallback_allowed' && (e as { tool: string }).tool === 'current_time');
    expect(allowed).toBeDefined();
    expect((allowed as { reason: string }).reason).toBe('non_network_tool');
  }, 60_000);

  it('decision trace exposes retrieval_started + retrieval_sufficiency_decision in order', async () => {
    const { agent } = buildAgent(false);
    stubProviderEmittingWebSearch(agent);
    await agent.chat('private memory passphrase handbook');
    const trace = agent.getLastDecisionTrace();
    const names = trace.map((e) => e.event);
    expect(names[0]).toBe('retrieval_started');
    expect(names).toContain('retrieval_sufficiency_decision');
    expect(names.indexOf('retrieval_sufficiency_decision')).toBeGreaterThan(names.indexOf('retrieval_started'));
  }, 60_000);

  it('isLocalOnly() reflects the config flag', async () => {
    const a1 = buildAgent(true).agent;
    expect(a1.isLocalOnly()).toBe(true);
    const a2 = buildAgent(false).agent;
    expect(a2.isLocalOnly()).toBe(false);
  });
});
