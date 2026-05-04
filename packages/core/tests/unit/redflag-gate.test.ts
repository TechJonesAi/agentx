import { describe, it, expect } from 'vitest';
import { detectRedFlag, type RedFlagResult } from '../../src/reasoning/redflag-gate.js';

describe('detectRedFlag — medical triggers', () => {
  it('triggers on "chest pain"', () => {
    expect(detectRedFlag('I have chest pain')).toEqual({ isRedFlag: true, reason: 'chest pain' });
  });
  it('triggers on "can\'t breathe" (straight apostrophe)', () => {
    expect(detectRedFlag("I can't breathe properly")).toEqual({ isRedFlag: true, reason: "can't breathe" });
  });
  it('triggers on "can’t breathe" (curly apostrophe U+2019)', () => {
    expect(detectRedFlag('I can’t breathe properly')).toEqual({ isRedFlag: true, reason: "can't breathe" });
  });
  it('triggers on "cant breathe" (no apostrophe)', () => {
    expect(detectRedFlag('I cant breathe well')).toEqual({ isRedFlag: true, reason: "can't breathe" });
  });
  it('triggers on "bleeding"', () => {
    expect(detectRedFlag('She is bleeding heavily')).toEqual({ isRedFlag: true, reason: 'bleeding' });
  });
  it('triggers on "unconscious"', () => {
    expect(detectRedFlag('He is unconscious right now')).toEqual({ isRedFlag: true, reason: 'unconscious' });
  });
});

describe('detectRedFlag — legal triggers', () => {
  it('triggers on "sue"', () => {
    expect(detectRedFlag('I want to sue them')).toEqual({ isRedFlag: true, reason: 'sue' });
  });
  it('triggers on "court order"', () => {
    expect(detectRedFlag('I have a court order against me')).toEqual({ isRedFlag: true, reason: 'court order' });
  });
  it('triggers on "legal advice urgent"', () => {
    expect(detectRedFlag('I need legal advice urgent please')).toEqual({ isRedFlag: true, reason: 'legal advice urgent' });
  });
});

describe('detectRedFlag — non-triggers', () => {
  it('does not trigger on empty string', () => {
    expect(detectRedFlag('')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does not trigger on whitespace only', () => {
    expect(detectRedFlag('   ')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does not trigger on a casual greeting', () => {
    expect(detectRedFlag('Hello, how are you?')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does not trigger on benign medical context', () => {
    expect(detectRedFlag('I read about heart health today')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does not trigger on benign legal context', () => {
    expect(detectRedFlag('Tell me about contract law')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does not trigger on the word "court" alone (without "order")', () => {
    expect(detectRedFlag('She plays in the basketball court')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does not trigger on "legal advice" alone (without "urgent")', () => {
    expect(detectRedFlag('I am seeking legal advice next week')).toEqual({ isRedFlag: false, reason: null });
  });
});

describe('detectRedFlag — casing', () => {
  it('matches uppercase trigger', () => {
    expect(detectRedFlag('CHEST PAIN!!')).toEqual({ isRedFlag: true, reason: 'chest pain' });
  });
  it('matches mixed-case trigger', () => {
    expect(detectRedFlag('Chest Pain on the left side')).toEqual({ isRedFlag: true, reason: 'chest pain' });
  });
  it('matches uppercase legal trigger', () => {
    expect(detectRedFlag('I will SUE them')).toEqual({ isRedFlag: true, reason: 'sue' });
  });
  it('matches mixed-case multi-word legal trigger', () => {
    expect(detectRedFlag('A Court Order was served')).toEqual({ isRedFlag: true, reason: 'court order' });
  });
});

describe('detectRedFlag — partial matches (word-boundary correctness)', () => {
  it('does NOT trigger "sue" inside "lawsuit"', () => {
    expect(detectRedFlag('We discussed the lawsuit yesterday')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does NOT trigger "sue" inside "issued"', () => {
    expect(detectRedFlag('The notice was issued today')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does NOT trigger "sue" inside "pursued"', () => {
    expect(detectRedFlag('He pursued the matter further')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does NOT trigger "bleeding" inside "embleeding" (synthetic non-word)', () => {
    expect(detectRedFlag('the embleeding texture was odd')).toEqual({ isRedFlag: false, reason: null });
  });
  it('does NOT trigger "unconscious" inside "subconscious"', () => {
    expect(detectRedFlag('My subconscious is telling me something')).toEqual({ isRedFlag: false, reason: null });
  });
});

describe('detectRedFlag — priority on multiple matches', () => {
  it('returns the first declared trigger when both medical and legal match (medical wins)', () => {
    expect(detectRedFlag('I have chest pain and want to sue the hospital')).toEqual({
      isRedFlag: true,
      reason: 'chest pain',
    });
  });
  it('returns "bleeding" before "sue" when both appear', () => {
    expect(detectRedFlag('Bleeding badly — should I sue?')).toEqual({
      isRedFlag: true,
      reason: 'bleeding',
    });
  });
});

describe('detectRedFlag — return-shape and types', () => {
  it('always returns isRedFlag as a boolean', () => {
    const r: RedFlagResult = detectRedFlag('chest pain');
    expect(typeof r.isRedFlag).toBe('boolean');
  });
  it('reason is a string when triggered', () => {
    const r = detectRedFlag('chest pain');
    expect(typeof r.reason).toBe('string');
  });
  it('reason is null when not triggered', () => {
    expect(detectRedFlag('hello world').reason).toBeNull();
  });
  it('handles non-string input by returning a clean non-trigger', () => {
    expect(detectRedFlag(undefined as unknown as string)).toEqual({ isRedFlag: false, reason: null });
  });
});
