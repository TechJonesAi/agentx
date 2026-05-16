/**
 * Validation scenario registry — Batch 3.
 */
import { describe, it, expect } from 'vitest';
import { SCENARIOS, runScenario, runAllScenarios } from '../../src/observability/validation-scenarios.js';

function fakeAgent() {
  const items: Array<{ id: string; content: string; tags: string[] }> = [];
  return {
    getLongTermMemory: () => ({
      store(c: string, t?: string[]) {
        const id = `id-${Math.random()}`;
        items.push({ id, content: c, tags: t ?? [] });
        return id;
      },
      searchByContent(q: string) { return items.filter(x => x.content.includes(q)); },
    }),
    getToolRegistry: () => ({ getDefinitions: () => [] }),
    getConfig: () => ({ agent: { defaultProvider: 'ollama', model: 'm' }, providers: { ollama: { model: 'm' } } }),
  };
}

describe('Validation scenarios registry', () => {
  it('has at least 5 scenarios', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(5);
  });

  it('scenario names are unique', () => {
    const names = SCENARIOS.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });
});

describe('runAllScenarios', () => {
  it('runs every scenario against a fake agent and returns pass/fail for each', async () => {
    const results = await runAllScenarios(fakeAgent());
    expect(results).toHaveLength(SCENARIOS.length);
    for (const r of results) {
      expect(typeof r.pass).toBe('boolean');
      expect(typeof r.detail).toBe('string');
      expect(typeof r.durationMs).toBe('number');
    }
  });

  it('all scenarios pass against a working fake agent', async () => {
    const results = await runAllScenarios(fakeAgent());
    const failed = results.filter((r) => !r.pass);
    expect(failed, JSON.stringify(failed)).toEqual([]);
  });
});

describe('runScenario (single)', () => {
  it('reports not-found for unknown name', async () => {
    const r = await runScenario('does-not-exist', fakeAgent());
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('not found');
  });

  it('returns the expected pass for "Task classifier — coding pattern detected"', async () => {
    const r = await runScenario('Task classifier — coding pattern detected', fakeAgent());
    expect(r.pass).toBe(true);
  });

  it('catches a throwing scenario without crashing', async () => {
    // Inject a scenario that throws — we manipulate the registry via runScenario's
    // contract: it looks up by name. Easier: validate the existing handling
    // by running a known scenario name against a stub that breaks the assumed
    // agent shape.
    const r = await runScenario('Long-term memory round-trip (sentinel)', { /* no getLongTermMemory */ } as never);
    expect(r.pass).toBe(false);
    expect(r.detail).toContain('not available');
  });
});
