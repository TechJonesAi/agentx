/**
 * ModelRoutingEngine unit tests — Batch 3.
 *
 * Each test exercises one rule of the priority cascade:
 *   1. Pin → win unless disabled or not local under localOnly.
 *   2. Preferred-models list (first surviving).
 *   3. Default model fallback (with localOnly correction).
 */
import { describe, it, expect } from 'vitest';
import { decideRoute } from '../../src/observability/model-routing-engine.js';
import type { RoutingInputs } from '../../src/observability/model-routing-engine.js';

const baseInputs: RoutingInputs = {
  classification: { primary: 'chat', confidence: 0.7, signals: [] },
  defaultProvider: 'ollama',
  defaultModel: 'qwen2.5-coder:32b',
  pins: {},
  preferredModels: [],
  disabledModels: [],
  localOnly: false,
  installedLocalModels: ['qwen2.5-coder:32b', 'llama3:8b'],
  reliabilityAware: false,
};

describe('ModelRoutingEngine — pin wins', () => {
  it('picks the pinned model for the classified task', () => {
    const d = decideRoute({ ...baseInputs, pins: { chat: 'pinned-A' } });
    expect(d.model).toBe('pinned-A');
    expect(d.pinUsed).toBe(true);
    expect(d.reason).toContain('pinned');
    expect(d.taskType).toBe('chat');
  });

  it('skips a pin that is in the disabled list', () => {
    const d = decideRoute({ ...baseInputs, pins: { chat: 'pinned-A' }, disabledModels: ['pinned-A'] });
    expect(d.model).not.toBe('pinned-A');
    expect(d.fallbackChain.some(f => f.model === 'pinned-A' && f.skipped === 'disabled')).toBe(true);
  });

  it('skips a pin not installed locally when localOnly=true and install list known', () => {
    const d = decideRoute({
      ...baseInputs,
      pins: { chat: 'pinned-X' },
      localOnly: true,
      installedLocalModels: ['llama3:8b'],
    });
    expect(d.model).not.toBe('pinned-X');
    expect(d.fallbackChain.some(f => f.skipped.includes('localOnly'))).toBe(true);
  });
});

describe('ModelRoutingEngine — preferred-list', () => {
  it('picks the first surviving preferred model', () => {
    const d = decideRoute({ ...baseInputs, preferredModels: ['preferred-B', 'preferred-C'] });
    expect(d.model).toBe('preferred-B');
    expect(d.reason).toContain('preferred-list');
    expect(d.pinUsed).toBe(false);
  });

  it('skips a disabled preferred and picks the next', () => {
    const d = decideRoute({ ...baseInputs, preferredModels: ['preferred-B', 'preferred-C'], disabledModels: ['preferred-B'] });
    expect(d.model).toBe('preferred-C');
  });
});

describe('ModelRoutingEngine — defaults', () => {
  it('returns the default when no pins or preferred', () => {
    const d = decideRoute(baseInputs);
    expect(d.model).toBe('qwen2.5-coder:32b');
    expect(d.reason).toContain('default');
  });

  it('falls back to first installed local model when localOnly and default not installed', () => {
    const d = decideRoute({
      ...baseInputs,
      defaultModel: 'some-cloud-model',
      localOnly: true,
      installedLocalModels: ['llama3:8b'],
    });
    expect(d.model).toBe('llama3:8b');
    expect(d.reason).toContain('localOnly fallback');
  });

  it('marks default-disabled in reason when default is in disabled list', () => {
    const d = decideRoute({ ...baseInputs, disabledModels: ['qwen2.5-coder:32b'] });
    expect(d.reason).toContain('disabled');
  });

  it('classification task surfaces in the decision', () => {
    const d = decideRoute({ ...baseInputs, classification: { primary: 'coding', confidence: 0.9, signals: ['code-pattern:coding'] } });
    expect(d.taskType).toBe('coding');
    expect(d.classificationConfidence).toBe(0.9);
  });
});
