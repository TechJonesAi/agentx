/**
 * TaskClassifier unit tests — Batch 3.
 * Heuristic, deterministic — easy to assert.
 */
import { describe, it, expect } from 'vitest';
import { classifyTask } from '../../src/observability/task-classifier.js';

describe('TaskClassifier', () => {
  it('classifies plain conversational text as chat', () => {
    expect(classifyTask('Hello, how are you?').primary).toBe('chat');
  });

  it('detects coding tasks via code fence', () => {
    const c = classifyTask('Refactor this:\n```ts\nfunction foo(){}\n```');
    expect(c.primary).toBe('coding');
    expect(c.confidence).toBeGreaterThanOrEqual(0.5);
    expect(c.signals.some((s) => s.includes('code'))).toBe(true);
  });

  it('detects coding via verb + language', () => {
    expect(classifyTask('Write a function in Python to reverse a string').primary).toBe('coding');
  });

  it('detects builder via build-app phrase', () => {
    expect(classifyTask('Build a beautiful dating website with chat').primary).toBe('builder');
  });

  it('detects summarisation', () => {
    expect(classifyTask('Summarise this article in three bullet points').primary).toBe('summarisation');
  });

  it('detects reasoning via step-by-step', () => {
    expect(classifyTask('Explain why the sky is blue, step by step').primary).toBe('reasoning');
  });

  it('detects retrieval-grounded-qa via citation marker', () => {
    expect(classifyTask('Earlier we saw [MEM-5]; can you expand?').primary).toBe('retrieval-grounded-qa');
  });

  it('detects ocr separately from vision', () => {
    expect(classifyTask('OCR this receipt and extract the total').primary).toBe('ocr');
    expect(classifyTask('Describe this image').primary).toBe('vision');
  });

  it('detects autonomous-repair', () => {
    expect(classifyTask('Run self-repair on the broken subsystem').primary).toBe('autonomous-repair');
  });

  it('returns chat with 0.5 confidence when no rules match', () => {
    const c = classifyTask('xyzzy');
    expect(c.primary).toBe('chat');
    expect(c.confidence).toBe(0.5);
    expect(c.signals).toEqual([]);
  });

  it('confidence stays in [0.5,1]', () => {
    for (const input of ['x', 'Write a TypeScript class with imports and a function', 'Build a complex multi-agent app with chat tools and database']) {
      const c = classifyTask(input);
      expect(c.confidence).toBeGreaterThanOrEqual(0.5);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
  });
});
