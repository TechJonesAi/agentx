/**
 * ModelRoutingEngine — Batch 6D telemetry-driven demotion.
 *
 * When reliabilityAware is true and a pinned/preferred model has bad
 * recent telemetry, the engine must skip it and record the reason in
 * the fallbackChain.
 */
import { describe, it, expect } from 'vitest';
import { decideRoute } from '../../src/observability/model-routing-engine.js';
import type { RoutingInputs } from '../../src/observability/model-routing-engine.js';

const base: RoutingInputs = {
  classification: { primary: 'chat', confidence: 0.7, signals: [] },
  defaultProvider: 'ollama',
  defaultModel: 'default-model',
  pins: {},
  preferredModels: [],
  disabledModels: [],
  localOnly: false,
  installedLocalModels: [],
  reliabilityAware: true,
  perModelHealth: {},
  slowThresholdMs: 1000,
  minCallsForDemotion: 3,
};

describe('decideRoute — telemetry demotion', () => {
  it('demotes a pinned model when p95 exceeds threshold', () => {
    const d = decideRoute({
      ...base,
      pins: { chat: 'slow-pin' },
      preferredModels: ['fast-alt'],
      perModelHealth: {
        'ollama:slow-pin': { totalCalls: 10, p95LatencyMs: 5000, successRate: 1 },
        'ollama:fast-alt': { totalCalls: 10, p95LatencyMs: 200, successRate: 1 },
      },
    });
    expect(d.model).toBe('fast-alt');
    expect(d.pinUsed).toBe(false);
    expect(d.fallbackChain[0]?.model).toBe('slow-pin');
    expect(d.fallbackChain[0]?.skipped).toContain('telemetry');
    expect(d.fallbackChain[0]?.skipped).toContain('p95');
  });

  it('demotes a preferred model when successRate drops below 0.5', () => {
    const d = decideRoute({
      ...base,
      preferredModels: ['flaky', 'reliable'],
      perModelHealth: {
        'ollama:flaky': { totalCalls: 10, p95LatencyMs: 100, successRate: 0.3 },
        'ollama:reliable': { totalCalls: 10, p95LatencyMs: 100, successRate: 1 },
      },
    });
    expect(d.model).toBe('reliable');
    expect(d.fallbackChain.some(f => f.model === 'flaky' && f.skipped.includes('successRate'))).toBe(true);
  });

  it('does NOT demote below minCallsForDemotion', () => {
    const d = decideRoute({
      ...base,
      pins: { chat: 'new-pin' },
      perModelHealth: {
        'ollama:new-pin': { totalCalls: 2, p95LatencyMs: 9999, successRate: 0 },
      },
    });
    // Only 2 calls — not enough samples; pin survives.
    expect(d.model).toBe('new-pin');
    expect(d.pinUsed).toBe(true);
  });

  it('does NOT demote when reliabilityAware is false', () => {
    const d = decideRoute({
      ...base,
      reliabilityAware: false,
      pins: { chat: 'slow' },
      perModelHealth: {
        'ollama:slow': { totalCalls: 100, p95LatencyMs: 99999, successRate: 0 },
      },
    });
    expect(d.model).toBe('slow');
  });

  it('Batch 8E — workflowReliability surfaces in the routing reason when default route fires', () => {
    const d = decideRoute({
      ...base,
      workflowReliability: { totalCompleted: 10, successRate: 0.4 },
    });
    expect(d.reason).toContain('workflow recent success 40%');
    expect(d.reason).toContain('over 10');
  });

  it('Batch 8E — no annotation when workflowReliability is null', () => {
    const d = decideRoute({ ...base, workflowReliability: null });
    expect(d.reason).not.toContain('workflow recent success');
  });

  it('falls back to default model when EVERY pin + preferred is demoted', () => {
    const d = decideRoute({
      ...base,
      pins: { chat: 'bad-pin' },
      preferredModels: ['bad-alt'],
      perModelHealth: {
        'ollama:bad-pin': { totalCalls: 10, p95LatencyMs: 9999, successRate: 1 },
        'ollama:bad-alt': { totalCalls: 10, p95LatencyMs: 9999, successRate: 1 },
      },
    });
    expect(d.model).toBe('default-model');
    expect(d.fallbackChain).toHaveLength(2);
  });
});
