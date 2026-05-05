/**
 * R11 — agent feedback integration tests.
 *
 * Verifies:
 *   - agent.recordFeedback persists upvote / downvote
 *   - retrieval metadata is included when present
 *   - feedback works with retrieval ON or OFF
 *   - validation throws on bad payload (so the API layer can return 400)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent.js';

interface AgentOpts { retrieval?: { enabled: boolean }; omit?: boolean; }

function writeConfig(dir: string, opts: AgentOpts = {}): string {
  const block = opts.omit ? '' : opts.retrieval ? `  retrieval:\n    enabled: ${opts.retrieval.enabled}\n` : '';
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r11-'));
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

describe('R11 — agent.recordFeedback works regardless of retrieval flag', () => {
  it('retrieval flag absent (default) — feedback still persists', async () => {
    const agent = buildAgent({ omit: true });
    const r = agent.recordFeedback({
      messageId: 'm1', userQuery: 'hi', assistantResponse: 'hello', rating: 'up',
    });
    expect(r.feedbackId).toBeDefined();
    expect(agent.feedbackCount()).toBe(1);
    await agent.shutdown?.();
  });

  it('retrieval flag false — feedback still persists', async () => {
    const agent = buildAgent({ retrieval: { enabled: false } });
    const r = agent.recordFeedback({
      messageId: 'm1', userQuery: 'hi', assistantResponse: 'hello', rating: 'down',
      comment: 'incorrect',
    });
    expect(r.rating).toBe('down');
    expect(r.comment).toBe('incorrect');
    expect(agent.feedbackCount()).toBe(1);
    await agent.shutdown?.();
  });

  it('retrieval flag true — feedback persists with retrieval metadata', async () => {
    const agent = buildAgent({ retrieval: { enabled: true } });
    const r = agent.recordFeedback({
      messageId: 'm1',
      userQuery: 'show all references to robert moyes',
      assistantResponse: 'here are the references',
      rating: 'up',
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'entity',
      retrievalMatchCount: 8,
      retrievalDocumentIds: ['doc-1', 'doc-2', 'doc-3'],
      sessionId: 'sess-7',
    });
    expect(r.retrievalIntent).toBe('EXACT_SEARCH');
    expect(r.retrievalSource).toBe('entity');
    expect(r.retrievalMatchCount).toBe(8);
    expect(r.retrievalDocumentIds).toEqual(['doc-1', 'doc-2', 'doc-3']);
    await agent.shutdown?.();
  });
});

describe('R11 — listFeedback returns recorded entries', () => {
  it('lists records newest-first', async () => {
    const agent = buildAgent({ omit: true });
    agent.recordFeedback({ messageId: 'm1', userQuery: 'q1', assistantResponse: 'a1', rating: 'up' });
    agent.recordFeedback({ messageId: 'm2', userQuery: 'q2', assistantResponse: 'a2', rating: 'down', comment: 'why' });
    const list = agent.listFeedback();
    expect(list.length).toBe(2);
    expect(list[0].messageId).toBe('m2');
    expect(list[0].rating).toBe('down');
    expect(list[0].comment).toBe('why');
    expect(list[1].messageId).toBe('m1');
    await agent.shutdown?.();
  });
});

describe('R11 — validation rejects bad payloads', () => {
  it('throws on missing required field', () => {
    const agent = buildAgent({ omit: true });
    expect(() => agent.recordFeedback({
      messageId: '',
      userQuery: 'q',
      assistantResponse: 'a',
      rating: 'up',
    })).toThrow();
    agent.shutdown?.();
  });

  it('throws on invalid rating', () => {
    const agent = buildAgent({ omit: true });
    expect(() => agent.recordFeedback({
      messageId: 'm', userQuery: 'q', assistantResponse: 'a',
      rating: 'meh' as never,
    })).toThrow();
    agent.shutdown?.();
  });

  it('agent constructor still works with no flags set (feedback always available)', () => {
    const agent = buildAgent({ omit: true });
    expect(agent.feedbackCount()).toBe(0);
    agent.shutdown?.();
  });
});
