/**
 * Integration: tool calls executed through the AgentX tool path are
 * recorded in the ToolOutcomeStore. Verifies Batch 1's self-learning
 * pipeline end-to-end without booting the full Agent.
 *
 * The Agent's executeToolCall() wraps ToolRegistry.execute() and records
 * timing + outcome. This test exercises the same store-record contract
 * directly against the registry + store, which is what the agent does
 * under the hood.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRegistry } from '../../src/tools/registry.js';
import { currentTimeTool, memorySearchTool, memoryStoreTool } from '../../src/tools/builtin.js';
import { ToolOutcomeStore } from '../../src/observability/tool-outcome-store.js';
import Database from 'better-sqlite3';
import { LongTermMemoryStore } from '../../src/memory/longterm.js';

let store: ToolOutcomeStore;

beforeEach(() => {
  store = ToolOutcomeStore.__createForTest();
}, 30_000);

/** Minimal in-memory long-term store factory using better-sqlite3 :memory:.
 *  Mirrors what the Agent does for tests. */
function makeMemoryStore(): LongTermMemoryStore {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE IF NOT EXISTS long_term_memory (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      embedding BLOB,
      tags TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    );
  `);
  return new LongTermMemoryStore(db);
}

describe('Tool outcome recording through ToolRegistry', () => {
  it('current_time succeeds and gets recorded', async () => {
    const reg = new ToolRegistry();
    reg.register(currentTimeTool);
    const agent = { getLongTermMemory: () => makeMemoryStore() };
    // Mirror what Agent.executeToolCall() does — time + record outcome.
    const t0 = Date.now();
    const result = await reg.execute('current_time', {}, { sessionId: 's', agent: agent as never });
    store.record('current_time', result, Date.now() - t0);

    expect(store.size()).toBe(1);
    const o = store.recent(1)[0]!;
    expect(o.toolName).toBe('current_time');
    expect(o.success).toBe(true);
    expect(o.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('memory_store + memory_search round-trip get recorded as successes', async () => {
    const reg = new ToolRegistry();
    reg.register(memoryStoreTool);
    reg.register(memorySearchTool);
    const ltm = makeMemoryStore();
    const agent = { getLongTermMemory: () => ltm };

    const sentinel = `__test_sentinel_${Date.now()}`;

    const t0 = Date.now();
    const storeRes = await reg.execute('memory_store', { content: sentinel, tags: ['probe'] }, { sessionId: 's', agent: agent as never });
    store.record('memory_store', storeRes, Date.now() - t0);

    const t1 = Date.now();
    const searchRes = await reg.execute('memory_search', { query: sentinel }, { sessionId: 's', agent: agent as never });
    store.record('memory_search', searchRes, Date.now() - t1);

    expect(storeRes).toContain('[memory_store ok]');
    expect(searchRes).toContain('match');
    expect(searchRes).toContain(sentinel);

    expect(store.size()).toBe(2);
    const rel = store.reliability();
    const a = rel.find(r => r.toolName === 'memory_store')!;
    const b = rel.find(r => r.toolName === 'memory_search')!;
    expect(a.successRate).toBe(1);
    expect(b.successRate).toBe(1);
  });

  it('a tool returning an error-prefixed string is recorded as failure', async () => {
    const reg = new ToolRegistry();
    reg.register(memoryStoreTool);
    // Agent without getLongTermMemory triggers the [memory_store error] branch.
    const agent = {};
    const t0 = Date.now();
    const result = await reg.execute('memory_store', { content: 'x' }, { sessionId: 's', agent: agent as never });
    store.record('memory_store', result, Date.now() - t0);

    expect(result).toContain('[memory_store error]');
    const o = store.recent(1)[0]!;
    expect(o.success).toBe(false);
    expect(o.failureReason).toBeTruthy();
  });
});
