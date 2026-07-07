/**
 * P12-1 — Task-aware model routing tests.
 *
 * Covers the two halves of the fix:
 *   1. Classifier hardening — document / legal / medical / corpus queries
 *      MUST classify as retrieval-grounded-qa so they stay on the heavy
 *      reasoning model. Casual chat / fillers classify light.
 *   2. decideRoute step 2.5 — taskDefaults map routes light tasks to fast
 *      models while heavy tasks fall through to defaultModel; pins and
 *      preferred-models still win; guards (disabled / not-installed /
 *      telemetry-degraded / low-confidence) all block the task default.
 */

import { describe, it, expect } from 'vitest';
import { classifyTask } from '../../src/observability/task-classifier.js';
import {
  decideRoute,
  DEFAULT_TASK_MODEL_MAP,
  type RoutingInputs,
} from '../../src/observability/model-routing-engine.js';

const HEAVY = 'llama3.3:70b-instruct-q4_K_M';
const FAST_CHAT = 'qwen3:30b-a3b-instruct-2507-q4_K_M';
const INSTANT = 'llama3.1:8b';

function baseInputs(over: Partial<RoutingInputs> = {}): RoutingInputs {
  return {
    classification: classifyTask('hello there'),
    defaultProvider: 'ollama',
    defaultModel: HEAVY,
    pins: {},
    preferredModels: [],
    disabledModels: [],
    localOnly: true,
    installedLocalModels: [
      HEAVY, FAST_CHAT, INSTANT, 'qwen3-coder:30b', 'qwen3-vl:32b',
    ],
    reliabilityAware: false,
    taskDefaults: DEFAULT_TASK_MODEL_MAP,
    ...over,
  };
}

describe('P12-1 classifier hardening — legal/doc queries stay heavy', () => {
  it('filename mention classifies as retrieval-grounded-qa', () => {
    const c = classifyTask('In Blackstone.pdf, what are the absolute rights of individuals?');
    expect(c.primary).toBe('retrieval-grounded-qa');
  });

  it('statute anchor (clause N) classifies as retrieval-grounded-qa', () => {
    const c = classifyTask('What does clause 29 say about imprisonment?');
    expect(c.primary).toBe('retrieval-grounded-qa');
  });

  it('legal terms (tribunal/claimant/dismissal) classify as retrieval-grounded-qa', () => {
    expect(classifyTask('What is my strongest argument against dismissal?').primary).toBe('retrieval-grounded-qa');
    expect(classifyTask('Summarise the tribunal hearing bundle').primary).toBe('retrieval-grounded-qa');
  });

  it('medical terms classify as retrieval-grounded-qa', () => {
    expect(classifyTask('What does the clinical guidance say about this diagnosis?').primary).toBe('retrieval-grounded-qa');
  });

  it('corpus phrasing ("in my documents") classifies as retrieval-grounded-qa', () => {
    expect(classifyTask('In my documents, when did the contract start?').primary).toBe('retrieval-grounded-qa');
    expect(classifyTask('Search my emails for the delivery date').primary).toBe('retrieval-grounded-qa');
  });

  it('casual chat still classifies as chat', () => {
    expect(classifyTask('How are you today? Tell me something interesting.').primary).toBe('chat');
  });

  it('short fillers classify as fast-response', () => {
    expect(classifyTask('thanks').primary).toBe('fast-response');
    expect(classifyTask('ok').primary).toBe('fast-response');
  });
});

describe('P12-1 decideRoute step 2.5 — task defaults', () => {
  it('chat routes to the fast MoE model EVEN at default confidence', () => {
    // Perf fix: 'chat' is the no-match default class (confidence 0.5 by
    // construction). Gating it sent every ordinary conversation to the
    // 70B (~30s/reply). Chat now always takes the fast MoE; heavy tasks
    // (legal/medical/doc/reasoning) classify separately and stay heavy.
    const d = decideRoute(baseInputs({ classification: classifyTask('Tell me an interesting fact about space and how are you doing') }));
    if (d.taskType === 'chat') {
      expect(d.model).toBe(FAST_CHAT);
    }
  });

  it('fast-response (high confidence not required — verify gate behaviour)', () => {
    const c = classifyTask('thanks');
    const d = decideRoute(baseInputs({ classification: c }));
    if (c.confidence >= 0.6) {
      expect(d.model).toBe(INSTANT);
      expect(d.reason).toContain('task-default');
    } else {
      expect(d.model).toBe(HEAVY);
    }
  });

  it('summarisation routes to fast MoE when confident', () => {
    const c = classifyTask('Summarise this text in a few sentences: the quick brown fox jumps over the lazy dog repeatedly.');
    const d = decideRoute(baseInputs({ classification: c }));
    if (c.confidence >= 0.6) {
      expect(d.model).toBe(FAST_CHAT);
    }
  });

  it('coding routes to qwen3-coder', () => {
    const c = classifyTask('Write a function in typescript that parses dates and refactor the class');
    expect(c.primary).toBe('coding');
    const d = decideRoute(baseInputs({ classification: c }));
    expect(d.model).toBe('qwen3-coder:30b');
  });

  it('retrieval-grounded-qa stays on the heavy default (no map entry)', () => {
    const c = classifyTask('In Magna Carta, what does clause 29 say?');
    expect(c.primary).toBe('retrieval-grounded-qa');
    const d = decideRoute(baseInputs({ classification: c }));
    expect(d.model).toBe(HEAVY);
  });

  it('reasoning stays heavy', () => {
    const c = classifyTask('Explain why the sky is blue step by step');
    const d = decideRoute(baseInputs({ classification: c }));
    expect(d.model).toBe(HEAVY);
  });

  it('user pin beats task default', () => {
    const c = classifyTask('Write a function in typescript to sort arrays');
    const d = decideRoute(baseInputs({
      classification: c,
      pins: { coding: 'codestral:22b' },
      installedLocalModels: [HEAVY, 'codestral:22b', 'qwen3-coder:30b'],
    }));
    expect(d.model).toBe('codestral:22b');
    expect(d.pinUsed).toBe(true);
  });

  it('preferred-models list beats task default', () => {
    const c = classifyTask('Write a function in python to sort arrays');
    const d = decideRoute(baseInputs({
      classification: c,
      preferredModels: ['qwen2.5-coder:32b'],
      installedLocalModels: [HEAVY, 'qwen2.5-coder:32b', 'qwen3-coder:30b'],
    }));
    expect(d.model).toBe('qwen2.5-coder:32b');
  });

  it('disabled task-default falls through to heavy default', () => {
    const c = classifyTask('Write a function in rust to sort arrays');
    const d = decideRoute(baseInputs({
      classification: c,
      disabledModels: ['qwen3-coder:30b'],
    }));
    expect(d.model).toBe(HEAVY);
    expect(d.fallbackChain.some((f) => f.skipped.includes('disabled'))).toBe(true);
  });

  it('not-installed task-default falls through under localOnly', () => {
    const c = classifyTask('Write a function in java to sort arrays');
    const d = decideRoute(baseInputs({
      classification: c,
      installedLocalModels: [HEAVY], // coder not installed
    }));
    expect(d.model).toBe(HEAVY);
    expect(d.fallbackChain.some((f) => f.skipped.includes('not installed'))).toBe(true);
  });

  it('telemetry-degraded task-default falls through', () => {
    const c = classifyTask('Write a function in golang to sort arrays');
    const d = decideRoute(baseInputs({
      classification: c,
      reliabilityAware: true,
      perModelHealth: {
        'qwen3-coder:30b': { totalCalls: 10, p95LatencyMs: 60_000, successRate: 0.9 },
      },
    }));
    expect(d.model).toBe(HEAVY);
    expect(d.fallbackChain.some((f) => f.skipped.includes('telemetry'))).toBe(true);
  });

  it('no taskDefaults map → legacy behaviour (everything heavy)', () => {
    const c = classifyTask('Write a function in typescript to sort arrays');
    const d = decideRoute(baseInputs({
      classification: c,
      taskDefaults: undefined,
    }));
    expect(d.model).toBe(HEAVY);
  });
});

describe('P13 fix — smalltalk retrieval gate', () => {
  it('skips retrieval for greetings and fillers', async () => {
    const { shouldSkipRetrievalForSmalltalk } = await import('../../src/observability/task-classifier.js');
    expect(shouldSkipRetrievalForSmalltalk('hello')).toBe(true);
    expect(shouldSkipRetrievalForSmalltalk('Hello!')).toBe(true);
    expect(shouldSkipRetrievalForSmalltalk('thanks')).toBe(true);
    expect(shouldSkipRetrievalForSmalltalk('ok')).toBe(true);
    expect(shouldSkipRetrievalForSmalltalk('Good morning')).toBe(true);
    expect(shouldSkipRetrievalForSmalltalk('how are you today?')).toBe(true);
  });

  it('does NOT skip retrieval for real questions (incl. ones containing greetings)', async () => {
    const { shouldSkipRetrievalForSmalltalk } = await import('../../src/observability/task-classifier.js');
    expect(shouldSkipRetrievalForSmalltalk('What were the Brixton network issues?')).toBe(false);
    expect(shouldSkipRetrievalForSmalltalk('From my documents, what was said about induction training?')).toBe(false);
    expect(shouldSkipRetrievalForSmalltalk('Find the email where Penny says hello and mentions FTTP')).toBe(false);
    expect(shouldSkipRetrievalForSmalltalk('Summarise the tribunal hearing bundle')).toBe(false);
  });
});

describe('P13 fix — assistant-meta retrieval gate', () => {
  it('skips retrieval for questions about the assistant', async () => {
    const { shouldSkipRetrievalForSmalltalk } = await import('../../src/observability/task-classifier.js');
    expect(shouldSkipRetrievalForSmalltalk('Whats your name?')).toBe(true);
    expect(shouldSkipRetrievalForSmalltalk("What's your name?")).toBe(true);
    expect(shouldSkipRetrievalForSmalltalk('Who are you?')).toBe(true);
    expect(shouldSkipRetrievalForSmalltalk('What can you do?')).toBe(true);
    expect(shouldSkipRetrievalForSmalltalk('Are you an AI?')).toBe(true);
  });

  it('still retrieves for content questions containing similar words', async () => {
    const { shouldSkipRetrievalForSmalltalk } = await import('../../src/observability/task-classifier.js');
    expect(shouldSkipRetrievalForSmalltalk('What is the name of the engineer Penny mentioned?')).toBe(false);
    expect(shouldSkipRetrievalForSmalltalk('Who are the respondents in my tribunal case?')).toBe(false);
  });
});

describe('userForceModel — absolute Settings override', () => {
  it('outranks task defaults, pins, and playbook preferences', () => {
    const c = classifyTask('Write a function in typescript to sort arrays');
    const d = decideRoute(baseInputs({
      classification: c,
      userForceModel: 'deepseek-coder-v2:16b',
      pins: { coding: 'codestral:22b' },
      preferredModels: ['qwen2.5-coder:32b'],
      installedLocalModels: [HEAVY, 'deepseek-coder-v2:16b', 'codestral:22b', 'qwen2.5-coder:32b'],
    }));
    expect(d.model).toBe('deepseek-coder-v2:16b');
    expect(d.pinUsed).toBe(true);
    expect(d.reason).toContain('user override');
  });

  it('applies to light tasks too (no fast-lane bypass)', () => {
    const c = classifyTask('thanks');
    const d = decideRoute(baseInputs({
      classification: c,
      userForceModel: 'deepseek-coder-v2:16b',
      installedLocalModels: [HEAVY, INSTANT, 'deepseek-coder-v2:16b'],
    }));
    expect(d.model).toBe('deepseek-coder-v2:16b');
  });

  it('falls through (with skip note) when the forced model is not installed under localOnly', () => {
    const c = classifyTask('hello there');
    const d = decideRoute(baseInputs({
      classification: c,
      userForceModel: 'not-a-real-model:1b',
    }));
    expect(d.model).not.toBe('not-a-real-model:1b');
    expect(d.fallbackChain.some(f => f.skipped.includes('userForceModel'))).toBe(true);
  });

  it('null/empty override is a no-op', () => {
    const c = classifyTask('thanks');
    const d = decideRoute(baseInputs({ classification: c, userForceModel: null }));
    if (c.confidence >= 0.6) expect(d.model).toBe(INSTANT);
  });
});
