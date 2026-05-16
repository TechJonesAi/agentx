/**
 * ValidationScenarios — Batch 3 real scenario runner.
 *
 * Each scenario is a self-contained named function returning a pass/fail
 * verdict with a free-text detail. Scenarios use only public agent APIs;
 * no network calls, no destructive side-effects.
 *
 * Registry is in-memory and population-by-import — to add a scenario,
 * append to the SCENARIOS array. Future batches can persist outcomes
 * to disk for regression-tracking; this batch keeps it in-memory.
 */

import { ToolOutcomeStore } from './tool-outcome-store.js';
import { RetrievalOutcomeStore } from './retrieval-outcome-store.js';
import { RuntimeSettingsStore } from './runtime-settings-store.js';
import { classifyTask } from './task-classifier.js';
import { decideRoute } from './model-routing-engine.js';

export interface ScenarioResult {
  name: string;
  pass: boolean;
  detail: string;
  durationMs: number;
}

export interface AgentLike {
  getLongTermMemory?: () => { store(c: string, t?: string[]): string; searchByContent(q: string, n?: number): Array<{ id: string }> };
  getToolRegistry?: () => { getDefinitions(): Array<{ name: string }> };
  getConfig?: () => { agent: { defaultProvider: string; model: string }; providers: Record<string, { model?: string }> };
}

export interface Scenario {
  name: string;
  run: (agent: AgentLike) => Promise<{ pass: boolean; detail: string }>;
}

/** Hard-coded scenario registry. Add one entry per real audit. */
export const SCENARIOS: Scenario[] = [
  {
    name: 'localOnly enforcement (settings)',
    run: async () => {
      // Toggling localOnly in the settings store must affect the in-memory
      // settings snapshot. The chatStream-time policy is privacy-default
      // OR — we only test the store mutation here; chatStream behaviour
      // is covered by private-memory-first integration tests.
      const tmp = '/tmp/agentx-validation-localOnly-' + Date.now() + '.json';
      const s = RuntimeSettingsStore.__createForTest(tmp);
      const before = s.getKey('localOnly');
      s.update({ localOnly: true });
      const after = s.getKey('localOnly');
      try { (await import('node:fs')).unlinkSync(tmp); } catch { /* */ }
      return { pass: before === false && after === true, detail: `before=${before} after=${after}` };
    },
  },
  {
    name: 'Settings persistence round-trip',
    run: async () => {
      const tmp = '/tmp/agentx-validation-settings-' + Date.now() + '.json';
      const s1 = RuntimeSettingsStore.__createForTest(tmp);
      s1.update({ modelPins: { chat: 'probe-model-X' } });
      const s2 = RuntimeSettingsStore.__createForTest(tmp);
      const pinned = s2.getKey('modelPins').chat;
      try { (await import('node:fs')).unlinkSync(tmp); } catch { /* */ }
      return { pass: pinned === 'probe-model-X', detail: `pinned=${pinned}` };
    },
  },
  {
    name: 'Task classifier — coding pattern detected',
    run: async () => {
      const c = classifyTask('Write a function in TypeScript that reverses a string.');
      return {
        pass: c.primary === 'coding' && c.confidence >= 0.5,
        detail: `primary=${c.primary} confidence=${c.confidence} signals=${c.signals.join(',')}`,
      };
    },
  },
  {
    name: 'Routing engine — pin wins over default',
    run: async () => {
      const d = decideRoute({
        classification: { primary: 'chat', confidence: 0.5, signals: [] },
        defaultProvider: 'ollama',
        defaultModel: 'default-model',
        pins: { chat: 'pinned-model-A' },
        preferredModels: [],
        disabledModels: [],
        localOnly: false,
        installedLocalModels: [],
        reliabilityAware: false,
      });
      return {
        pass: d.model === 'pinned-model-A' && d.pinUsed && d.reason.includes('pinned'),
        detail: `model=${d.model} pinUsed=${d.pinUsed} reason=${d.reason}`,
      };
    },
  },
  {
    name: 'Tool reliability — demotion fires after 6/10 failures',
    run: async () => {
      const store = ToolOutcomeStore.__createForTest();
      for (let i = 0; i < 4; i++) store.record('flaky', 'ok', 1);
      for (let i = 0; i < 6; i++) store.record('flaky', '[flaky error]: x', 1);
      const out = store.demotedTools({ window: 10, threshold: 0.5 });
      return {
        pass: out.length === 1 && out[0]?.toolName === 'flaky',
        detail: `demoted=${JSON.stringify(out)}`,
      };
    },
  },
  {
    name: 'Retrieval outcome — store records + reliability rolls up',
    run: async () => {
      const store = RetrievalOutcomeStore.__createForTest();
      store.record({ query: 'q', success: true, matchCount: 3, sufficient: true, fallbackUsed: false, latencyMs: 10, sourceTypes: ['fts'], groundedAnswer: true });
      store.record({ query: 'q', success: false, matchCount: 0, sufficient: false, fallbackUsed: false, latencyMs: 5, sourceTypes: [], groundedAnswer: false });
      const r = store.reliability();
      return {
        pass: r.totalCalls === 2 && r.successCount === 1,
        detail: `total=${r.totalCalls} success=${r.successCount} rate=${r.successRate}`,
      };
    },
  },
  {
    name: 'Long-term memory round-trip (sentinel)',
    run: async (agent) => {
      const ltm = agent.getLongTermMemory?.();
      if (!ltm) return { pass: false, detail: 'getLongTermMemory not available' };
      const sentinel = '__validation_scenario_' + Date.now();
      const id = ltm.store(sentinel, ['validation']);
      const hits = ltm.searchByContent(sentinel, 5);
      return {
        pass: hits.some((h: { id: string }) => h.id === id),
        detail: `id=${id} hits=${hits.length}`,
      };
    },
  },
];

export async function runScenario(name: string, agent: AgentLike): Promise<ScenarioResult> {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s) return { name, pass: false, detail: 'scenario not found', durationMs: 0 };
  const t0 = Date.now();
  try {
    const r = await s.run(agent);
    return { name, pass: r.pass, detail: r.detail, durationMs: Date.now() - t0 };
  } catch (e) {
    return {
      name,
      pass: false,
      detail: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - t0,
    };
  }
}

export async function runAllScenarios(agent: AgentLike): Promise<ScenarioResult[]> {
  const results: ScenarioResult[] = [];
  for (const s of SCENARIOS) {
    results.push(await runScenario(s.name, agent));
  }
  return results;
}
