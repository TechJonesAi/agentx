/**
 * Phase 4 — Intelligence observation wiring tests.
 *
 * These tests construct a real Agent with an isolated DATA_DIR and a
 * stub config (Ollama provider, never invoked since we don't call chat()).
 * They directly invoke the private observation helper via type-cast to
 * verify wiring without requiring an LLM.
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-intel-test-'));
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

describe('Agent — intelligence observation (Phase 4)', () => {
  it('T1: default config (no intelligence block) — agent constructs; getters all return null', async () => {
    const a = buildAgent({ omit: true });
    expect(a.getLastDecisionSummary()).toBeNull();
    expect(a.getLastExecutionTrace()).toBeNull();
    expect(a.getLastRedFlag()).toBeNull();
    await a.shutdown?.();
  });

  it('T2: enabled=false — getLastDecisionSummary() returns null', async () => {
    const a = buildAgent({ enabled: false, observationOnly: true });
    expect(a.getLastDecisionSummary()).toBeNull();
    await a.shutdown?.();
  });

  it('T3: enabled=false — getLastExecutionTrace() returns null', async () => {
    const a = buildAgent({ enabled: false, observationOnly: true });
    expect(a.getLastExecutionTrace()).toBeNull();
    await a.shutdown?.();
  });

  it('T4: enabled=true, observationOnly=false, unsupported influenceMode — constructor throws', () => {
    // Phase 5 relaxed the Phase 4 throw: observationOnly=false now allowed when
    // influenceMode is 'off' or 'force-reasoning'. Any other mode still throws.
    expect(() => buildAgent({ enabled: true, observationOnly: false, influenceMode: 'all' as never }))
      .toThrow(/influenceMode/i);
  });

  it('T5: enabled=true, observationOnly=true — getters return null BEFORE first invocation', async () => {
    const a = buildAgent({ enabled: true, observationOnly: true });
    expect(a.getLastDecisionSummary()).toBeNull();
    expect(a.getLastExecutionTrace()).toBeNull();
    expect(a.getLastRedFlag()).toBeNull();
    await a.shutdown?.();
  });

  it('T6: observation populates a DecisionSummary with shape fields', async () => {
    const a = buildAgent({ enabled: true, observationOnly: true });
    (a as unknown as { _runIntelligenceObservation(s: string): void })._runIntelligenceObservation('hello there');
    const s = a.getLastDecisionSummary();
    expect(s).not.toBeNull();
    expect(s!.strategy).toBeDefined();
    expect(s!.resolvedDomain).toBeDefined();
    expect(typeof s!.confidence).toBe('number');
    await a.shutdown?.();
  });

  it('T7: observation populates an ExecutionTrace reflecting the degenerate knowledge stub', async () => {
    const a = buildAgent({ enabled: true, observationOnly: true });
    (a as unknown as { _runIntelligenceObservation(s: string): void })._runIntelligenceObservation('hello there');
    const t = a.getLastExecutionTrace();
    expect(t).not.toBeNull();
    expect(t!.knowledge.hasKnowledge).toBe(false);
    expect(t!.knowledge.docChunkCount).toBe(0);
    expect(t!.knowledge.retrievalFailed).toBe(false);
    await a.shutdown?.();
  });

  it('T8: benign query — getLastRedFlag() returns {isRedFlag:false, reason:null}', async () => {
    const a = buildAgent({ enabled: true, observationOnly: true });
    (a as unknown as { _runIntelligenceObservation(s: string): void })._runIntelligenceObservation('what is the weather today');
    expect(a.getLastRedFlag()).toEqual({ isRedFlag: false, reason: null });
    await a.shutdown?.();
  });

  it('T9: medical red-flag query — getLastRedFlag() returns matched keyword', async () => {
    const a = buildAgent({ enabled: true, observationOnly: true });
    (a as unknown as { _runIntelligenceObservation(s: string): void })._runIntelligenceObservation('I have chest pain');
    expect(a.getLastRedFlag()).toEqual({ isRedFlag: true, reason: 'chest pain' });
    await a.shutdown?.();
  });

  it('T10: legal red-flag query — court order detected', async () => {
    const a = buildAgent({ enabled: true, observationOnly: true });
    (a as unknown as { _runIntelligenceObservation(s: string): void })._runIntelligenceObservation('A court order was served');
    expect(a.getLastRedFlag()).toEqual({ isRedFlag: true, reason: 'court order' });
    await a.shutdown?.();
  });

  it('T11: successive invocations overwrite the last summary (last writer wins)', async () => {
    const a = buildAgent({ enabled: true, observationOnly: true });
    const run = (a as unknown as { _runIntelligenceObservation(s: string): void })._runIntelligenceObservation.bind(a);
    run('I have chest pain');
    expect(a.getLastRedFlag()!.reason).toBe('chest pain');
    run('hello there');
    expect(a.getLastRedFlag()).toEqual({ isRedFlag: false, reason: null });
    await a.shutdown?.();
  });

  it('T12: when disabled, _runIntelligenceObservation is a no-op (getters stay null)', async () => {
    const a = buildAgent({ enabled: false, observationOnly: true });
    (a as unknown as { _runIntelligenceObservation(s: string): void })._runIntelligenceObservation('I have chest pain');
    expect(a.getLastDecisionSummary()).toBeNull();
    expect(a.getLastExecutionTrace()).toBeNull();
    expect(a.getLastRedFlag()).toBeNull();
    await a.shutdown?.();
  });
});
