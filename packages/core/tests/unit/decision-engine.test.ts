/**
 * P8-1 / P8-1.1: Decision Engine — Unit Tests
 *
 * Phase 1 tests: transparent pass-through infrastructure
 * Phase 1.1 tests: conservative advisory logic
 */

import { describe, it, expect } from 'vitest';
import {
  DecisionEngine,
  isUtilityQuery,
  isDocumentReferenceQuery,
  type DecisionEngineInput,
  type DecisionEngineResult,
  type DecisionDomain,
  type DecisionSummary,
  type ExecutionTrace,
  type ClassificationSource,
  type ValidationSummary,
  type DecisionValidationResult,
} from '../../src/reasoning/decision-engine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInput(overrides: Partial<DecisionEngineInput> = {}): DecisionEngineInput {
  return {
    query: 'test query',
    knowledgeCtx: {
      hasKnowledge: false,
      docChunkCount: 0,
      detectedDomain: 'general',
      queryIntent: 'general',
      retrievalFailed: false,
    },
    advisorDecision: {
      detectedDomain: 'general',
      knowledgeConfidence: 'none',
      toolsRecommended: true,
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DecisionEngine', () => {
  const engine = new DecisionEngine();

  // ══════════════════════════════════════════════════════════════════
  // P8-1: Infrastructure pass-through tests (preserved)
  // ══════════════════════════════════════════════════════════════════

  describe('default pass-through', () => {
    it('returns standard strategy by default', () => {
      const result = engine.decide(makeInput());
      expect(result.strategy).toBe('standard');
    });

    it('passes through general domain unchanged', () => {
      const result = engine.decide(makeInput());
      expect(result.resolvedDomain).toBe('general');
    });

    it('passes through legal domain unchanged', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
      }));
      expect(result.resolvedDomain).toBe('legal');
    });

    it('passes through medical domain unchanged', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'medium', toolsRecommended: true },
      }));
      expect(result.resolvedDomain).toBe('medical');
    });

    it('passes through financial domain unchanged', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'low', toolsRecommended: false },
      }));
      expect(result.resolvedDomain).toBe('financial');
    });

    it('passes through technical domain unchanged', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'technical', knowledgeConfidence: 'medium', toolsRecommended: true },
      }));
      expect(result.resolvedDomain).toBe('technical');
    });
  });

  describe('output shape', () => {
    it('suppressTools is empty for general domain with no docs', () => {
      const result = engine.decide(makeInput());
      expect(result.suppressTools).toEqual([]);
    });

    it('promptBlock is empty when no knowledge', () => {
      const result = engine.decide(makeInput());
      expect(result.promptBlock).toBe('');
    });

    it('reasoning is a non-empty string', () => {
      const result = engine.decide(makeInput());
      expect(typeof result.reasoning).toBe('string');
      expect(result.reasoning.length).toBeGreaterThan(0);
    });

    it('returns all required fields', () => {
      const result = engine.decide(makeInput());
      const keys: Array<keyof DecisionEngineResult> = [
        'strategy', 'resolvedDomain', 'forceReasoning',
        'suppressTools', 'promptBlock', 'confidence', 'reasoning',
      ];
      for (const key of keys) {
        expect(result).toHaveProperty(key);
      }
    });
  });

  describe('optional redFlagGate', () => {
    it('handles missing redFlagGate (streaming path)', () => {
      const input = makeInput();
      delete (input as any).redFlagGate;
      const result = engine.decide(input);
      expect(result.resolvedDomain).toBe('general');
      expect(result.strategy).toBe('standard');
    });

    it('handles present redFlagGate without overriding safety', () => {
      const result = engine.decide(makeInput({
        redFlagGate: { triggered: true, isHardGate: false },
      }));
      // Decision Engine does not override hard gate — handled upstream
      expect(result.strategy).toBe('standard');
    });

    it('handles hard-gate redFlagGate without weakening it', () => {
      const result = engine.decide(makeInput({
        redFlagGate: { triggered: true, isHardGate: true },
      }));
      // Hard gate is handled upstream in agent.ts before Decision Engine runs
      expect(result.resolvedDomain).toBe('general');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.3: Strategy routing
  // ══════════════════════════════════════════════════════════════════

  describe('P8-1.3: strategy routing', () => {

    // ── hybrid strategy ──────────────────────────────────────────

    it('selects hybrid for legal domain with non-fact-extraction intent', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('hybrid');
    });

    it('selects hybrid for medical domain with knowledge', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'medium', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('hybrid');
    });

    it('selects hybrid for financial domain with knowledge', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'low', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 2, detectedDomain: 'financial', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('hybrid');
    });

    it('does NOT select hybrid for general domain', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('does NOT select hybrid for technical domain', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'technical', knowledgeConfidence: 'medium', toolsRecommended: true },
      }));
      expect(result.strategy).toBe('standard');
    });

    // ── direct_answer strategy ───────────────────────────────────

    it('selects direct_answer for fact_extraction with knowledge', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('direct_answer');
    });

    it('does NOT select direct_answer for legal fact_extraction (P8-1.4 R2)', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 10, detectedDomain: 'legal', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      // P8-1.4: legal excluded from direct_answer — falls to standard (fact_extraction blocks hybrid)
      expect(result.strategy).toBe('standard');
    });

    it('does NOT select direct_answer for medical fact_extraction (P8-1.4 R2)', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'medical', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      // P8-1.4: medical excluded from direct_answer — falls to standard
      expect(result.strategy).toBe('standard');
    });

    it('does NOT select direct_answer when retrieval failed', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'none', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: true },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('does NOT select direct_answer when no knowledge', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'none', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('does NOT select direct_answer for strategy intent even with knowledge', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('standard');
    });

    // ── priority: direct_answer > hybrid ─────────────────────────

    it('direct_answer takes priority over hybrid for deep domain fact_extraction', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'financial', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('direct_answer');
    });

    // ── standard fallback ────────────────────────────────────────

    it('defaults to standard for general domain with general intent', () => {
      const result = engine.decide(makeInput());
      expect(result.strategy).toBe('standard');
    });

    it('defaults to standard for technical domain with strategy intent', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'technical', knowledgeConfidence: 'medium', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'technical', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('standard');
    });

    // ── reasoning trace ──────────────────────────────────────────

    it('includes strategy in reasoning trace', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.reasoning).toContain('strategy: hybrid');
    });

    it('includes direct_answer in reasoning trace', () => {
      const result = engine.decide(makeInput({
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.reasoning).toContain('strategy: direct_answer');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.4: Strategy hardening
  // ══════════════════════════════════════════════════════════════════

  describe('P8-1.4: strategy hardening', () => {

    // ── Rule 1: hybrid requires knowledge ────────────────────────

    it('R1: deep domain + NO knowledge → standard', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'none', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('R1: medical domain + NO knowledge → standard', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'none', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('R1: financial domain + NO knowledge → standard', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'low', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'financial', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('R1: deep domain + knowledge → hybrid', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('hybrid');
    });

    // ── Rule 2: direct_answer excludes legal/medical ─────────────

    it('R2: legal fact_extraction → NOT direct_answer', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 10, detectedDomain: 'legal', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).not.toBe('direct_answer');
      expect(result.strategy).toBe('standard');
    });

    it('R2: medical fact_extraction → NOT direct_answer', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'medical', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).not.toBe('direct_answer');
      expect(result.strategy).toBe('standard');
    });

    it('R2: financial fact_extraction → direct_answer allowed', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'financial', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('direct_answer');
    });

    it('R2: general fact_extraction → direct_answer allowed', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('direct_answer');
    });

    it('R2: technical fact_extraction → direct_answer allowed', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'technical', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'technical', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('direct_answer');
    });

    // ── Rule 3: retrieval failure always forces standard ─────────

    it('R3: retrieval failed + deep domain → standard', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: true },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('R3: retrieval failed + fact_extraction → standard', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: true },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('R3: retrieval failed overrides ALL conditions', () => {
      // Would normally be hybrid (legal + knowledge + strategy intent)
      // but retrieval failure forces standard
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 10, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: true },
      }));
      expect(result.strategy).toBe('standard');
    });

    // ── Rule 4: no knowledge always forces standard ──────────────

    it('R4: no knowledge + deep domain → standard', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'none', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('R4: no knowledge + fact_extraction → standard', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'none', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('standard');
    });

    // ── Rule 5: priority order ───────────────────────────────────

    it('R5: retrieval failure beats knowledge + deep domain', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 10, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: true },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('R5: no knowledge beats fact_extraction conditions', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'none', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('standard');
    });

    it('R5: direct_answer still beats hybrid for financial fact_extraction', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'financial', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.strategy).toBe('direct_answer');
    });

    it('R5: reasoning trace references P8-1.4 rules', () => {
      const result = engine.decide(makeInput({
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: true },
      }));
      expect(result.reasoning).toContain('P8-1.4');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.1: Rule 1 — Deep-domain reasoning force
  // ══════════════════════════════════════════════════════════════════

  describe('Rule 1: deep-domain reasoning force', () => {
    it('forces reasoning for legal domain', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
      }));
      expect(result.forceReasoning).toBe(true);
    });

    it('forces reasoning for medical domain', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'medium', toolsRecommended: true },
      }));
      expect(result.forceReasoning).toBe(true);
    });

    it('forces reasoning for financial domain', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'low', toolsRecommended: false },
      }));
      expect(result.forceReasoning).toBe(true);
    });

    it('does NOT force reasoning for general domain', () => {
      const result = engine.decide(makeInput());
      expect(result.forceReasoning).toBe(false);
    });

    it('does NOT force reasoning for technical domain', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'technical', knowledgeConfidence: 'medium', toolsRecommended: true },
      }));
      expect(result.forceReasoning).toBe(false);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.1: Rule 2 — Conservative domain normalization
  // ══════════════════════════════════════════════════════════════════

  describe('Rule 2: domain normalization', () => {
    it('normalizes invalid domain to general', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'nonsense' as any, knowledgeConfidence: 'none', toolsRecommended: true },
      }));
      expect(result.resolvedDomain).toBe('general');
    });

    it('normalizes empty string domain to general', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: '' as any, knowledgeConfidence: 'none', toolsRecommended: true },
      }));
      expect(result.resolvedDomain).toBe('general');
    });

    it('preserves all valid domains unchanged', () => {
      const valid: DecisionDomain[] = ['general', 'legal', 'medical', 'technical', 'financial'];
      for (const domain of valid) {
        const result = engine.decide(makeInput({
          advisorDecision: { detectedDomain: domain, knowledgeConfidence: 'medium', toolsRecommended: true },
        }));
        expect(result.resolvedDomain).toBe(domain);
      }
    });

    it('includes normalization in reasoning trace when triggered', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'invalid' as any, knowledgeConfidence: 'none', toolsRecommended: true },
      }));
      expect(result.reasoning).toContain('normalized');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.1: Rule 3 — Restrictive tool suppression
  // ══════════════════════════════════════════════════════════════════

  describe('Rule 3: tool suppression', () => {
    // 3a: Medical document-first
    it('suppresses web_search for medical domain with document evidence', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'medical', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.suppressTools).toContain('web_search');
    });

    it('does NOT suppress web_search for medical domain without docs', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'low', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: false },
      }));
      expect(result.suppressTools).not.toContain('web_search');
    });

    it('does NOT suppress web_search for medical domain when retrieval failed', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'none', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: true },
      }));
      expect(result.suppressTools).not.toContain('web_search');
    });

    // 3b: Fact-extraction suppression
    it('suppresses web_search for fact_extraction with docs', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 8, detectedDomain: 'legal', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.suppressTools).toContain('web_search');
    });

    it('does NOT suppress for fact_extraction without docs', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'none', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'legal', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      expect(result.suppressTools).toEqual([]);
    });

    it('does NOT suppress for fact_extraction when retrieval failed', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'none', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: true },
      }));
      expect(result.suppressTools).toEqual([]);
    });

    // No duplicate entries
    it('does not duplicate web_search when both medical and fact_extraction apply', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'medical', queryIntent: 'fact_extraction', retrievalFailed: false },
      }));
      const wsCount = result.suppressTools.filter(t => t === 'web_search').length;
      expect(wsCount).toBe(1);
    });

    // Invariant: never expands tools
    it('never returns addTools field', () => {
      const result = engine.decide(makeInput());
      expect(result).not.toHaveProperty('addTools');
    });

    it('suppressTools is always an array', () => {
      const result = engine.decide(makeInput());
      expect(Array.isArray(result.suppressTools)).toBe(true);
    });

    // General domain with no docs — no suppression
    it('does not suppress tools for general domain with no docs', () => {
      const result = engine.decide(makeInput());
      expect(result.suppressTools).toEqual([]);
    });

    // Legal domain with docs but strategy intent — no medical suppression, but no fact suppression either
    it('does not suppress web_search for legal domain with strategy intent', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.suppressTools).toEqual([]);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.1: Rule 4 — Minimal prompt block
  // ══════════════════════════════════════════════════════════════════

  describe('Rule 4: prompt block', () => {
    it('emits soft guidance for general domain + general intent with docs (P8-1.7)', () => {
      const result = engine.decide(makeInput({
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
      }));
      // P8-1.7: general+general now gets soft promptBlock
      expect(result.promptBlock).toContain('general knowledge');
      expect(result.promptBlock).toContain('If they are relevant');
    });

    it('emits strict grounding for non-general domain with docs', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'legal', queryIntent: 'general', retrievalFailed: false },
      }));
      expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      expect(result.promptBlock).toContain('Do not invent facts');
    });

    it('does NOT emit prompt block when no knowledge', () => {
      const result = engine.decide(makeInput());
      expect(result.promptBlock).toBe('');
    });

    it('does NOT emit prompt block when retrieval failed', () => {
      const result = engine.decide(makeInput({
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: true },
      }));
      expect(result.promptBlock).toBe('');
    });

    it('does NOT emit prompt block when docs=0 even if hasKnowledge', () => {
      const result = engine.decide(makeInput({
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
      }));
      expect(result.promptBlock).toBe('');
    });

    it('prompt block is deterministic — same input produces same output', () => {
      const input = makeInput({
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
      });
      const a = engine.decide(input);
      const b = engine.decide(input);
      expect(a.promptBlock).toBe(b.promptBlock);
    });

    it('prompt block is short (under 300 chars)', () => {
      const result = engine.decide(makeInput({
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 10, detectedDomain: 'medical', queryIntent: 'strategy', retrievalFailed: false },
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
      }));
      expect(result.promptBlock.length).toBeLessThan(300);
    });

    // ── P8-1.12c: strictGrounding flag on decide() output ──────────
    describe('P8-1.12c: strictGrounding flag', () => {
      it('false for general domain + general intent', () => {
        const result = engine.decide(makeInput({
          query: 'What toppings go on a margarita pizza?',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(false);
      });

      it('false for general domain + fact_extraction intent (upstream misclassification)', () => {
        const result = engine.decide(makeInput({
          query: 'What toppings go on a margarita pizza?',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
        }));
        // Domain is general, no doc ref, no rescue → strictGrounding false
        expect(result.strictGrounding).toBe(false);
      });

      it('true for legal domain with docs', () => {
        const result = engine.decide(makeInput({
          query: 'What are my employment rights?',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(true);
      });

      it('true for medical domain with docs', () => {
        const result = engine.decide(makeInput({
          query: 'What does my diagnosis mean?',
          advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 2, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(true);
      });

      it('true for financial domain with docs', () => {
        const result = engine.decide(makeInput({
          query: 'What are my pension contributions?',
          advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 4, detectedDomain: 'financial', queryIntent: 'fact_extraction', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(true);
      });

      it('false for utility queries', () => {
        const result = engine.decide(makeInput({
          query: 'What time is it?',
        }));
        expect(result.strictGrounding).toBe(false);
      });

      it('false when no docs available', () => {
        const result = engine.decide(makeInput({
          query: 'What are my rights?',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'none', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(false);
      });

      it('false when retrieval failed', () => {
        const result = engine.decide(makeInput({
          query: 'What are my rights?',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'low', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: true },
        }));
        expect(result.strictGrounding).toBe(false);
      });

      it('true for rescued_legal classification', () => {
        const result = engine.decide(makeInput({
          query: 'I was dismissed unfairly and want to file a grievance',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        // Should rescue to legal
        expect(result.classificationSource).toBe('rescued_legal');
        expect(result.strictGrounding).toBe(true);
      });

      it('true for document reference query on general domain', () => {
        const result = engine.decide(makeInput({
          query: 'What do my documents say about the notice period?',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(true);
      });

      it('execution trace flags.strictGrounding matches result.strictGrounding', () => {
        const input = makeInput({
          query: 'How do I make pasta?',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.strictGrounding).toBe(result.strictGrounding);
        expect(trace.flags.strictGrounding).toBe(false);
      });
    });

    // ── P8-1.15: General query refusal prevention ────────────────────
    // These tests verify that general everyday queries with irrelevant documents
    // get strictGrounding=false, enabling agent.ts to inject general knowledge
    // permission and prevent refusals like "documents do not discuss food items"
    describe('P8-1.15: general query refusal prevention', () => {
      it('cowfoot soup with legal docs → strictGrounding false, resolvedDomain general', () => {
        const result = engine.decide(makeInput({
          query: 'How to make cowfoot soup',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: false },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 8, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(false);
        expect(result.resolvedDomain).toBe('general');
      });

      it('jerk chicken with legal docs → strictGrounding false', () => {
        const result = engine.decide(makeInput({
          query: 'How to make jerk chicken',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: false },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(false);
        expect(result.resolvedDomain).toBe('general');
      });

      it('pizza question with legal docs → strictGrounding false', () => {
        const result = engine.decide(makeInput({
          query: 'What toppings go on a margarita pizza?',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: false },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 8, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(false);
      });

      it('rice cooking with medical docs → strictGrounding false', () => {
        const result = engine.decide(makeInput({
          query: 'How to cook rice',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: false },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(false);
      });

      it('legal query remains strictGrounding true', () => {
        const result = engine.decide(makeInput({
          query: 'Was my dismissal fair?',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: false },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 8, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(true);
        expect(result.resolvedDomain).toBe('legal');
      });

      it('document query remains strictGrounding true', () => {
        const result = engine.decide(makeInput({
          query: 'What do my documents say about the notice period?',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: false },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(true);
      });

      it('medical query remains strictGrounding true', () => {
        const result = engine.decide(makeInput({
          query: 'What does my blood test report say?',
          advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: false },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.strictGrounding).toBe(true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.1: Rule 5 — Confidence + reasoning trace
  // ══════════════════════════════════════════════════════════════════

  describe('Rule 5: confidence + reasoning', () => {
    it('low confidence when retrieval failed', () => {
      const result = engine.decide(makeInput({
        knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: true },
      }));
      expect(result.confidence).toBeLessThanOrEqual(0.3);
    });

    it('moderate confidence when no knowledge', () => {
      const result = engine.decide(makeInput());
      expect(result.confidence).toBe(0.5);
    });

    it('high confidence with high advisor confidence and docs', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('medium confidence with medium advisor confidence and docs', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
      }));
      expect(result.confidence).toBe(0.8);
    });

    it('reasoning trace mentions P8-1.1', () => {
      const result = engine.decide(makeInput());
      expect(result.reasoning).toContain('P8-1.1');
    });

    it('reasoning trace lists rules that fired', () => {
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'medical', queryIntent: 'strategy', retrievalFailed: false },
      }));
      expect(result.reasoning).toContain('forceReasoning');
      expect(result.reasoning).toContain('suppress web_search');
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // Integration safety invariants
  // ══════════════════════════════════════════════════════════════════

  describe('integration safety invariants', () => {
    it('resolvedDomain always matches advisor for valid domains', () => {
      const domains: DecisionDomain[] = ['general', 'legal', 'medical', 'technical', 'financial'];
      for (const domain of domains) {
        const result = engine.decide(makeInput({
          advisorDecision: { detectedDomain: domain, knowledgeConfidence: 'medium', toolsRecommended: true },
        }));
        expect(result.resolvedDomain).toBe(domain);
      }
    });

    it('suppressTools only reduces tool set, never expands', () => {
      const mockTools = [{ name: 'web_search' }, { name: 'cognitive_query' }, { name: 'memory_store' }];
      // Medical with docs — suppresses web_search
      const result = engine.decide(makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'medical', queryIntent: 'strategy', retrievalFailed: false },
      }));
      const filtered = mockTools.filter(t => !result.suppressTools.includes(t.name));
      expect(filtered.length).toBeLessThanOrEqual(mockTools.length);
      // Verify no tools were added
      for (const t of filtered) {
        expect(mockTools).toContainEqual(t);
      }
    });

    it('promptBlock injection is additive only', () => {
      const result = engine.decide(makeInput({
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
      }));
      const basePrompt = 'You are an assistant.';
      const augmented = result.promptBlock ? basePrompt + '\n' + result.promptBlock : basePrompt;
      // Original prompt is preserved
      expect(augmented).toContain(basePrompt);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.2: Post-LLM Decision Validation
  // ══════════════════════════════════════════════════════════════════

  describe('validateResponse', () => {

    // Helper to build a decision result for validation tests
    function makeDecision(overrides: Partial<DecisionEngineResult> = {}): DecisionEngineResult {
      return {
        strategy: 'standard',
        resolvedDomain: 'general',
        forceReasoning: false,
        suppressTools: [],
        promptBlock: '',
        confidence: 1.0,
        reasoning: 'test',
        classificationSource: 'upstream',
        strictGrounding: false,
        ...overrides,
      };
    }

    function makeKnowledge(overrides: Partial<import('../../src/reasoning/decision-engine.js').DecisionKnowledgeContext> = {}) {
      return {
        hasKnowledge: false,
        docChunkCount: 0,
        detectedDomain: 'general' as const,
        queryIntent: 'general' as const,
        retrievalFailed: false,
        ...overrides,
      };
    }

    // ── Aligned responses remain unchanged ────────────────────────

    describe('aligned responses', () => {
      it('returns aligned for a well-grounded response with evidence language', () => {
        const result = engine.validateResponse({
          responseText: 'According to the documents, the policy states that employees are entitled to 28 days leave.',
          decision: makeDecision({ promptBlock: 'grounding', confidence: 0.9 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.status).toBe('aligned');
        expect(result.wasModified).toBe(false);
        expect(result.responseText).not.toContain('Note:');
      });

      it('returns aligned when no prompt block was set (no grounding expectation)', () => {
        const result = engine.validateResponse({
          responseText: 'The capital of France is Paris.',
          decision: makeDecision({ promptBlock: '', confidence: 1.0 }),
          knowledgeCtx: makeKnowledge(),
        });
        expect(result.status).toBe('aligned');
        expect(result.wasModified).toBe(false);
      });

      it('returns aligned for short responses', () => {
        const result = engine.validateResponse({
          responseText: 'Yes.',
          decision: makeDecision({ promptBlock: 'grounding', confidence: 0.9 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 3 }),
        });
        expect(result.status).toBe('aligned');
        expect(result.wasModified).toBe(false);
      });

      it('returns aligned when response has uncertainty in low-confidence context', () => {
        const result = engine.validateResponse({
          responseText: 'This may be related to the condition, but it is unclear based on available evidence.',
          decision: makeDecision({ confidence: 0.3 }),
          knowledgeCtx: makeKnowledge({ retrievalFailed: true }),
        });
        expect(result.status).toBe('aligned');
        expect(result.wasModified).toBe(false);
      });
    });

    // ── Grounding drift detection ─────────────────────────────────

    describe('grounding drift detection', () => {
      it('adds soft reminder when docs expected but response has no evidence language', () => {
        // P8-1.12c: strictGrounding=true triggers grounding drift detection
        const result = engine.validateResponse({
          responseText: 'The answer to your question is that you should take vitamin C daily for best results.',
          decision: makeDecision({ strictGrounding: true, confidence: 0.8, resolvedDomain: 'legal' }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.status).toBe('softened');
        expect(result.wasModified).toBe(true);
        expect(result.responseText).toContain('verified against the retrieved documents');
        expect(result.reasons.some(r => r.includes('grounding drift'))).toBe(true);
      });

      it('does NOT add reminder when docs expected and response references evidence', () => {
        const result = engine.validateResponse({
          responseText: 'Based on the uploaded documents, your employment contract states a 3-month notice period.',
          decision: makeDecision({ promptBlock: 'grounding guidance', confidence: 0.9 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(false);
      });

      it('does NOT trigger when no promptBlock was set', () => {
        const result = engine.validateResponse({
          responseText: 'The answer is 42.',
          decision: makeDecision({ promptBlock: '' }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(false);
      });

      it('does NOT trigger when retrieval failed', () => {
        const result = engine.validateResponse({
          responseText: 'The answer is 42.',
          decision: makeDecision({ promptBlock: 'grounding' }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: false, docChunkCount: 0, retrievalFailed: true }),
        });
        expect(result.wasModified).toBe(false);
      });
    });

    // ── P8-1.12 / P8-1.12c: Grounding noise removal (strictGrounding flag) ──
    describe('P8-1.12c — strictGrounding flag controls validator', () => {

      it('pizza question → strictGrounding false → no reminder', () => {
        const result = engine.validateResponse({
          responseText: 'A margarita pizza typically has tomato sauce, mozzarella, and fresh basil.',
          decision: makeDecision({ strictGrounding: false }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(false);
        expect(result.groundingDriftDetected).toBe(false);
        expect(result.responseText).not.toContain('verified against');
      });

      it('grime question → strictGrounding false → no reminder', () => {
        const result = engine.validateResponse({
          responseText: 'Grime is a genre of electronic dance music that originated in London in the early 2000s.',
          decision: makeDecision({ strictGrounding: false }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 3 }),
        });
        expect(result.wasModified).toBe(false);
        expect(result.groundingDriftDetected).toBe(false);
      });

      it('cooking question → strictGrounding false → no reminder', () => {
        const result = engine.validateResponse({
          responseText: 'To make jerk chicken, marinate in allspice, scotch bonnet, thyme, and garlic.',
          decision: makeDecision({ strictGrounding: false }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 3 }),
        });
        expect(result.wasModified).toBe(false);
        expect(result.groundingDriftDetected).toBe(false);
      });

      it('legal query → strictGrounding true → reminder fires', () => {
        const result = engine.validateResponse({
          responseText: 'You should check the relevant sections for more details.',
          decision: makeDecision({ strictGrounding: true, resolvedDomain: 'legal' }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(true);
        expect(result.groundingDriftDetected).toBe(true);
        expect(result.responseText).toContain('verified against the retrieved documents');
      });

      it('medical query → strictGrounding true → reminder fires', () => {
        const result = engine.validateResponse({
          responseText: 'This condition usually requires ongoing monitoring.',
          decision: makeDecision({ strictGrounding: true, resolvedDomain: 'medical' }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 3 }),
        });
        expect(result.wasModified).toBe(true);
        expect(result.groundingDriftDetected).toBe(true);
      });

      it('document query → strictGrounding true → reminder fires', () => {
        const result = engine.validateResponse({
          responseText: 'The policy seems to indicate a standard approach.',
          decision: makeDecision({ strictGrounding: true, resolvedDomain: 'financial' }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(true);
        expect(result.groundingDriftDetected).toBe(true);
      });

      it('utility query → strictGrounding false → no reminder', () => {
        const result = engine.validateResponse({
          responseText: 'Hello! How can I help you today?',
          decision: makeDecision({ strictGrounding: false, classificationSource: 'utility_fast_path' }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(false);
        expect(result.groundingDriftDetected).toBe(false);
      });

      it('upstream fact_extraction + general domain → strictGrounding false → no reminder', () => {
        // Simulates "what toppings go on a pizza" classified as fact_extraction by upstream
        // but DecisionEngine resolves to general with strictGrounding=false
        const result = engine.validateResponse({
          responseText: 'Pizza toppings vary by region but classic margarita uses tomato, mozzarella, basil.',
          decision: makeDecision({ strictGrounding: false, resolvedDomain: 'general' }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5, queryIntent: 'fact_extraction' }),
        });
        expect(result.wasModified).toBe(false);
        expect(result.groundingDriftDetected).toBe(false);
      });

      it('promptBlock content is irrelevant — only strictGrounding matters', () => {
        // Even with STRICT_GROUNDING_MARKER in promptBlock, validator skips if strictGrounding=false
        const result = engine.validateResponse({
          responseText: 'The capital of France is Paris.',
          decision: makeDecision({
            promptBlock: 'Base your answer on the retrieved evidence. Do not invent.',
            strictGrounding: false,
          }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(false);
        expect(result.groundingDriftDetected).toBe(false);
      });
    });

    // ── Uncertainty softening ─────────────────────────────────────

    describe('uncertainty softening', () => {
      it('softens overconfident language in low-confidence context', () => {
        const result = engine.validateResponse({
          responseText: 'It is certain that this condition requires immediate surgery. There is no doubt about this diagnosis.',
          decision: makeDecision({ confidence: 0.3 }),
          knowledgeCtx: makeKnowledge({ retrievalFailed: true }),
        });
        expect(result.status).toBe('softened');
        expect(result.wasModified).toBe(true);
        expect(result.responseText).toContain('available evidence for this response is limited');
      });

      it('does NOT soften when confidence is high', () => {
        const result = engine.validateResponse({
          responseText: 'It is certain that this policy applies. There is no doubt about this.',
          decision: makeDecision({ confidence: 0.95 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(false);
      });

      it('does NOT soften when response already has uncertainty markers', () => {
        const result = engine.validateResponse({
          responseText: 'It is certain that something happened. However, it is possible that other factors are involved.',
          decision: makeDecision({ confidence: 0.3 }),
          knowledgeCtx: makeKnowledge({ retrievalFailed: true }),
        });
        expect(result.wasModified).toBe(false);
      });

      it('does NOT soften normal language in low-confidence context', () => {
        const result = engine.validateResponse({
          responseText: 'Based on general knowledge, the typical approach involves several steps.',
          decision: makeDecision({ confidence: 0.5 }),
          knowledgeCtx: makeKnowledge(),
        });
        expect(result.wasModified).toBe(false);
      });
    });

    // ── Safety guard non-interference ─────────────────────────────

    describe('safety guard non-interference', () => {
      it('skips validation when fact integrity guard signature detected', () => {
        const result = engine.validateResponse({
          responseText: 'The identity of your employer is not explicitly stated in the provided documents.\n\nIf you can tell me who your employer is, I can use that information alongside the document evidence.',
          decision: makeDecision({ promptBlock: 'grounding', confidence: 0.9 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.status).toBe('skipped');
        expect(result.wasModified).toBe(false);
      });

      it('skips validation when medical fact guard signature detected', () => {
        const result = engine.validateResponse({
          responseText: 'Not explicitly stated in the provided medical documents.\n\nIf you\'d like, I can summarise the record, compare documents, or help identify questions to raise with your clinician.',
          decision: makeDecision({ promptBlock: 'grounding', confidence: 0.9 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.status).toBe('skipped');
        expect(result.wasModified).toBe(false);
      });

      it('skips validation when medical safe output format detected', () => {
        const result = engine.validateResponse({
          responseText: 'ANSWER:\n- Hypertension — [Medical Records]\n\nNOTE:\n- Diabetes — suspected (not confirmed)',
          decision: makeDecision({ promptBlock: 'grounding', confidence: 0.9 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.status).toBe('skipped');
        expect(result.wasModified).toBe(false);
      });
    });

    // ── Invariants ────────────────────────────────────────────────

    describe('invariants', () => {
      it('never adds new facts to the response', () => {
        const original = 'The answer to your question is that you should rest.';
        const result = engine.validateResponse({
          responseText: original,
          decision: makeDecision({ promptBlock: 'grounding', confidence: 0.8 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        // If modified, the original text must still be fully contained
        if (result.wasModified) {
          expect(result.responseText).toContain(original.trimEnd());
        }
      });

      it('never removes content from the response', () => {
        const original = 'According to the documents, the policy is clear. Based on your evidence, you are entitled to compensation.';
        const result = engine.validateResponse({
          responseText: original,
          decision: makeDecision({ promptBlock: 'grounding', confidence: 0.9 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        });
        // Original content must be preserved (may have additions but no removals)
        expect(result.responseText).toContain(original.trimEnd());
      });

      it('deterministic — same input produces same output', () => {
        const input = {
          responseText: 'The answer is always vitamin C for best results.',
          decision: makeDecision({ promptBlock: 'grounding', confidence: 0.8 }),
          knowledgeCtx: makeKnowledge({ hasKnowledge: true, docChunkCount: 5 }),
        };
        const a = engine.validateResponse(input);
        const b = engine.validateResponse(input);
        expect(a.status).toBe(b.status);
        expect(a.responseText).toBe(b.responseText);
        expect(a.wasModified).toBe(b.wasModified);
        expect(a.reasons).toEqual(b.reasons);
      });

      it('never alters routing or tools (output has no such fields)', () => {
        const result = engine.validateResponse({
          responseText: 'test response',
          decision: makeDecision(),
          knowledgeCtx: makeKnowledge(),
        });
        expect(result).not.toHaveProperty('suppressTools');
        expect(result).not.toHaveProperty('resolvedDomain');
        expect(result).not.toHaveProperty('forceReasoning');
      });

      it('returns all required fields', () => {
        const result = engine.validateResponse({
          responseText: 'test response',
          decision: makeDecision(),
          knowledgeCtx: makeKnowledge(),
        });
        expect(result).toHaveProperty('status');
        expect(result).toHaveProperty('responseText');
        expect(result).toHaveProperty('wasModified');
        expect(result).toHaveProperty('reasons');
        expect(result).toHaveProperty('confidence');
        expect(Array.isArray(result.reasons)).toBe(true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.5: Observability — DecisionSummary
  // ══════════════════════════════════════════════════════════════════

  describe('P8-1.5: DecisionEngine.summarize', () => {

    const engine15 = new DecisionEngine();

    function makeSummary(inputOverrides: Partial<DecisionEngineInput> = {}, advisorDomain?: DecisionDomain): DecisionSummary {
      const input = makeInput(inputOverrides);
      const result = engine15.decide(input);
      return DecisionEngine.summarize(result, advisorDomain ?? input.advisorDecision.detectedDomain);
    }

    // ── Shape stability ──────────────────────────────────────────

    it('returns all required fields', () => {
      const summary = makeSummary();
      const keys: Array<keyof DecisionSummary> = [
        'strategy', 'advisorDomain', 'resolvedDomain', 'forceReasoning',
        'suppressTools', 'promptBlockPresent', 'confidence', 'reasoning',
      ];
      for (const key of keys) {
        expect(summary).toHaveProperty(key);
      }
    });

    it('has correct types for all fields', () => {
      const summary = makeSummary();
      expect(typeof summary.strategy).toBe('string');
      expect(typeof summary.advisorDomain).toBe('string');
      expect(typeof summary.resolvedDomain).toBe('string');
      expect(typeof summary.forceReasoning).toBe('boolean');
      expect(Array.isArray(summary.suppressTools)).toBe(true);
      expect(typeof summary.promptBlockPresent).toBe('boolean');
      expect(typeof summary.confidence).toBe('number');
      expect(typeof summary.reasoning).toBe('string');
    });

    // ── Strategy exposure ────────────────────────────────────────

    it('exposes standard strategy correctly', () => {
      const summary = makeSummary();
      expect(summary.strategy).toBe('standard');
    });

    it('exposes hybrid strategy correctly', () => {
      const summary = makeSummary({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
      });
      expect(summary.strategy).toBe('hybrid');
    });

    it('exposes direct_answer strategy correctly', () => {
      const summary = makeSummary({
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: false },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
      });
      expect(summary.strategy).toBe('direct_answer');
    });

    // ── resolvedDomain exposure ──────────────────────────────────

    it('exposes resolvedDomain correctly', () => {
      const summary = makeSummary({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'medium', toolsRecommended: true },
      });
      expect(summary.resolvedDomain).toBe('medical');
    });

    // ── advisorDomain vs resolvedDomain distinction ──────────────

    it('preserves advisorDomain vs resolvedDomain when normalized', () => {
      const input = makeInput({
        advisorDecision: { detectedDomain: 'bogus' as any, knowledgeConfidence: 'none', toolsRecommended: true },
      });
      const result = engine15.decide(input);
      const summary = DecisionEngine.summarize(result, 'bogus' as any);
      expect(summary.advisorDomain).toBe('bogus');
      expect(summary.resolvedDomain).toBe('general');
    });

    it('advisorDomain matches resolvedDomain for valid domains', () => {
      const summary = makeSummary({
        advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'medium', toolsRecommended: true },
      });
      expect(summary.advisorDomain).toBe('financial');
      expect(summary.resolvedDomain).toBe('financial');
    });

    // ── suppressTools exposure ───────────────────────────────────

    it('exposes empty suppressTools when none suppressed', () => {
      const summary = makeSummary();
      expect(summary.suppressTools).toEqual([]);
    });

    it('exposes suppressed tools accurately', () => {
      const summary = makeSummary({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'medical', queryIntent: 'strategy', retrievalFailed: false },
      });
      expect(summary.suppressTools).toContain('web_search');
    });

    it('suppressTools is a copy (not a reference to internal array)', () => {
      const input = makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'medical', queryIntent: 'strategy', retrievalFailed: false },
      });
      const result = engine15.decide(input);
      const summary = DecisionEngine.summarize(result, 'medical');
      summary.suppressTools.push('fake_tool');
      // Original result must not be mutated
      expect(result.suppressTools).not.toContain('fake_tool');
    });

    // ── promptBlockPresent boolean ───────────────────────────────

    it('promptBlockPresent is false when no knowledge', () => {
      const summary = makeSummary();
      expect(summary.promptBlockPresent).toBe(false);
    });

    it('promptBlockPresent is true when docs are available', () => {
      const summary = makeSummary({
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
      });
      expect(summary.promptBlockPresent).toBe(true);
    });

    it('does NOT expose raw prompt text', () => {
      const summary = makeSummary({
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
      });
      expect(summary).not.toHaveProperty('promptBlock');
    });

    // ── No behaviour change ──────────────────────────────────────

    it('summarize does not modify the original result', () => {
      const input = makeInput({
        advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
      });
      const result = engine15.decide(input);
      const before = JSON.stringify(result);
      DecisionEngine.summarize(result, 'legal');
      expect(JSON.stringify(result)).toBe(before);
    });

    it('is deterministic — same input produces identical summary', () => {
      const input = makeInput({
        advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'medical', queryIntent: 'strategy', retrievalFailed: false },
      });
      const result = engine15.decide(input);
      const a = DecisionEngine.summarize(result, 'medical');
      const b = DecisionEngine.summarize(result, 'medical');
      expect(a).toEqual(b);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.6: Utility Query Fast Path
  // ══════════════════════════════════════════════════════════════════

  describe('P8-1.6: utility query fast path', () => {

    // ── isUtilityQuery detection ─────────────────────────────────

    describe('isUtilityQuery', () => {
      it('detects "what time is it"', () => {
        expect(isUtilityQuery('what time is it')).toBe(true);
        expect(isUtilityQuery('what time is it?')).toBe(true);
      });

      it('detects "what is the date"', () => {
        expect(isUtilityQuery('what is the date')).toBe(true);
        expect(isUtilityQuery('what is the date?')).toBe(true);
      });

      it('detects "what date is it"', () => {
        expect(isUtilityQuery('what date is it')).toBe(true);
        expect(isUtilityQuery('what date is it?')).toBe(true);
        expect(isUtilityQuery('what date is it today?')).toBe(true);
      });

      it('detects "what day is it"', () => {
        expect(isUtilityQuery('what day is it')).toBe(true);
        expect(isUtilityQuery('what day is it today?')).toBe(true);
      });

      it('detects "what is the date today"', () => {
        expect(isUtilityQuery('what is the date today')).toBe(true);
        expect(isUtilityQuery("what's the date today?")).toBe(true);
      });

      it('detects "what\'s the time"', () => {
        expect(isUtilityQuery("what's the time")).toBe(true);
        expect(isUtilityQuery("what's the time?")).toBe(true);
      });

      it('detects "current date" and "today\'s date"', () => {
        expect(isUtilityQuery('current date')).toBe(true);
        expect(isUtilityQuery("today's date")).toBe(true);
        expect(isUtilityQuery('current timestamp')).toBe(true);
      });

      it('detects "date today" and "time?" bare forms', () => {
        expect(isUtilityQuery('date today')).toBe(true);
        expect(isUtilityQuery('date today?')).toBe(true);
        expect(isUtilityQuery('time?')).toBe(true);
      });

      it('detects "current date today"', () => {
        expect(isUtilityQuery('current date today')).toBe(true);
      });

      it('detects "whats" without apostrophe', () => {
        expect(isUtilityQuery('whats the date')).toBe(true);
        expect(isUtilityQuery('whats the time')).toBe(true);
        expect(isUtilityQuery('whats the time?')).toBe(true);
        expect(isUtilityQuery('whats todays date')).toBe(true);
      });

      it('detects "tell me the time"', () => {
        expect(isUtilityQuery('tell me the time')).toBe(true);
        expect(isUtilityQuery('give me the current date')).toBe(true);
      });

      it('detects "what day of the week is it"', () => {
        expect(isUtilityQuery('what day of the week is it')).toBe(true);
        expect(isUtilityQuery('what day of the week is it?')).toBe(true);
      });

      // ── Must NOT match non-utility queries ─────────────────────

      it('does NOT match legal queries', () => {
        expect(isUtilityQuery('what are my legal rights regarding unfair dismissal')).toBe(false);
      });

      it('does NOT match medical queries', () => {
        expect(isUtilityQuery('what does my medical report say about blood pressure')).toBe(false);
      });

      it('does NOT match document queries', () => {
        expect(isUtilityQuery('what does the employment contract say about notice period')).toBe(false);
      });

      it('does NOT match reasoning queries', () => {
        expect(isUtilityQuery('what is the best strategy for my tribunal case')).toBe(false);
      });

      it('does NOT match long queries even with time words', () => {
        expect(isUtilityQuery('what time did the employer send the dismissal letter according to the documents')).toBe(false);
      });

      it('does NOT match document queries containing date words', () => {
        expect(isUtilityQuery('what date did the employer send the dismissal letter')).toBe(false);
        expect(isUtilityQuery('what date is mentioned in the contract')).toBe(false);
        expect(isUtilityQuery('what is the date on the medical report')).toBe(false);
      });

      it('rejects very long strings', () => {
        expect(isUtilityQuery('a'.repeat(100))).toBe(false);
      });

      it('handles empty string', () => {
        expect(isUtilityQuery('')).toBe(false);
      });
    });

    // ── Decision output for utility queries ──────────────────────

    describe('decide() for utility queries', () => {
      it('returns direct_answer strategy', () => {
        const result = engine.decide(makeInput({ query: 'what time is it?' }));
        expect(result.strategy).toBe('direct_answer');
      });

      it('resolves domain to general', () => {
        const result = engine.decide(makeInput({
          query: 'what is the date',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
        }));
        expect(result.resolvedDomain).toBe('general');
      });

      it('does NOT force reasoning', () => {
        const result = engine.decide(makeInput({ query: 'what day is it?' }));
        expect(result.forceReasoning).toBe(false);
      });

      it('has empty suppressTools', () => {
        const result = engine.decide(makeInput({ query: 'current date' }));
        expect(result.suppressTools).toEqual([]);
      });

      it('has empty promptBlock', () => {
        const result = engine.decide(makeInput({
          query: 'what time is it',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.promptBlock).toBe('');
      });

      it('has confidence 1.0', () => {
        const result = engine.decide(makeInput({ query: 'what is the date?' }));
        expect(result.confidence).toBe(1.0);
      });

      it('reasoning mentions utility fast path', () => {
        const result = engine.decide(makeInput({ query: 'what time is it' }));
        expect(result.reasoning).toContain('P8-1.6');
        expect(result.reasoning).toContain('utility');
      });

      it('overrides even when knowledge is present', () => {
        const result = engine.decide(makeInput({
          query: "what's the time?",
          advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 10, detectedDomain: 'medical', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.strategy).toBe('direct_answer');
        expect(result.resolvedDomain).toBe('general');
        expect(result.promptBlock).toBe('');
        expect(result.forceReasoning).toBe(false);
      });
    });

    // ── Post-LLM validator does NOT add noise ────────────────────

    describe('validator skips noise for utility decisions', () => {
      const utilityDecision: DecisionEngineResult = {
        strategy: 'direct_answer',
        resolvedDomain: 'general',
        forceReasoning: false,
        suppressTools: [],
        promptBlock: '',
        confidence: 1.0,
        reasoning: 'P8-1.6: utility query fast path',
      };

      it('does NOT add grounding reminder', () => {
        const result = engine.validateResponse({
          responseText: 'The current time is 14:30 BST.',
          decision: utilityDecision,
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        expect(result.wasModified).toBe(false);
        expect(result.responseText).not.toContain('verified against');
      });

      it('does NOT add uncertainty softening', () => {
        const result = engine.validateResponse({
          responseText: 'It is certain that today is Monday 13th April 2026.',
          decision: utilityDecision,
          knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        expect(result.wasModified).toBe(false);
        expect(result.responseText).not.toContain('available evidence');
      });
    });

    // ── Non-utility queries still work as before ─────────────────

    describe('non-utility queries unaffected', () => {
      it('legal document query still routes normally', () => {
        const result = engine.decide(makeInput({
          query: 'what does the employment contract say',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.strategy).toBe('hybrid');
        expect(result.resolvedDomain).toBe('legal');
        expect(result.promptBlock.length).toBeGreaterThan(0);
      });

      it('medical query still routes normally', () => {
        const result = engine.decide(makeInput({
          query: 'what does my blood test show',
          advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'medical', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.strategy).toBe('hybrid');
        expect(result.resolvedDomain).toBe('medical');
        expect(result.forceReasoning).toBe(true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.7: General Query Default Mode / Retrieval Gating
  // ══════════════════════════════════════════════════════════════════

  describe('P8-1.7 — general query default mode', () => {

    // Helper: general domain with documents present (the bug scenario)
    function makeGeneralWithDocs(query: string) {
      return makeInput({
        query,
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
        knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
      });
    }

    // ── Soft promptBlock for general queries ───────────────────────

    describe('soft promptBlock for general everyday queries', () => {
      it('emits soft promptBlock for pizza toppings query when docs exist', () => {
        const result = engine.decide(makeGeneralWithDocs('What toppings goes on a margarita pizza?'));
        expect(result.promptBlock).toContain('general knowledge');
        expect(result.promptBlock).not.toContain('Base your answer on the retrieved evidence');
      });

      it('emits soft promptBlock for weather query when docs exist', () => {
        const result = engine.decide(makeGeneralWithDocs('Why is the sky blue?'));
        expect(result.promptBlock).toContain('general knowledge');
        expect(result.promptBlock).not.toContain('Do not invent facts');
      });

      it('emits soft promptBlock for trivia query when docs exist', () => {
        const result = engine.decide(makeGeneralWithDocs('Who won the 2024 world cup?'));
        expect(result.promptBlock).toContain('If they are relevant');
        expect(result.promptBlock).toContain('general knowledge');
      });

      it('soft promptBlock still has guidance markers', () => {
        const result = engine.decide(makeGeneralWithDocs('How do you make pasta?'));
        expect(result.promptBlock).toContain('=== Decision Engine Guidance ===');
        expect(result.promptBlock).toContain('=== End Decision Engine Guidance ===');
      });

      it('reasoning trace mentions P8-1.7', () => {
        const result = engine.decide(makeGeneralWithDocs('What is the capital of France?'));
        expect(result.reasoning).toContain('P8-1.7');
      });

      it('soft promptBlock is non-empty (still provides some guidance)', () => {
        const result = engine.decide(makeGeneralWithDocs('tell me a joke'));
        expect(result.promptBlock.length).toBeGreaterThan(0);
      });
    });

    // ── Strict grounding preserved for deep domains ────────────────

    describe('strict grounding preserved for non-general domains', () => {
      it('legal domain still gets strict grounding', () => {
        const result = engine.decide(makeInput({
          query: 'what does the contract say about termination',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
        expect(result.promptBlock).not.toContain('general knowledge');
      });

      it('medical domain still gets strict grounding', () => {
        const result = engine.decide(makeInput({
          query: 'what are my blood test results',
          advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });

      it('financial domain still gets strict grounding', () => {
        const result = engine.decide(makeInput({
          query: 'what does my tax return show',
          advisorDecision: { detectedDomain: 'financial', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 4, detectedDomain: 'financial', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });

      it('technical domain still gets strict grounding', () => {
        const result = engine.decide(makeInput({
          query: 'explain the API schema',
          advisorDecision: { detectedDomain: 'technical', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 2, detectedDomain: 'technical', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });
    });

    // ── Fact extraction in general domain still gets strict grounding ──

    describe('fact extraction still gets strict grounding', () => {
      it('general domain + fact_extraction still uses strict grounding', () => {
        const result = engine.decide(makeInput({
          query: 'what is the date on the document',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
        }));
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
        expect(result.promptBlock).not.toContain('general knowledge');
      });

      it('general domain + strategy intent still uses strict grounding', () => {
        const result = engine.decide(makeInput({
          query: 'summarize the key points',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });
    });

    // ── No promptBlock when no documents ────────────────────────────

    describe('no promptBlock without documents', () => {
      it('general domain without knowledge has empty promptBlock', () => {
        const result = engine.decide(makeInput({
          query: 'What toppings goes on a margarita pizza?',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'none', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.promptBlock).toBe('');
      });

      it('retrieval failure suppresses promptBlock', () => {
        const result = engine.decide(makeInput({
          query: 'What toppings goes on a margarita pizza?',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'none', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: true },
        }));
        expect(result.promptBlock).toBe('');
      });
    });

    // ── Post-LLM validation respects soft promptBlock ──────────────

    describe('post-LLM validation with soft promptBlock', () => {
      const softPrompt = '=== Decision Engine Guidance ===\n' +
        'Retrieved documents are available for reference. ' +
        'If they are relevant to the query, incorporate them. ' +
        'Otherwise, answer from your general knowledge.\n' +
        '=== End Decision Engine Guidance ===';

      it('does NOT flag grounding drift for general answer with soft promptBlock', () => {
        const result = engine.validateResponse({
          responseText: 'A margherita pizza traditionally has tomato sauce, mozzarella cheese, fresh basil, and olive oil.',
          decision: {
            strategy: 'standard',
            resolvedDomain: 'general',
            forceReasoning: false,
            suppressTools: [],
            promptBlock: softPrompt,
            confidence: 0.8,
            reasoning: 'test',
            classificationSource: 'upstream',
            strictGrounding: false,
          },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        expect(result.status).toBe('aligned');
        expect(result.wasModified).toBe(false);
        expect(result.responseText).not.toContain('verified against the retrieved documents');
      });

      it('STILL flags grounding drift for strict promptBlock (legal domain)', () => {
        const result = engine.validateResponse({
          responseText: 'The termination clause allows either party to end the contract with 30 days notice.',
          decision: {
            strategy: 'hybrid',
            resolvedDomain: 'legal',
            forceReasoning: true,
            suppressTools: ['web_search'],
            promptBlock: '=== Decision Engine Guidance ===\n' +
              'Base your answer on the retrieved evidence. ' +
              'If evidence is insufficient or ambiguous, say so explicitly. ' +
              'Do not invent facts not present in the sources.\n' +
              '=== End Decision Engine Guidance ===',
            confidence: 0.95,
            reasoning: 'test',
            classificationSource: 'upstream',
            strictGrounding: true,
          },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        });
        // No grounded language in response → should flag
        expect(result.wasModified).toBe(true);
        expect(result.responseText).toContain('verified against the retrieved documents');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.8: Domain / Intent Classification Audit & Hardening
  // ══════════════════════════════════════════════════════════════════

  describe('P8-1.8 — classification hardening', () => {

    // Helper: simulate upstream classifying as 'general' (the misclassification scenario)
    function makeGeneralMisclass(query: string, opts: { hasKnowledge?: boolean; docChunkCount?: number; queryIntent?: 'fact_extraction' | 'strategy' | 'general' } = {}) {
      return makeInput({
        query,
        advisorDecision: { detectedDomain: 'general', knowledgeConfidence: opts.hasKnowledge ? 'medium' : 'none', toolsRecommended: true },
        knowledgeCtx: {
          hasKnowledge: opts.hasKnowledge ?? true,
          docChunkCount: opts.docChunkCount ?? 5,
          detectedDomain: 'general',
          queryIntent: opts.queryIntent ?? 'general',
          retrievalFailed: false,
        },
      });
    }

    // ── Rule 1: Legal markers must not classify as general ──────────

    describe('legal marker rescue', () => {
      it('rescues "reasonable adjustments" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('Tell me about reasonable adjustments at work'));
        expect(result.resolvedDomain).toBe('legal');
        expect(result.reasoning).toContain('P8-1.8');
      });

      it('rescues "ET1 form" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('How do I fill in an ET1'));
        expect(result.resolvedDomain).toBe('legal');
      });

      it('rescues "ET3" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('When is the ET3 deadline'));
        expect(result.resolvedDomain).toBe('legal');
      });

      it('rescues "discrimination" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('Is this discrimination'));
        expect(result.resolvedDomain).toBe('legal');
      });

      it('rescues "dismissal" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('Was my dismissal unfair'));
        expect(result.resolvedDomain).toBe('legal');
      });

      it('rescues "tribunal" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('What happens at a tribunal'));
        expect(result.resolvedDomain).toBe('legal');
      });

      it('rescues "grievance" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('How do I raise a grievance'));
        expect(result.resolvedDomain).toBe('legal');
      });

      it('rescues "claimant" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('Am I the claimant'));
        expect(result.resolvedDomain).toBe('legal');
      });

      it('rescues "respondent" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('Who is the respondent'));
        expect(result.resolvedDomain).toBe('legal');
      });

      it('rescues "redundancy" from general to legal', () => {
        const result = engine.decide(makeGeneralMisclass('What are my redundancy rights'));
        expect(result.resolvedDomain).toBe('legal');
      });

      it('legal rescue gets strict grounding when docs present', () => {
        const result = engine.decide(makeGeneralMisclass('Tell me about reasonable adjustments'));
        expect(result.resolvedDomain).toBe('legal');
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });

      it('legal rescue forces reasoning model', () => {
        const result = engine.decide(makeGeneralMisclass('Was this discrimination by my employer'));
        expect(result.resolvedDomain).toBe('legal');
        expect(result.forceReasoning).toBe(true);
      });
    });

    // ── Rule 1: Medical markers must not classify as general ────────

    describe('medical marker rescue', () => {
      it('rescues "shortness of breath" from general to medical', () => {
        const result = engine.decide(makeGeneralMisclass('I have shortness of breath'));
        expect(result.resolvedDomain).toBe('medical');
        expect(result.reasoning).toContain('P8-1.8');
      });

      it('rescues "pregnant" from general to medical', () => {
        const result = engine.decide(makeGeneralMisclass('I am pregnant'));
        expect(result.resolvedDomain).toBe('medical');
      });

      it('rescues "pregnancy" from general to medical', () => {
        const result = engine.decide(makeGeneralMisclass('Tell me about my pregnancy'));
        expect(result.resolvedDomain).toBe('medical');
      });

      it('rescues "bleeding" from general to medical', () => {
        const result = engine.decide(makeGeneralMisclass('I am bleeding heavily'));
        expect(result.resolvedDomain).toBe('medical');
      });

      it('rescues "severe pain" from general to medical', () => {
        const result = engine.decide(makeGeneralMisclass('I have severe pain in my chest'));
        expect(result.resolvedDomain).toBe('medical');
      });

      it('rescues "chest pain" from general to medical', () => {
        const result = engine.decide(makeGeneralMisclass('I am experiencing chest pain'));
        expect(result.resolvedDomain).toBe('medical');
      });

      it('rescues "symptoms" from general to medical', () => {
        const result = engine.decide(makeGeneralMisclass('What are the symptoms of diabetes'));
        expect(result.resolvedDomain).toBe('medical');
      });

      it('rescues "diagnosis" from general to medical', () => {
        const result = engine.decide(makeGeneralMisclass('What does my diagnosis mean'));
        expect(result.resolvedDomain).toBe('medical');
      });

      it('rescues "medication" from general to medical', () => {
        const result = engine.decide(makeGeneralMisclass('Should I take this medication'));
        expect(result.resolvedDomain).toBe('medical');
      });

      it('medical rescue gets strict grounding when docs present', () => {
        const result = engine.decide(makeGeneralMisclass('I have shortness of breath'));
        expect(result.resolvedDomain).toBe('medical');
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });

      it('medical rescue forces reasoning model', () => {
        const result = engine.decide(makeGeneralMisclass('Is this pregnancy related'));
        expect(result.resolvedDomain).toBe('medical');
        expect(result.forceReasoning).toBe(true);
      });
    });

    // ── Rule 2: Document/case references preserve strict grounding ──

    describe('document reference detection', () => {
      it('isDocumentReferenceQuery detects "based on my documents"', () => {
        expect(isDocumentReferenceQuery('based on my documents, what should I know')).toBe(true);
      });

      it('isDocumentReferenceQuery detects "from my uploaded emails"', () => {
        expect(isDocumentReferenceQuery('from my uploaded emails tell me about the meeting')).toBe(true);
      });

      it('isDocumentReferenceQuery detects "what do my documents say"', () => {
        expect(isDocumentReferenceQuery('what do my documents say about holidays')).toBe(true);
      });

      it('isDocumentReferenceQuery detects "in my case"', () => {
        expect(isDocumentReferenceQuery('in my case what happened next')).toBe(true);
      });

      it('isDocumentReferenceQuery detects "what evidence"', () => {
        expect(isDocumentReferenceQuery('what evidence supports this')).toBe(true);
      });

      it('isDocumentReferenceQuery detects "according to the documents"', () => {
        expect(isDocumentReferenceQuery('according to the documents, what is the date')).toBe(true);
      });

      it('isDocumentReferenceQuery detects "from my files"', () => {
        expect(isDocumentReferenceQuery('from my files what is the total')).toBe(true);
      });

      it('isDocumentReferenceQuery returns false for ordinary queries', () => {
        expect(isDocumentReferenceQuery('what toppings go on a pizza')).toBe(false);
        expect(isDocumentReferenceQuery('why is the sky blue')).toBe(false);
        expect(isDocumentReferenceQuery('how do I cook pasta')).toBe(false);
      });

      it('document reference + general domain gets STRICT grounding', () => {
        const result = engine.decide(makeGeneralMisclass('based on my documents, tell me about cooking'));
        // Domain stays general but grounding must be strict
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
        expect(result.promptBlock).not.toContain('general knowledge');
        expect(result.reasoning).toContain('P8-1.8');
      });

      it('document reference + general intent gets STRICT grounding', () => {
        const result = engine.decide(makeGeneralMisclass('from my uploaded emails what happened'));
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });

      it('"in my case" forces strict grounding even for general domain', () => {
        const result = engine.decide(makeGeneralMisclass('in my case what are the key dates'));
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });
    });

    // ── Rule 3: Ordinary everyday queries remain general ────────────

    describe('ordinary everyday queries stay general', () => {
      it('pizza query stays general', () => {
        const result = engine.decide(makeGeneralMisclass('What toppings go on a margarita pizza'));
        expect(result.resolvedDomain).toBe('general');
        expect(result.promptBlock).toContain('general knowledge');
      });

      it('cooking query stays general', () => {
        const result = engine.decide(makeGeneralMisclass('How do I make spaghetti bolognese'));
        expect(result.resolvedDomain).toBe('general');
        expect(result.promptBlock).toContain('general knowledge');
      });

      it('music query stays general', () => {
        const result = engine.decide(makeGeneralMisclass('Who wrote Bohemian Rhapsody'));
        expect(result.resolvedDomain).toBe('general');
      });

      it('simple how-to stays general', () => {
        const result = engine.decide(makeGeneralMisclass('How do I change a car tyre'));
        expect(result.resolvedDomain).toBe('general');
      });

      it('trivia stays general', () => {
        const result = engine.decide(makeGeneralMisclass('What is the tallest building in the world'));
        expect(result.resolvedDomain).toBe('general');
      });
    });

    // ── Rule 4: Utility fast path still works ────────────────────────

    describe('utility fast path preserved', () => {
      it('time query still hits utility fast path', () => {
        const result = engine.decide(makeGeneralMisclass('what time is it'));
        expect(result.strategy).toBe('direct_answer');
        expect(result.promptBlock).toBe('');
        expect(result.confidence).toBe(1.0);
      });

      it('date query still hits utility fast path', () => {
        const result = engine.decide(makeGeneralMisclass('whats the date today'));
        expect(result.strategy).toBe('direct_answer');
        expect(result.promptBlock).toBe('');
      });
    });

    // ── Cross-cutting: rescue does NOT fire when upstream is correct ─

    describe('rescue does not override correct upstream classification', () => {
      it('legal domain from upstream is preserved (no double-rescue)', () => {
        const result = engine.decide(makeInput({
          query: 'Tell me about reasonable adjustments',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.resolvedDomain).toBe('legal');
        expect(result.reasoning).not.toContain('rescued'); // already legal, no rescue needed
      });

      it('medical domain from upstream is preserved (no double-rescue)', () => {
        const result = engine.decide(makeInput({
          query: 'I have shortness of breath',
          advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.resolvedDomain).toBe('medical');
        expect(result.reasoning).not.toContain('rescued');
      });
    });

    // ── Legal + document queries preserve full specialist behaviour ──

    describe('legal document queries preserve specialist behaviour', () => {
      it('legal strategy query with docs gets hybrid strategy', () => {
        const result = engine.decide(makeInput({
          query: 'Based on my documents, what are my strongest arguments for discrimination',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.resolvedDomain).toBe('legal');
        expect(result.strategy).toBe('hybrid');
        expect(result.forceReasoning).toBe(true);
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });

      it('rescued legal query with docs gets strict grounding', () => {
        // Upstream misclassified as general, rescue catches it
        const result = engine.decide(makeGeneralMisclass(
          'Do I qualify for reasonable adjustments based on my documents',
        ));
        expect(result.resolvedDomain).toBe('legal');
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
        expect(result.forceReasoning).toBe(true);
      });
    });

    // ── Medical safety queries preserve specialist behaviour ─────────

    describe('medical safety queries preserve specialist behaviour', () => {
      it('medical query with docs gets strict grounding + suppressed web search', () => {
        const result = engine.decide(makeInput({
          query: 'What does my diagnosis mean',
          advisorDecision: { detectedDomain: 'medical', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'medical', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.resolvedDomain).toBe('medical');
        expect(result.forceReasoning).toBe(true);
        expect(result.suppressTools).toContain('web_search');
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });

      it('rescued medical query gets strict grounding', () => {
        const result = engine.decide(makeGeneralMisclass('I am pregnant and worried'));
        expect(result.resolvedDomain).toBe('medical');
        expect(result.forceReasoning).toBe(true);
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });
    });

    // ── No regression in general assistant queries ───────────────────

    describe('no regression in general assistant queries', () => {
      it('general query without docs has empty promptBlock', () => {
        const result = engine.decide(makeInput({
          query: 'How do I cook rice',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'none', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.resolvedDomain).toBe('general');
        expect(result.promptBlock).toBe('');
        expect(result.strategy).toBe('standard');
      });

      it('general query with docs gets soft grounding (P8-1.7 preserved)', () => {
        const result = engine.decide(makeGeneralMisclass('Tell me about the history of jazz'));
        expect(result.resolvedDomain).toBe('general');
        expect(result.promptBlock).toContain('general knowledge');
        expect(result.promptBlock).not.toContain('Base your answer on the retrieved evidence');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.9: Live Response Audit & Debug Surface
  // ══════════════════════════════════════════════════════════════════

  describe('P8-1.9 — execution trace & extended summary', () => {

    // ── ExecutionTrace shape stability ───────────────────────────────

    describe('executionTrace shape', () => {
      it('has all required top-level fields', () => {
        const input = makeInput({
          query: 'test query',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);

        expect(trace.stage).toBe('decision');
        expect(typeof trace.strategy).toBe('string');
        expect(typeof trace.advisorDomain).toBe('string');
        expect(typeof trace.resolvedDomain).toBe('string');
        expect(typeof trace.classificationSource).toBe('string');
        expect(typeof trace.queryIntent).toBe('string');
        expect(typeof trace.confidence).toBe('number');
      });

      it('has flags sub-object with all boolean fields', () => {
        const input = makeInput();
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);

        expect(typeof trace.flags.utility).toBe('boolean');
        expect(typeof trace.flags.documentReference).toBe('boolean');
        expect(typeof trace.flags.forcedReasoning).toBe('boolean');
        expect(typeof trace.flags.strictGrounding).toBe('boolean');
      });

      it('has knowledge sub-object with correct types', () => {
        const input = makeInput({
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 7, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);

        expect(typeof trace.knowledge.hasKnowledge).toBe('boolean');
        expect(typeof trace.knowledge.docChunkCount).toBe('number');
        expect(typeof trace.knowledge.retrievalFailed).toBe('boolean');
        expect(trace.knowledge.hasKnowledge).toBe(true);
        expect(trace.knowledge.docChunkCount).toBe(7);
        expect(trace.knowledge.retrievalFailed).toBe(false);
      });
    });

    // ── classificationSource accuracy ─────────────────────────────────

    describe('classificationSource', () => {
      it('returns "upstream" for normal general query', () => {
        const input = makeInput({
          query: 'how do I cook pasta',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.classificationSource).toBe('upstream');
      });

      it('returns "upstream" for correctly classified legal query', () => {
        const input = makeInput({
          query: 'what does the contract say',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.classificationSource).toBe('upstream');
      });

      it('returns "rescued_legal" when domain rescued from general to legal', () => {
        const input = makeInput({
          query: 'tell me about reasonable adjustments',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.classificationSource).toBe('rescued_legal');
      });

      it('returns "rescued_medical" when domain rescued from general to medical', () => {
        const input = makeInput({
          query: 'I have shortness of breath',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.classificationSource).toBe('rescued_medical');
      });

      it('returns "utility_fast_path" for utility queries', () => {
        const input = makeInput({ query: 'what time is it' });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.classificationSource).toBe('utility_fast_path');
      });
    });

    // ── Flags accuracy ────────────────────────────────────────────────

    describe('flags accuracy', () => {
      it('utility flag true for time query', () => {
        const input = makeInput({ query: 'what time is it' });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.utility).toBe(true);
        expect(trace.flags.documentReference).toBe(false);
      });

      it('utility flag false for normal query', () => {
        const input = makeInput({ query: 'how do I cook pasta' });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.utility).toBe(false);
      });

      it('documentReference flag true for doc reference query', () => {
        const input = makeInput({
          query: 'based on my documents what happened',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.documentReference).toBe(true);
      });

      it('documentReference flag false for everyday query', () => {
        const input = makeInput({ query: 'what is the weather like' });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.documentReference).toBe(false);
      });

      it('forcedReasoning true for legal domain', () => {
        const input = makeInput({
          query: 'what does the contract say',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.forcedReasoning).toBe(true);
      });

      it('forcedReasoning false for general domain', () => {
        const input = makeInput({ query: 'how do I cook pasta' });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.forcedReasoning).toBe(false);
      });

      it('strictGrounding true for legal domain with docs', () => {
        const input = makeInput({
          query: 'what does my contract say about termination',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.strictGrounding).toBe(true);
      });

      it('strictGrounding false for general everyday query with docs', () => {
        const input = makeInput({
          query: 'how do I cook pasta',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.strictGrounding).toBe(false);
      });

      it('strictGrounding false for utility queries', () => {
        const input = makeInput({ query: 'what time is it' });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.flags.strictGrounding).toBe(false);
      });
    });

    // ── Knowledge fields accuracy ─────────────────────────────────────

    describe('knowledge fields', () => {
      it('reflects hasKnowledge true', () => {
        const input = makeInput({
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.knowledge.hasKnowledge).toBe(true);
        expect(trace.knowledge.docChunkCount).toBe(5);
      });

      it('reflects hasKnowledge false', () => {
        const input = makeInput();
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.knowledge.hasKnowledge).toBe(false);
        expect(trace.knowledge.docChunkCount).toBe(0);
      });

      it('reflects retrievalFailed', () => {
        const input = makeInput({
          knowledgeCtx: { hasKnowledge: false, docChunkCount: 0, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: true },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.knowledge.retrievalFailed).toBe(true);
      });
    });

    // ── Trace matches DecisionSummary (no contradictions) ─────────────

    describe('trace consistency with DecisionSummary', () => {
      it('strategy matches between trace and summary', () => {
        const input = makeInput({
          query: 'what does my contract say',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain, input);

        expect(trace.strategy).toBe(summary.strategy);
        expect(trace.resolvedDomain).toBe(summary.resolvedDomain);
        expect(trace.advisorDomain).toBe(summary.advisorDomain);
        expect(trace.confidence).toBe(summary.confidence);
      });

      it('classification source matches between trace and summary', () => {
        const input = makeInput({
          query: 'tell me about reasonable adjustments',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain, input);

        expect(trace.classificationSource).toBe(summary.classificationSource);
      });

      it('knowledge fields match between trace and summary', () => {
        const input = makeInput({
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 8, detectedDomain: 'general', queryIntent: 'fact_extraction', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain, input);

        expect(trace.knowledge.hasKnowledge).toBe(summary.hasKnowledge);
        expect(trace.knowledge.docChunkCount).toBe(summary.docChunkCount);
        expect(trace.knowledge.retrievalFailed).toBe(summary.retrievalFailed);
        expect(trace.queryIntent).toBe(summary.queryIntent);
      });
    });

    // ── No mutation of original decision result ──────────────────────

    describe('no mutation', () => {
      it('buildExecutionTrace does not mutate the decision result', () => {
        const input = makeInput({
          query: 'legal question about discrimination',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const resultCopy = JSON.parse(JSON.stringify(result));

        DecisionEngine.buildExecutionTrace(result, input);

        expect(result).toEqual(resultCopy);
      });

      it('summarize does not mutate the decision result', () => {
        const input = makeInput();
        const result = engine.decide(input);
        const resultCopy = JSON.parse(JSON.stringify(result));

        DecisionEngine.summarize(result, input.advisorDecision.detectedDomain, input);

        expect(result).toEqual(resultCopy);
      });
    });

    // ── Extended DecisionSummary fields ────────────────────────────────

    describe('extended DecisionSummary (P8-1.9)', () => {
      it('includes P8-1.9 fields when input is provided', () => {
        const input = makeInput({
          query: 'how do I cook rice',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain, input);

        expect(summary.queryIntent).toBe('general');
        expect(summary.hasKnowledge).toBe(true);
        expect(summary.docChunkCount).toBe(3);
        expect(summary.retrievalFailed).toBe(false);
        expect(summary.isUtilityQuery).toBe(false);
        expect(summary.isDocumentReference).toBe(false);
        expect(summary.classificationSource).toBe('upstream');
      });

      it('omits input-dependent P8-1.9 fields when input is not provided (backward compat)', () => {
        const input = makeInput();
        const result = engine.decide(input);
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain);

        // Input-dependent fields should be absent
        expect(summary.queryIntent).toBeUndefined();
        expect(summary.hasKnowledge).toBeUndefined();
        // P8-1.10: classificationSource is always present (from result)
        expect(summary.classificationSource).toBe('upstream');
      });

      it('isUtilityQuery true for utility queries', () => {
        const input = makeInput({ query: 'what time is it' });
        const result = engine.decide(input);
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain, input);
        expect(summary.isUtilityQuery).toBe(true);
      });

      it('isDocumentReference true for document queries', () => {
        const input = makeInput({
          query: 'based on my documents what happened',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain, input);
        expect(summary.isDocumentReference).toBe(true);
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.10: Structured Classification Source Hardening
  // ══════════════════════════════════════════════════════════════════

  describe('P8-1.10 — structured classificationSource', () => {

    // ── classificationSource is a first-class field on DecisionEngineResult ──

    describe('classificationSource on result', () => {
      it('upstream for normal general query', () => {
        const result = engine.decide(makeInput({
          query: 'how do I cook pasta',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.classificationSource).toBe('upstream');
      });

      it('upstream for correctly classified legal query', () => {
        const result = engine.decide(makeInput({
          query: 'what does the contract say',
          advisorDecision: { detectedDomain: 'legal', knowledgeConfidence: 'high', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'legal', queryIntent: 'strategy', retrievalFailed: false },
        }));
        expect(result.classificationSource).toBe('upstream');
      });

      it('rescued_legal when domain rescued from general', () => {
        const result = engine.decide(makeInput({
          query: 'tell me about reasonable adjustments',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.classificationSource).toBe('rescued_legal');
      });

      it('rescued_medical when domain rescued from general', () => {
        const result = engine.decide(makeInput({
          query: 'I have shortness of breath',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.classificationSource).toBe('rescued_medical');
      });

      it('utility_fast_path for utility queries', () => {
        const result = engine.decide(makeInput({ query: 'what time is it' }));
        expect(result.classificationSource).toBe('utility_fast_path');
      });
    });

    // ── summarize() reads from structured field ─────────────────────

    describe('summarize() uses structured field', () => {
      it('summary.classificationSource matches result.classificationSource for upstream', () => {
        const input = makeInput({ query: 'how do I cook pasta' });
        const result = engine.decide(input);
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain, input);
        expect(summary.classificationSource).toBe(result.classificationSource);
        expect(summary.classificationSource).toBe('upstream');
      });

      it('summary.classificationSource matches result.classificationSource for rescued_legal', () => {
        const input = makeInput({
          query: 'what about discrimination',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain, input);
        expect(summary.classificationSource).toBe('rescued_legal');
        expect(summary.classificationSource).toBe(result.classificationSource);
      });

      it('summary.classificationSource available even without input (backward compat)', () => {
        const input = makeInput({ query: 'what time is it' });
        const result = engine.decide(input);
        // No input passed — should still get classificationSource from result
        const summary = DecisionEngine.summarize(result, input.advisorDecision.detectedDomain);
        expect(summary.classificationSource).toBe('utility_fast_path');
      });
    });

    // ── buildExecutionTrace() uses structured field ──────────────────

    describe('buildExecutionTrace() uses structured field', () => {
      it('trace.classificationSource matches result.classificationSource', () => {
        const input = makeInput({
          query: 'I am pregnant and worried',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 3, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        const trace = DecisionEngine.buildExecutionTrace(result, input);
        expect(trace.classificationSource).toBe('rescued_medical');
        expect(trace.classificationSource).toBe(result.classificationSource);
      });
    });

    // ── Changing reasoning text does NOT affect classificationSource ──

    describe('independence from reasoning text', () => {
      it('classificationSource is correct even if reasoning text is modified', () => {
        const input = makeInput({
          query: 'tell me about redundancy',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        });
        const result = engine.decide(input);
        expect(result.classificationSource).toBe('rescued_legal');

        // Tamper with reasoning text — classificationSource must survive
        const tamperedResult = { ...result, reasoning: 'completely different text with no markers' };
        const trace = DecisionEngine.buildExecutionTrace(tamperedResult, input);
        expect(trace.classificationSource).toBe('rescued_legal');

        const summary = DecisionEngine.summarize(tamperedResult, input.advisorDecision.detectedDomain, input);
        expect(summary.classificationSource).toBe('rescued_legal');
      });

      it('utility classificationSource survives reasoning tampering', () => {
        const input = makeInput({ query: 'what time is it' });
        const result = engine.decide(input);
        const tamperedResult = { ...result, reasoning: 'no utility mention here' };
        const trace = DecisionEngine.buildExecutionTrace(tamperedResult, input);
        expect(trace.classificationSource).toBe('utility_fast_path');
      });
    });

    // ── No routing/behaviour regression ──────────────────────────────

    describe('no behaviour regression', () => {
      it('legal rescue still produces correct routing', () => {
        const result = engine.decide(makeInput({
          query: 'what about my grievance',
          advisorDecision: { detectedDomain: 'general', knowledgeConfidence: 'medium', toolsRecommended: true },
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.classificationSource).toBe('rescued_legal');
        expect(result.resolvedDomain).toBe('legal');
        expect(result.forceReasoning).toBe(true);
        expect(result.promptBlock).toContain('Base your answer on the retrieved evidence');
      });

      it('general query still routes correctly', () => {
        const result = engine.decide(makeInput({
          query: 'what toppings go on pizza',
          knowledgeCtx: { hasKnowledge: true, docChunkCount: 5, detectedDomain: 'general', queryIntent: 'general', retrievalFailed: false },
        }));
        expect(result.classificationSource).toBe('upstream');
        expect(result.resolvedDomain).toBe('general');
        expect(result.promptBlock).toContain('general knowledge');
      });

      it('utility fast path still works', () => {
        const result = engine.decide(makeInput({ query: 'whats the date today' }));
        expect(result.classificationSource).toBe('utility_fast_path');
        expect(result.strategy).toBe('direct_answer');
        expect(result.promptBlock).toBe('');
      });
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // P8-1.11: Decision Validation Observability
  // ══════════════════════════════════════════════════════════════════

  describe('P8-1.11 — validation summary', () => {

    // Re-use the makeDecision/makeKnowledge helpers from validateResponse section
    function makeDecisionResult(overrides: Partial<DecisionEngineResult> = {}): DecisionEngineResult {
      return {
        strategy: 'standard',
        resolvedDomain: 'general',
        forceReasoning: false,
        suppressTools: [],
        promptBlock: '',
        confidence: 1.0,
        reasoning: 'test',
        classificationSource: 'upstream',
        strictGrounding: false,
        ...overrides,
      };
    }

    function makeKnowledgeCtx(overrides: Partial<import('../../src/reasoning/decision-engine.js').DecisionKnowledgeContext> = {}) {
      return {
        hasKnowledge: false,
        docChunkCount: 0,
        detectedDomain: 'general' as const,
        queryIntent: 'general' as const,
        retrievalFailed: false,
        ...overrides,
      };
    }

    // ── Aligned validation summary shape ──────────────────────────────

    describe('aligned validation summary', () => {
      it('has correct shape for aligned response', () => {
        const result = engine.validateResponse({
          responseText: 'According to the documents, the answer is 42.',
          decision: makeDecisionResult({ promptBlock: 'Base your answer on the retrieved evidence', confidence: 0.9 }),
          knowledgeCtx: makeKnowledgeCtx({ hasKnowledge: true, docChunkCount: 5 }),
        });
        const summary = DecisionEngine.summarizeValidation(result);

        expect(summary.status).toBe('aligned');
        expect(summary.modified).toBe(false);
        expect(summary.safetyGuardSkip).toBe(false);
        expect(summary.groundingDriftDetected).toBe(false);
        expect(summary.uncertaintySoftened).toBe(false);
        expect(summary.confidence).toBe(1.0);
        expect(Array.isArray(summary.reasons)).toBe(true);
      });
    });

    // ── Modified validation summary shape ─────────────────────────────

    describe('modified validation summary', () => {
      it('grounding drift produces modified summary', () => {
        // P8-1.12c: strictGrounding=true triggers grounding drift
        const result = engine.validateResponse({
          responseText: 'The answer to your question is that you should take vitamin C daily.',
          decision: makeDecisionResult({ strictGrounding: true, confidence: 0.8, resolvedDomain: 'legal' }),
          knowledgeCtx: makeKnowledgeCtx({ hasKnowledge: true, docChunkCount: 5 }),
        });
        const summary = DecisionEngine.summarizeValidation(result);

        expect(summary.status).toBe('modified');
        expect(summary.modified).toBe(true);
        expect(summary.groundingDriftDetected).toBe(true);
        expect(summary.uncertaintySoftened).toBe(false);
        expect(summary.safetyGuardSkip).toBe(false);
      });

      it('uncertainty softening produces modified summary', () => {
        const result = engine.validateResponse({
          responseText: 'It is certain that this is the correct interpretation of the law.',
          decision: makeDecisionResult({ confidence: 0.3 }),
          knowledgeCtx: makeKnowledgeCtx({ retrievalFailed: true }),
        });
        const summary = DecisionEngine.summarizeValidation(result);

        expect(summary.status).toBe('modified');
        expect(summary.modified).toBe(true);
        expect(summary.uncertaintySoftened).toBe(true);
        expect(summary.groundingDriftDetected).toBe(false);
        expect(summary.safetyGuardSkip).toBe(false);
      });
    });

    // ── Skipped validation summary shape ──────────────────────────────

    describe('skipped validation summary', () => {
      it('safety guard skip produces correct summary', () => {
        const result = engine.validateResponse({
          responseText: 'The identity of your employer is not explicitly stated in the provided documents.',
          decision: makeDecisionResult({ promptBlock: 'Base your answer on the retrieved evidence' }),
          knowledgeCtx: makeKnowledgeCtx({ hasKnowledge: true, docChunkCount: 5 }),
        });
        const summary = DecisionEngine.summarizeValidation(result);

        expect(summary.status).toBe('skipped');
        expect(summary.modified).toBe(false);
        expect(summary.safetyGuardSkip).toBe(true);
        expect(summary.groundingDriftDetected).toBe(false);
        expect(summary.uncertaintySoftened).toBe(false);
      });

      it('medical guard skip produces correct summary', () => {
        const result = engine.validateResponse({
          responseText: 'Not explicitly stated in the provided medical documents.',
          decision: makeDecisionResult(),
          knowledgeCtx: makeKnowledgeCtx(),
        });
        const summary = DecisionEngine.summarizeValidation(result);

        expect(summary.status).toBe('skipped');
        expect(summary.safetyGuardSkip).toBe(true);
      });
    });

    // ── Structured flags on DecisionValidationResult ──────────────────

    describe('structured flags on validation result', () => {
      it('safetyGuardSkip true on safety-guarded response', () => {
        const result = engine.validateResponse({
          responseText: 'The identity of your manager is not explicitly stated in the provided documents.',
          decision: makeDecisionResult(),
          knowledgeCtx: makeKnowledgeCtx(),
        });
        expect(result.safetyGuardSkip).toBe(true);
        expect(result.groundingDriftDetected).toBe(false);
        expect(result.uncertaintySoftened).toBe(false);
      });

      it('groundingDriftDetected true when drift occurs', () => {
        // P8-1.12c: strictGrounding=true triggers grounding drift
        const result = engine.validateResponse({
          responseText: 'You should definitely do X and Y without question.',
          decision: makeDecisionResult({ strictGrounding: true, confidence: 0.8, resolvedDomain: 'medical' }),
          knowledgeCtx: makeKnowledgeCtx({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.groundingDriftDetected).toBe(true);
        expect(result.safetyGuardSkip).toBe(false);
      });

      it('uncertaintySoftened true when softening applied', () => {
        const result = engine.validateResponse({
          responseText: 'It is certain that the answer is correct beyond any doubt.',
          decision: makeDecisionResult({ confidence: 0.3 }),
          knowledgeCtx: makeKnowledgeCtx({ retrievalFailed: true }),
        });
        expect(result.uncertaintySoftened).toBe(true);
        expect(result.safetyGuardSkip).toBe(false);
      });

      it('all flags false for normally aligned response', () => {
        const result = engine.validateResponse({
          responseText: 'Based on the uploaded documents, the contract specifies a 3-month notice period.',
          decision: makeDecisionResult({ promptBlock: 'Base your answer on the retrieved evidence', confidence: 0.9 }),
          knowledgeCtx: makeKnowledgeCtx({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.safetyGuardSkip).toBe(false);
        expect(result.groundingDriftDetected).toBe(false);
        expect(result.uncertaintySoftened).toBe(false);
      });

      it('all flags false for short response', () => {
        const result = engine.validateResponse({
          responseText: 'OK',
          decision: makeDecisionResult(),
          knowledgeCtx: makeKnowledgeCtx(),
        });
        expect(result.safetyGuardSkip).toBe(false);
        expect(result.groundingDriftDetected).toBe(false);
        expect(result.uncertaintySoftened).toBe(false);
      });
    });

    // ── Summary does not depend on parsing reasoning text ─────────────

    describe('no string-parsing dependency', () => {
      it('summary reads structured fields not reasons text', () => {
        // Create a result with misleading reasons text but correct flags
        const fakeResult: DecisionValidationResult = {
          status: 'aligned',
          responseText: 'test',
          wasModified: false,
          reasons: ['grounding drift: something happened'],  // misleading text
          confidence: 1.0,
          safetyGuardSkip: false,
          groundingDriftDetected: false,  // flag says no drift
          uncertaintySoftened: false,
        };
        const summary = DecisionEngine.summarizeValidation(fakeResult);
        // Summary should trust the structured flag, not the reasons text
        expect(summary.groundingDriftDetected).toBe(false);
        expect(summary.status).toBe('aligned');
      });
    });

    // ── No behaviour change in answers ────────────────────────────────

    describe('no behaviour change', () => {
      it('grounding drift still appends reminder (behaviour preserved)', () => {
        // P8-1.12c: strictGrounding=true triggers grounding drift
        const result = engine.validateResponse({
          responseText: 'The policy allows for 28 days leave per year.',
          decision: makeDecisionResult({ strictGrounding: true, confidence: 0.9, resolvedDomain: 'financial' }),
          knowledgeCtx: makeKnowledgeCtx({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(true);
        expect(result.responseText).toContain('verified against the retrieved documents');
        expect(result.groundingDriftDetected).toBe(true);
      });

      it('uncertainty softening still appends note (behaviour preserved)', () => {
        const result = engine.validateResponse({
          responseText: 'It is certain that this conclusion is definitively correct.',
          decision: makeDecisionResult({ confidence: 0.3 }),
          knowledgeCtx: makeKnowledgeCtx({ retrievalFailed: true }),
        });
        expect(result.wasModified).toBe(true);
        expect(result.responseText).toContain('available evidence for this response is limited');
        expect(result.uncertaintySoftened).toBe(true);
      });

      it('safety guard skip still preserves response (behaviour preserved)', () => {
        const originalText = 'The identity of your doctor is not explicitly stated in the provided documents.';
        const result = engine.validateResponse({
          responseText: originalText,
          decision: makeDecisionResult({ promptBlock: 'Base your answer on the retrieved evidence' }),
          knowledgeCtx: makeKnowledgeCtx({ hasKnowledge: true, docChunkCount: 5 }),
        });
        expect(result.wasModified).toBe(false);
        expect(result.responseText).toBe(originalText);
        expect(result.safetyGuardSkip).toBe(true);
      });
    });
  });
});
