/**
 * Batch A2 — localOnly cloud-provider guard.
 *
 * The agent's createProvider() must refuse to construct cloud providers
 * (anthropic, openai) when config.agent.localOnly === true. ollama is
 * always permitted. This is the second layer of the private-memory-first
 * policy (the first is the tool-fallback gate).
 */
import { describe, it, expect } from 'vitest';
import { createProvider } from '../../src/llm/index.js';
import type { AgentConfig } from '../../src/types.js';

function baseCfg(opts: { localOnly?: boolean } = {}): AgentConfig {
  return {
    agent: {
      name: 'X', defaultProvider: 'ollama', model: 'llama3',
      ...(opts.localOnly !== undefined ? { localOnly: opts.localOnly } : {}),
    },
    providers: {
      anthropic: { model: 'claude-sonnet-4', maxTokens: 4096 },
      openai: { model: 'gpt-4o', maxTokens: 4096 },
      ollama: { model: 'llama3', baseUrl: 'http://localhost:11434' },
    },
  } as AgentConfig;
}

describe('createProvider — localOnly guard', () => {
  it('ollama is always permitted (localOnly default off)', () => {
    expect(() => createProvider('ollama', baseCfg())).not.toThrow();
  });

  it('ollama is permitted when localOnly=true', () => {
    expect(() => createProvider('ollama', baseCfg({ localOnly: true }))).not.toThrow();
  });

  it('anthropic is permitted when localOnly=false (default)', () => {
    expect(() => createProvider('anthropic', baseCfg())).not.toThrow();
  });

  it('openai is permitted when localOnly=false (default)', () => {
    expect(() => createProvider('openai', baseCfg())).not.toThrow();
  });

  it('anthropic is REJECTED when localOnly=true', () => {
    expect(() => createProvider('anthropic', baseCfg({ localOnly: true })))
      .toThrow(/localOnly is enabled.*anthropic/);
  });

  it('openai is REJECTED when localOnly=true', () => {
    expect(() => createProvider('openai', baseCfg({ localOnly: true })))
      .toThrow(/localOnly is enabled.*openai/);
  });

  it('error message names the env override the user can flip', () => {
    let msg = '';
    try { createProvider('openai', baseCfg({ localOnly: true })); }
    catch (e) { msg = e instanceof Error ? e.message : String(e); }
    expect(msg).toContain('AGENTX_LOCAL_ONLY');
  });
});
