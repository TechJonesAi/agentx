/**
 * ModelRoutingEngine — Batch 10 evidence-based provider promotion.
 *
 * Hard rules (mirror the prompt):
 *   - Ollama is the default until benchmark evidence proves otherwise.
 *   - Pins override evidence.
 *   - Evidence ONLY promotes when winner ∈ availableProviders.
 *   - Evidence ONLY promotes when reliabilityAware = true.
 *   - Promotion is recorded in fallbackChain + reason.
 */
import { describe, it, expect } from 'vitest';
import { decideRoute } from '../../src/observability/model-routing-engine.js';
import type { RoutingInputs } from '../../src/observability/model-routing-engine.js';

const base: RoutingInputs = {
  classification: { primary: 'tool-calling', confidence: 0.8, signals: [] },
  defaultProvider: 'ollama',
  defaultModel: 'qwen2.5-coder:32b',
  pins: {},
  preferredModels: [],
  disabledModels: [],
  localOnly: false,
  installedLocalModels: [],
  reliabilityAware: true,
  perModelHealth: {},
  providerEvidence: null,
  availableProviders: ['ollama'],
};

describe('decideRoute — provider evidence promotion', () => {
  it('NO evidence → Ollama remains default (verbatim rule)', () => {
    const d = decideRoute({ ...base, providerEvidence: null });
    expect(d.provider).toBe('ollama');
    expect(d.model).toBe('qwen2.5-coder:32b');
    expect(d.reason).toContain('default routing');
  });

  it('Evidence with winner=ollama (matches default) does NOT change anything', () => {
    const d = decideRoute({
      ...base,
      providerEvidence: {
        winner: 'ollama',
        reasons: ['ollama highest avg score 0.9'],
        perProvider: [{ provider: 'ollama', samples: 5, avgScore: 0.9 }],
      },
    });
    expect(d.provider).toBe('ollama');
    expect(d.reason).toContain('default routing');
  });

  it('Evidence with winner=omlx, omlx in availableProviders → PROMOTES omlx', () => {
    const d = decideRoute({
      ...base,
      providerEvidence: {
        winner: 'omlx',
        reasons: ['omlx highest avg score 0.85 over 5 sample(s)', 'omlx also faster: 100ms vs 500ms avg'],
        perProvider: [
          { provider: 'omlx', samples: 5, avgScore: 0.85 },
          { provider: 'ollama', samples: 5, avgScore: 0.5 },
        ],
      },
      availableProviders: ['ollama', 'omlx'],
      providerDefaultModel: { omlx: 'mlx-community/Llama-3.2-3B-Instruct-4bit' },
    });
    expect(d.provider).toBe('omlx');
    expect(d.model).toBe('mlx-community/Llama-3.2-3B-Instruct-4bit');
    expect(d.reason).toContain('provider promoted via benchmark');
    expect(d.reason).toContain('omlx highest avg score');
    expect(d.fallbackChain.some(f => f.skipped.includes('provider demoted'))).toBe(true);
  });

  it('Evidence with winner=omlx but omlx NOT in availableProviders → stays on Ollama (graceful)', () => {
    const d = decideRoute({
      ...base,
      providerEvidence: {
        winner: 'omlx',
        reasons: ['omlx better'],
        perProvider: [],
      },
      availableProviders: ['ollama'],  // omlx not available locally
    });
    expect(d.provider).toBe('ollama');
    expect(d.reason).toContain('default routing');
  });

  it('reliabilityAware=false suppresses promotion (operator opted out)', () => {
    const d = decideRoute({
      ...base,
      reliabilityAware: false,
      providerEvidence: {
        winner: 'omlx',
        reasons: ['omlx wins'],
        perProvider: [],
      },
      availableProviders: ['ollama', 'omlx'],
    });
    expect(d.provider).toBe('ollama');
  });

  it('User pin OVERRIDES benchmark winner (verbatim rule)', () => {
    const d = decideRoute({
      ...base,
      pins: { 'tool-calling': 'qwen2.5-coder:32b' },
      providerEvidence: {
        winner: 'omlx',
        reasons: ['omlx better'],
        perProvider: [],
      },
      availableProviders: ['ollama', 'omlx'],
    });
    expect(d.provider).toBe('ollama');
    expect(d.model).toBe('qwen2.5-coder:32b');
    expect(d.pinUsed).toBe(true);
    expect(d.reason).toContain('pinned via Models page');
  });

  it('Promotion preserves taskType + classification confidence', () => {
    const d = decideRoute({
      ...base,
      classification: { primary: 'reasoning', confidence: 0.95, signals: ['x'] },
      providerEvidence: {
        winner: 'omlx',
        reasons: ['omlx wins reasoning'],
        perProvider: [],
      },
      availableProviders: ['ollama', 'omlx'],
    });
    expect(d.taskType).toBe('reasoning');
    expect(d.classificationConfidence).toBe(0.95);
  });
});
