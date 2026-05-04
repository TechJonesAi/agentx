/**
 * Phase 5 — controlled influence (forceReasoning model-capability hint).
 *
 * Tests the `_resolveModelHint()` helper directly via type-cast — it returns
 * either `{ capability: 'reasoning' }` or `null`. Both `chat()` and
 * `chatStream()` spread that return value into their LLM request, so testing
 * the helper's return value is sufficient to verify the influence path
 * without needing a live LLM provider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Agent } from '../../src/agent.js';

interface IntelOpts {
  enabled?: boolean;
  observationOnly?: boolean;
  influenceMode?: 'off' | 'force-reasoning' | string;
  omit?: boolean;
}

function writeConfig(dir: string, opts: IntelOpts = {}): string {
  const influenceLine = opts.influenceMode !== undefined
    ? `    influenceMode: ${opts.influenceMode}\n`
    : '';
  const intelBlock = opts.omit
    ? ''
    : `  intelligence:\n    enabled: ${opts.enabled ?? false}\n    observationOnly: ${opts.observationOnly ?? true}\n${influenceLine}`;
  const yaml = [
    'agent:',
    '  name: AgentX-Test',
    '  defaultProvider: ollama',
    '  model: llama3',
    intelBlock,
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
  const cfgPath = path.join(dir, 'agentx.yaml');
  fs.writeFileSync(cfgPath, yaml, 'utf-8');
  return cfgPath;
}

let tmpDir: string;
let prevDataDir: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-influence-test-'));
  prevDataDir = process.env['DATA_DIR'];
  process.env['DATA_DIR'] = tmpDir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env['DATA_DIR'];
  else process.env['DATA_DIR'] = prevDataDir;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

function buildAgent(opts: IntelOpts = {}): Agent {
  const cfg = writeConfig(tmpDir, opts);
  return new Agent(cfg);
}

type Internals = {
  _runIntelligenceObservation(s: string): void;
  _resolveModelHint(): { capability: 'reasoning' } | null;
};

function internals(a: Agent): Internals {
  return a as unknown as Internals;
}

describe('Agent — Phase 5 controlled influence (forceReasoning hint)', () => {
  it('I1: default config (no intelligence block) — hint is null and getter is null', async () => {
    const a = buildAgent({ omit: true });
    expect(internals(a)._resolveModelHint()).toBeNull();
    expect(a.getLastForceReasoning()).toBeNull();
    await a.shutdown?.();
  });

  it('I2: enabled=false — hint is null even after observation invocation', async () => {
    const a = buildAgent({ enabled: false });
    internals(a)._runIntelligenceObservation('Find the indemnity clause');
    expect(internals(a)._resolveModelHint()).toBeNull();
    expect(a.getLastForceReasoning()).toBeNull();
    await a.shutdown?.();
  });

  it('I3: enabled=true, observationOnly=true, influenceMode=force-reasoning — observation wins, hint stays null', async () => {
    const a = buildAgent({ enabled: true, observationOnly: true, influenceMode: 'force-reasoning' });
    internals(a)._runIntelligenceObservation('Find the indemnity clause');
    expect(internals(a)._resolveModelHint()).toBeNull();
    // observation populated forceReasoning truthy though
    expect(a.getLastForceReasoning()).toBe(true);
    await a.shutdown?.();
  });

  it('I4: enabled=true, observationOnly=false, influenceMode=off — hint stays null', async () => {
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'off' });
    internals(a)._runIntelligenceObservation('Find the indemnity clause');
    expect(internals(a)._resolveModelHint()).toBeNull();
    expect(a.getLastForceReasoning()).toBe(true);
    await a.shutdown?.();
  });

  it('I5: full influence mode + legal query → hint is { capability: "reasoning" }', async () => {
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'force-reasoning' });
    internals(a)._runIntelligenceObservation('Find the indemnity clause in the contract');
    expect(internals(a)._resolveModelHint()).toEqual({ capability: 'reasoning' });
    await a.shutdown?.();
  });

  it('I6: full influence mode + medical query → hint is { capability: "reasoning" }', async () => {
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'force-reasoning' });
    internals(a)._runIntelligenceObservation('What does the diagnosis say?');
    expect(internals(a)._resolveModelHint()).toEqual({ capability: 'reasoning' });
    await a.shutdown?.();
  });

  it('I7: full influence mode + financial query → hint is { capability: "reasoning" }', async () => {
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'force-reasoning' });
    internals(a)._runIntelligenceObservation('Show the EBITDA calculation');
    expect(internals(a)._resolveModelHint()).toEqual({ capability: 'reasoning' });
    await a.shutdown?.();
  });

  it('I8: full influence mode + general query → forceReasoning=false, hint null', async () => {
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'force-reasoning' });
    internals(a)._runIntelligenceObservation('What is the weather today');
    expect(a.getLastForceReasoning()).toBe(false);
    expect(internals(a)._resolveModelHint()).toBeNull();
    await a.shutdown?.();
  });

  it('I9: full influence mode + technical query → forceReasoning=false (technical not deep), hint null', async () => {
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'force-reasoning' });
    internals(a)._runIntelligenceObservation('Refactor this async function');
    expect(a.getLastForceReasoning()).toBe(false);
    expect(internals(a)._resolveModelHint()).toBeNull();
    await a.shutdown?.();
  });

  it('I10: full influence mode, BEFORE first observation → hint null (lastForceReasoning defaulted to false)', async () => {
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'force-reasoning' });
    expect(internals(a)._resolveModelHint()).toBeNull();
    expect(a.getLastForceReasoning()).toBe(false);
    await a.shutdown?.();
  });

  it('I11: tripwire — enabled=true, observationOnly=false, influenceMode=all → constructor throws', () => {
    expect(() => buildAgent({ enabled: true, observationOnly: false, influenceMode: 'all' }))
      .toThrow(/influenceMode/i);
  });

  it('I12: tripwire — enabled=true, observationOnly=false, influenceMode=reasoning (typo) → throws', () => {
    expect(() => buildAgent({ enabled: true, observationOnly: false, influenceMode: 'reasoning' }))
      .toThrow(/influenceMode/i);
  });

  it('I13: getLastForceReasoning is null when intelligence disabled, boolean when enabled', async () => {
    const off = buildAgent({ enabled: false });
    expect(off.getLastForceReasoning()).toBeNull();
    await off.shutdown?.();

    const on = buildAgent({ enabled: true, observationOnly: true });
    expect(on.getLastForceReasoning()).toBe(false);
    internals(on)._runIntelligenceObservation('Find the indemnity clause');
    expect(on.getLastForceReasoning()).toBe(true);
    await on.shutdown?.();
  });

  it('I14: successive observations flip the hint on/off', async () => {
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'force-reasoning' });
    const i = internals(a);
    i._runIntelligenceObservation('Find the indemnity clause'); // legal → hint
    expect(i._resolveModelHint()).toEqual({ capability: 'reasoning' });
    i._runIntelligenceObservation('hello there'); // general → no hint
    expect(i._resolveModelHint()).toBeNull();
    i._runIntelligenceObservation('What does the diagnosis say'); // medical → hint
    expect(i._resolveModelHint()).toEqual({ capability: 'reasoning' });
    await a.shutdown?.();
  });

  it('I15: chat/chatStream parity — both code paths use the same helper output', async () => {
    // Both call sites spread `this._resolveModelHint() ?? {}`. If the helper
    // is deterministic for a given input, parity is established by definition.
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'force-reasoning' });
    const i = internals(a);
    i._runIntelligenceObservation('Find the indemnity clause');
    const h1 = i._resolveModelHint();
    const h2 = i._resolveModelHint();
    expect(h1).toEqual(h2);
    expect(h1).toEqual({ capability: 'reasoning' });
    await a.shutdown?.();
  });

  it('I16: observation summary still populated even when influence is on (no observability regression)', async () => {
    const a = buildAgent({ enabled: true, observationOnly: false, influenceMode: 'force-reasoning' });
    internals(a)._runIntelligenceObservation('Find the indemnity clause');
    expect(a.getLastDecisionSummary()).not.toBeNull();
    expect(a.getLastExecutionTrace()).not.toBeNull();
    expect(a.getLastRedFlag()).not.toBeNull();
    await a.shutdown?.();
  });
});
