/**
 * R8 — env-override hardening tests.
 *
 * Verifies that:
 *   - parseBoolEnv accepts the documented truthy / falsy forms and
 *     returns undefined for any other value (so invalid forms fail closed)
 *   - applyEnvOverrides respects the env vars
 *   - loadConfig() with an empty (default) yaml returns retrieval/entity
 *     indexing disabled
 *   - env override flips them on/off
 *   - garbage env values do not enable the feature
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  parseBoolEnv,
  applyEnvOverrides,
  loadConfig,
} from '../../src/config.js';
import type { AgentConfig } from '../../src/types.js';

function baseConfig(): AgentConfig {
  return {
    agent: {
      name: 'test',
      defaultProvider: 'ollama',
      model: 'llama3',
    },
    providers: {},
    memory: { maxConversationHistory: 10, summarizeAfter: 5, embeddingProvider: 'local' },
    sessions: { persistToDisk: false, ttlMinutes: 60 },
    skills: { directory: './skills', autoReload: false },
    browser: { headless: true, timeout: 30000 },
    health: { enabled: false, port: 9090 },
  } as unknown as AgentConfig;
}

const ENV_KEYS = ['AGENT_RETRIEVAL_ENABLED', 'AGENT_ENTITY_INDEXING_ENABLED'] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('parseBoolEnv — accepted forms', () => {
  it.each(['true', 'TRUE', 'True', '1', 'yes', 'YES', 'on', 'On'])('"%s" → true', (v) => {
    expect(parseBoolEnv(v)).toBe(true);
  });

  it.each(['false', 'FALSE', '0', 'no', 'NO', 'off', 'OFF'])('"%s" → false', (v) => {
    expect(parseBoolEnv(v)).toBe(false);
  });

  it.each(['', '   ', 'maybe', 'enable', '2', 'on-call', 'TruE!'])('invalid "%s" → undefined', (v) => {
    expect(parseBoolEnv(v)).toBeUndefined();
  });

  it('undefined input → undefined', () => {
    expect(parseBoolEnv(undefined)).toBeUndefined();
  });
});

describe('applyEnvOverrides — retrieval', () => {
  it('AGENT_RETRIEVAL_ENABLED=true enables retrieval (overrides default)', () => {
    process.env.AGENT_RETRIEVAL_ENABLED = 'true';
    const cfg = baseConfig();
    cfg.agent.retrieval = { enabled: false };
    const out = applyEnvOverrides(cfg);
    expect(out.agent.retrieval?.enabled).toBe(true);
  });

  it('AGENT_RETRIEVAL_ENABLED=false explicitly disables (overrides yaml=true)', () => {
    process.env.AGENT_RETRIEVAL_ENABLED = 'false';
    const cfg = baseConfig();
    cfg.agent.retrieval = { enabled: true };
    const out = applyEnvOverrides(cfg);
    expect(out.agent.retrieval?.enabled).toBe(false);
  });

  it('AGENT_RETRIEVAL_ENABLED=garbage does not override (yaml value preserved)', () => {
    process.env.AGENT_RETRIEVAL_ENABLED = 'kindof';
    const cfg = baseConfig();
    cfg.agent.retrieval = { enabled: false };
    const out = applyEnvOverrides(cfg);
    expect(out.agent.retrieval?.enabled).toBe(false);
  });

  it('AGENT_RETRIEVAL_ENABLED unset preserves yaml value', () => {
    delete process.env.AGENT_RETRIEVAL_ENABLED;
    const cfg = baseConfig();
    cfg.agent.retrieval = { enabled: true };
    const out = applyEnvOverrides(cfg);
    expect(out.agent.retrieval?.enabled).toBe(true);
  });

  it('creates the retrieval block if absent when env enables', () => {
    process.env.AGENT_RETRIEVAL_ENABLED = 'true';
    const cfg = baseConfig();
    expect(cfg.agent.retrieval).toBeUndefined();
    const out = applyEnvOverrides(cfg);
    expect(out.agent.retrieval?.enabled).toBe(true);
  });
});

describe('applyEnvOverrides — entityIndexing', () => {
  it('AGENT_ENTITY_INDEXING_ENABLED=true enables', () => {
    process.env.AGENT_ENTITY_INDEXING_ENABLED = 'yes';
    const cfg = baseConfig();
    const out = applyEnvOverrides(cfg);
    expect(out.agent.entityIndexing?.enabled).toBe(true);
  });

  it('AGENT_ENTITY_INDEXING_ENABLED=garbage does not enable', () => {
    process.env.AGENT_ENTITY_INDEXING_ENABLED = 'sure-why-not';
    const cfg = baseConfig();
    cfg.agent.entityIndexing = { enabled: false };
    const out = applyEnvOverrides(cfg);
    expect(out.agent.entityIndexing?.enabled).toBe(false);
  });

  it('AGENT_ENTITY_INDEXING_ENABLED=0 disables', () => {
    process.env.AGENT_ENTITY_INDEXING_ENABLED = '0';
    const cfg = baseConfig();
    cfg.agent.entityIndexing = { enabled: true };
    const out = applyEnvOverrides(cfg);
    expect(out.agent.entityIndexing?.enabled).toBe(false);
  });
});

describe('loadConfig + env overrides — end-to-end', () => {
  let tmp: string;
  let cfgFile: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-r8-'));
    cfgFile = path.join(tmp, 'agentx.yaml');
    fs.writeFileSync(cfgFile, [
      'agent:',
      '  name: t',
      '  defaultProvider: ollama',
      '  model: llama3',
      '  retrieval:',
      '    enabled: false',
      '  entityIndexing:',
      '    enabled: false',
      '',
    ].join('\n'), 'utf-8');
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('default yaml + no env: both flags false', () => {
    const cfg = loadConfig(cfgFile);
    expect(cfg.agent.retrieval?.enabled).toBe(false);
    expect(cfg.agent.entityIndexing?.enabled).toBe(false);
  });

  it('AGENT_RETRIEVAL_ENABLED=true flips retrieval on, entity indexing remains off', () => {
    process.env.AGENT_RETRIEVAL_ENABLED = 'true';
    const cfg = loadConfig(cfgFile);
    expect(cfg.agent.retrieval?.enabled).toBe(true);
    expect(cfg.agent.entityIndexing?.enabled).toBe(false);
  });

  it('AGENT_ENTITY_INDEXING_ENABLED=1 flips entity indexing on independently', () => {
    process.env.AGENT_ENTITY_INDEXING_ENABLED = '1';
    const cfg = loadConfig(cfgFile);
    expect(cfg.agent.retrieval?.enabled).toBe(false);
    expect(cfg.agent.entityIndexing?.enabled).toBe(true);
  });

  it('both env vars set independently flip both flags', () => {
    process.env.AGENT_RETRIEVAL_ENABLED = 'true';
    process.env.AGENT_ENTITY_INDEXING_ENABLED = 'on';
    const cfg = loadConfig(cfgFile);
    expect(cfg.agent.retrieval?.enabled).toBe(true);
    expect(cfg.agent.entityIndexing?.enabled).toBe(true);
  });

  it('invalid env values fail closed — features remain disabled', () => {
    process.env.AGENT_RETRIEVAL_ENABLED = 'yeah-maybe';
    process.env.AGENT_ENTITY_INDEXING_ENABLED = '';
    const cfg = loadConfig(cfgFile);
    expect(cfg.agent.retrieval?.enabled).toBe(false);
    expect(cfg.agent.entityIndexing?.enabled).toBe(false);
  });

  it('env=false overrides yaml=true (explicit disable)', () => {
    fs.writeFileSync(cfgFile, [
      'agent:',
      '  name: t',
      '  defaultProvider: ollama',
      '  model: llama3',
      '  retrieval:',
      '    enabled: true',
      '  entityIndexing:',
      '    enabled: true',
      '',
    ].join('\n'), 'utf-8');
    process.env.AGENT_RETRIEVAL_ENABLED = 'false';
    process.env.AGENT_ENTITY_INDEXING_ENABLED = 'no';
    const cfg = loadConfig(cfgFile);
    expect(cfg.agent.retrieval?.enabled).toBe(false);
    expect(cfg.agent.entityIndexing?.enabled).toBe(false);
  });
});

describe('repository default.yaml ships the cognitive layer ON (P13-A1)', () => {
  it('repo config/default.yaml enables retrieval + entityIndexing', () => {
    // P13-A1 Activation: the cognitive layer (retrieval + entity
    // indexing) is the product — it ships ENABLED. This test pins the
    // new default so it can't silently regress to OFF.
    const repoYaml = fs.readFileSync(
      path.join(__dirname, '..', '..', '..', '..', 'config', 'default.yaml'),
      'utf-8',
    );
    expect(repoYaml).toMatch(/retrieval:\s*\n\s*enabled:\s*true/);
    expect(repoYaml).toMatch(/entityIndexing:\s*\n\s*enabled:\s*true/);
  });
});
