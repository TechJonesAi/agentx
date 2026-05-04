/**
 * P8-1: Decision Engine
 *
 * Central routing and strategy layer that sits between knowledge retrieval /
 * advisor orchestration and the downstream execution paths (hybrid pipeline,
 * standard LLM flow, streaming).
 *
 * Phase 1.0: transparent pass-through infrastructure.
 * Phase 1.1: first real advisory logic (pre-LLM).
 * Phase 1.2: post-LLM response validation.
 *
 * RULES:
 *   - Deterministic, synchronous, no LLM / DB / network calls
 *   - Zero-arg constructor (consistent with all reasoning engines)
 *   - Default behaviour preserves existing routing exactly
 *   - suppressTools may only REMOVE tools, never add
 *   - Cannot weaken medical / legal safety gates
 *   - Cannot override red-flag hard gate (handled upstream)
 */

import { createLogger } from '../logger.js';

const log = createLogger('reasoning:decision-engine');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Domain classification — mirrors AdvisorDecision.detectedDomain */
export type DecisionDomain = 'legal' | 'medical' | 'technical' | 'financial' | 'general';

/** Execution strategy — which pipeline to use */
export type DecisionStrategy = 'hybrid' | 'standard' | 'direct_answer';

/** Minimal subset of KnowledgeContext needed by the Decision Engine */
export interface DecisionKnowledgeContext {
  hasKnowledge: boolean;
  docChunkCount: number;
  detectedDomain: DecisionDomain;
  queryIntent: 'fact_extraction' | 'strategy' | 'general';
  retrievalFailed: boolean;
}

/** Minimal subset of AdvisorDecision needed by the Decision Engine */
export interface DecisionAdvisorInput {
  detectedDomain: DecisionDomain;
  knowledgeConfidence: 'high' | 'medium' | 'low' | 'none';
  toolsRecommended: boolean;
}

/** Optional red flag gate result (not available in streaming path) */
export interface DecisionRedFlagInput {
  triggered: boolean;
  isHardGate: boolean;
}

/** Full input to the Decision Engine */
export interface DecisionEngineInput {
  query: string;
  knowledgeCtx: DecisionKnowledgeContext;
  advisorDecision: DecisionAdvisorInput;
  redFlagGate?: DecisionRedFlagInput;
}

/** Output of the Decision Engine */
export interface DecisionEngineResult {
  /** Resolved execution strategy */
  strategy: DecisionStrategy;
  /** Resolved domain — downstream code reads this instead of advisorDecision.detectedDomain */
  resolvedDomain: DecisionDomain;
  /** Whether to force reasoning model capability */
  forceReasoning: boolean;
  /** Tool names to suppress (restrictive only — never expands tool set) */
  suppressTools: string[];
  /** System prompt block to inject (empty = no injection) */
  promptBlock: string;
  /** Confidence in the decision (0–1) */
  confidence: number;
  /** Internal reasoning trace */
  reasoning: string;
  /** P8-1.10: How domain classification was determined — structured source of truth */
  classificationSource: ClassificationSource;
  /** P8-1.12c: True structured strict-grounding signal — validator reads this, NOT promptBlock text */
  strictGrounding: boolean;
}

// ---------------------------------------------------------------------------
// P8-1.5: Observability — compact decision summary for debug/API exposure
// ---------------------------------------------------------------------------

/** Safe, compact summary of a decision for debug metadata and API responses */
export interface DecisionSummary {
  /** Execution strategy chosen */
  strategy: DecisionStrategy;
  /** Original advisor domain (before any normalization) */
  advisorDomain: DecisionDomain;
  /** Final resolved domain (after normalization) */
  resolvedDomain: DecisionDomain;
  /** Whether reasoning model was forced */
  forceReasoning: boolean;
  /** Tool names suppressed (empty array if none) */
  suppressTools: string[];
  /** Whether a prompt block was emitted (boolean only — no raw text) */
  promptBlockPresent: boolean;
  /** Decision confidence (0–1) */
  confidence: number;
  /** Human-readable reasoning trace */
  reasoning: string;
  // ── P8-1.9: Extended observability fields ──────────────────────
  /** Query intent classification */
  queryIntent?: 'fact_extraction' | 'strategy' | 'general';
  /** Whether knowledge was available */
  hasKnowledge?: boolean;
  /** Number of document chunks available */
  docChunkCount?: number;
  /** Whether retrieval failed */
  retrievalFailed?: boolean;
  /** Whether query was detected as utility */
  isUtilityQuery?: boolean;
  /** Whether query contained explicit document references */
  isDocumentReference?: boolean;
  /** How the domain classification was determined */
  classificationSource?: ClassificationSource;
}

// ---------------------------------------------------------------------------
// P8-1.9: Execution Trace — structured debug surface
// ---------------------------------------------------------------------------

/** How the domain classification was determined */
export type ClassificationSource = 'upstream' | 'rescued_legal' | 'rescued_medical' | 'utility_fast_path';

/** Compact execution trace for developer debugging — no raw prompts */
export interface ExecutionTrace {
  stage: 'decision';
  strategy: DecisionStrategy;
  advisorDomain: DecisionDomain;
  resolvedDomain: DecisionDomain;
  classificationSource: ClassificationSource;
  queryIntent: 'fact_extraction' | 'strategy' | 'general';
  flags: {
    utility: boolean;
    documentReference: boolean;
    forcedReasoning: boolean;
    strictGrounding: boolean;
  };
  knowledge: {
    hasKnowledge: boolean;
    docChunkCount: number;
    retrievalFailed: boolean;
  };
  confidence: number;
}

// ---------------------------------------------------------------------------
// P8-1.2: Post-LLM Validation Types
// ---------------------------------------------------------------------------

/** Input to the post-LLM validator */
export interface DecisionValidationInput {
  /** The final response text (after all safety guards have run) */
  responseText: string;
  /** The pre-LLM decision that set expectations */
  decision: DecisionEngineResult;
  /** Knowledge state at decision time */
  knowledgeCtx: DecisionKnowledgeContext;
}

/** Alignment status */
export type AlignmentStatus = 'aligned' | 'softened' | 'skipped';

/** Output of the post-LLM validator */
export interface DecisionValidationResult {
  /** Whether response aligned with decision expectations */
  status: AlignmentStatus;
  /** Final response text (unchanged or lightly softened) */
  responseText: string;
  /** Whether the response was modified */
  wasModified: boolean;
  /** Reasons for the validation outcome */
  reasons: string[];
  /** Confidence in the validation (0–1) */
  confidence: number;
  // ── P8-1.11: Structured flags for observability (no string parsing) ──
  /** Whether a safety guard signature caused the skip */
  safetyGuardSkip: boolean;
  /** Whether grounding drift was detected */
  groundingDriftDetected: boolean;
  /** Whether uncertainty softening was applied */
  uncertaintySoftened: boolean;
}

// ---------------------------------------------------------------------------
// P8-1.11: Validation Summary — structured observability for post-LLM validation
// ---------------------------------------------------------------------------

/** Compact, structured summary of post-LLM validation for debug/API exposure */
export interface ValidationSummary {
  /** Validation outcome: aligned | modified | skipped */
  status: 'aligned' | 'modified' | 'skipped';
  /** Whether the response text was changed */
  modified: boolean;
  /** Human-readable reasons */
  reasons: string[];
  /** Validation confidence (0–1) */
  confidence: number;
  /** Whether a safety guard signature caused the skip */
  safetyGuardSkip: boolean;
  /** Whether grounding drift was detected (response lacked evidence language) */
  groundingDriftDetected: boolean;
  /** Whether uncertainty softening was applied */
  uncertaintySoftened: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEEP_DOMAINS: ReadonlySet<DecisionDomain> = new Set(['legal', 'medical', 'financial']);

// P8-1.7: Marker text used in strict grounding prompts — enables
// validateResponse to distinguish strict vs soft prompt blocks.
const STRICT_GROUNDING_MARKER = 'Base your answer on the retrieved evidence';

const VALID_DOMAINS: ReadonlySet<string> = new Set(['legal', 'medical', 'technical', 'financial', 'general']);

// P8-1.2: Patterns indicating an upstream safety guard already overwrote the response.
// If any of these are detected, the Decision validator must NOT modify the response.
const SAFETY_GUARD_SIGNATURES: RegExp[] = [
  /^The identity of your .+ is not explicitly stated in the provided documents\./,
  /^Not explicitly stated in the provided medical documents\./,
  /^ANSWER:\n-\s.+—\s\[/,  // Medical fact integrity safe output format
  /If you'd like, I can summarise the record/,
  /If you can tell me who your .+ is, I can use that information/,
];

// Patterns suggesting evidence-grounded language is present
const GROUNDED_PHRASES: RegExp[] = [
  /\b(?:according to|based on|the (?:document|evidence|record)s? (?:show|state|indicate|mention|contain))/i,
  /\b(?:your (?:document|evidence|file)s? (?:show|state|indicate|mention))/i,
  /\b(?:from the (?:uploaded|provided|retrieved) (?:document|evidence|file))/i,
  /\[(?:DOC-\d+|uploaded document)\]/i,
  /\b(?:as stated in|as noted in|as shown in|as mentioned in)\b/i,
];

// Patterns suggesting overconfident/absolute language
const OVERCONFIDENT_PHRASES: RegExp[] = [
  /\b(?:it is (?:certain|definite|clear|obvious|undeniable) that)\b/i,
  /\b(?:there is no (?:doubt|question) (?:that|about))\b/i,
  /\b(?:without (?:any )?doubt)\b/i,
  /\b(?:this (?:conclusively|definitively) (?:proves|shows|demonstrates))\b/i,
];

// Patterns suggesting some uncertainty awareness
const UNCERTAINTY_PHRASES: RegExp[] = [
  /\b(?:may|might|could|possibly|potentially|appears? to|seems? to|likely|suggest)\b/i,
  /\b(?:it is (?:possible|unclear|uncertain|not certain))\b/i,
  /\b(?:based on (?:available|limited|current) (?:evidence|information))\b/i,
  /\b(?:note that|however|important to (?:note|consider))\b/i,
  /\b(?:consult|seek (?:professional|medical|legal) advice)\b/i,
];

// ---------------------------------------------------------------------------
// P8-1.8: Classification rescue patterns
// ---------------------------------------------------------------------------
// Narrow safety nets for specialist terms that may slip past the upstream
// classifier in knowledge-augmenter.ts.  Only applied when upstream returned
// 'general'.  Must be conservative — false positives push general queries
// into strict grounding, which is the original P8-1.7 bug.

const LEGAL_RESCUE_PATTERNS: RegExp[] = [
  /\breasonable\s+adjustments?\b/i,
  /\bET[13]\b/,                        // employment tribunal forms
  /\b(?:claimant|respondent)\b/i,      // tribunal parties
  /\bdismiss(?:al|ed)\b/i,            // sacking / termination
  /\bredundancy\b/i,
  /\btribunal\b/i,
  /\bgrievance\b/i,
  /\bdiscrimination\b/i,
  /\bemployment\s+(?:law|rights?|contract)\b/i,
];

const MEDICAL_RESCUE_PATTERNS: RegExp[] = [
  /\bshortness\s+of\s+breath\b/i,
  /\bpregnan(?:t|cy)\b/i,
  /\bbleeding\b/i,
  /\bsevere\s+pain\b/i,
  /\bchest\s+pain\b/i,
  /\bsymptoms?\b/i,
  /\bdiagnos(?:is|ed|es)\b/i,
  /\bmedication\b/i,
];

// P8-1.8: Explicit document/case reference patterns.
// When the user specifically asks about their documents / uploaded files,
// classification must preserve strict grounding even in general domain.
const DOCUMENT_REFERENCE_PATTERNS: RegExp[] = [
  /\b(?:based\s+on|from|in)\s+(?:my|the)\s+(?:documents?|files?|emails?|uploads?|records?|evidence)\b/i,
  /\bmy\s+(?:uploaded|ingested)\s+(?:documents?|files?|emails?)\b/i,
  /\bwhat\s+(?:do|does)\s+(?:my|the)\s+(?:documents?|files?|records?|evidence)\s+say\b/i,
  /\bin\s+my\s+case\b/i,
  /\bwhat\s+evidence\b/i,
  /\baccording\s+to\s+(?:my|the)\s+(?:documents?|files?|records?)\b/i,
  /\bfrom\s+my\s+(?:uploaded\s+)?(?:emails?|files?)\b/i,
];

/**
 * P8-1.8: Rescue domain classification — override 'general' when query
 * contains strong specialist markers that upstream may have missed.
 * Returns the original domain unchanged if no rescue is needed.
 */
function rescueDomain(query: string, currentDomain: DecisionDomain): DecisionDomain {
  if (currentDomain !== 'general') return currentDomain;
  if (LEGAL_RESCUE_PATTERNS.some(p => p.test(query))) return 'legal';
  if (MEDICAL_RESCUE_PATTERNS.some(p => p.test(query))) return 'medical';
  return currentDomain;
}

/**
 * P8-1.8: Detect explicit document/case reference in query.
 * Exported for testing.
 */
export function isDocumentReferenceQuery(query: string): boolean {
  return DOCUMENT_REFERENCE_PATTERNS.some(p => p.test(query));
}

// P8-1.6: Narrow utility query patterns — time/date/day only.
// Must NOT match document, medical, legal, or reasoning queries.
const UTILITY_QUERY_PATTERNS: RegExp[] = [
  /^what(?:'?s| is) the (?:time|date|day)(?: today)?\s*\??$/i,
  /^what (?:time|date|day) is it(?: today)?\s*\??$/i,
  /^what(?:'?s| is) today(?:'?s)? date\s*\??$/i,
  /^(?:current|today(?:'?s)?)\s+(?:time|date|day|timestamp)(?: today)?\s*\??$/i,
  /^(?:tell me|give me) the (?:current\s+)?(?:time|date|day)\s*\??$/i,
  /^what day of the week is it\s*\??$/i,
  /^(?:date|time|day)(?: today)?\s*\??$/i,
];

/**
 * P8-1.6: Detect narrow utility queries (time/date/day).
 * Deterministic, no side effects. Exported for testing.
 */
export function isUtilityQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length > 80) return false; // Utility queries are short
  return UTILITY_QUERY_PATTERNS.some(p => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

export class DecisionEngine {

  /**
   * P8-1.5 / P8-1.9: Produce a compact, safe summary of a decision + its
   * input for debug metadata and API exposure. Does NOT include raw prompt text.
   * P8-1.9: Extended with queryIntent, knowledge state, classification source.
   */
  static summarize(
    result: DecisionEngineResult,
    advisorDomain: DecisionDomain,
    input?: DecisionEngineInput,
  ): DecisionSummary {
    const summary: DecisionSummary = {
      strategy: result.strategy,
      advisorDomain,
      resolvedDomain: result.resolvedDomain,
      forceReasoning: result.forceReasoning,
      suppressTools: [...result.suppressTools],
      promptBlockPresent: result.promptBlock.length > 0,
      confidence: result.confidence,
      reasoning: result.reasoning,
      // P8-1.10: Always include structured classificationSource
      classificationSource: result.classificationSource,
    };

    // P8-1.9: Extended fields (only when input is provided for backward compat)
    if (input) {
      summary.queryIntent = input.knowledgeCtx.queryIntent;
      summary.hasKnowledge = input.knowledgeCtx.hasKnowledge;
      summary.docChunkCount = input.knowledgeCtx.docChunkCount;
      summary.retrievalFailed = input.knowledgeCtx.retrievalFailed;
      summary.isUtilityQuery = isUtilityQuery(input.query);
      summary.isDocumentReference = isDocumentReferenceQuery(input.query);
    }

    return summary;
  }

  /**
   * P8-1.9: Build a structured execution trace from a decision result + input.
   * Purely derived from existing data — no new logic.
   */
  static buildExecutionTrace(
    result: DecisionEngineResult,
    input: DecisionEngineInput,
  ): ExecutionTrace {
    return {
      stage: 'decision',
      strategy: result.strategy,
      advisorDomain: input.advisorDecision.detectedDomain,
      resolvedDomain: result.resolvedDomain,
      // P8-1.10: Read structured field directly — no string parsing
      classificationSource: result.classificationSource,
      queryIntent: input.knowledgeCtx.queryIntent,
      flags: {
        utility: isUtilityQuery(input.query),
        documentReference: isDocumentReferenceQuery(input.query),
        forcedReasoning: result.forceReasoning,
        strictGrounding: result.strictGrounding,
      },
      knowledge: {
        hasKnowledge: input.knowledgeCtx.hasKnowledge,
        docChunkCount: input.knowledgeCtx.docChunkCount,
        retrievalFailed: input.knowledgeCtx.retrievalFailed,
      },
      confidence: result.confidence,
    };
  }

  /**
   * Produce a routing decision based on pre-computed context.
   *
   * P8-1.1: Conservative advisory logic.
   *   Rule 1 — Force reasoning for deep domains
   *   Rule 2 — Conservative domain normalization
   *   Rule 3 — Restrictive tool suppression
   *   Rule 4 — Minimal evidence-grounding prompt block
   *   Rule 5 — Deterministic confidence + reasoning trace
   */
  decide(input: DecisionEngineInput): DecisionEngineResult {
    const { advisorDecision, knowledgeCtx } = input;

    // ── P8-1.6: Utility query fast path ──────────────────────────
    // Time/date/day queries bypass all domain routing, grounding,
    // and tool suppression. Clean direct answer with no noise.
    if (isUtilityQuery(input.query)) {
      log.debug({ query: input.query }, 'P8-1.6: Utility query detected — fast path');
      return {
        strategy: 'direct_answer',
        resolvedDomain: 'general',
        forceReasoning: false,
        suppressTools: [],
        promptBlock: '',
        confidence: 1.0,
        reasoning: 'P8-1.6: utility query fast path (time/date/day)',
        classificationSource: 'utility_fast_path',
        strictGrounding: false,
      };
    }

    const reasons: string[] = [];

    // ── Rule 2: Conservative domain normalization ──────────────────
    // Pass through advisor domain unchanged. Only normalize truly
    // invalid/missing values to 'general'.
    let resolvedDomain: DecisionDomain = advisorDecision.detectedDomain;
    if (!VALID_DOMAINS.has(resolvedDomain)) {
      resolvedDomain = 'general';
      reasons.push(`domain normalized: '${advisorDecision.detectedDomain}' -> 'general'`);
    }

    // ── P8-1.8: Domain classification rescue ─────────────────────
    // If upstream classified as 'general' but query contains strong
    // specialist markers, override to the correct domain.
    const preRescueDomain = resolvedDomain;
    resolvedDomain = rescueDomain(input.query, resolvedDomain);
    // P8-1.10: Track classification source as structured field
    let classificationSource: ClassificationSource = 'upstream';
    if (resolvedDomain !== preRescueDomain) {
      classificationSource = resolvedDomain === 'legal' ? 'rescued_legal' : 'rescued_medical';
      reasons.push(`domain rescued: '${preRescueDomain}' -> '${resolvedDomain}' (P8-1.8)`);
    }

    // ── Rule 1: Deep-domain reasoning force ────────────────────────
    // Reinforces existing isDeepDomain logic in agent.ts. The engine
    // now explicitly signals forceReasoning so downstream doesn't
    // depend solely on the domain string comparison.
    const forceReasoning = DEEP_DOMAINS.has(resolvedDomain);
    if (forceReasoning) {
      reasons.push(`forceReasoning: ${resolvedDomain} is a deep domain`);
    }

    // ── Rule 3: Restrictive tool suppression ───────────────────────
    const suppressTools: string[] = [];

    // 3a: Medical document-first suppression
    // When medical domain has retrieved document evidence and retrieval
    // didn't fail, suppress web_search to enforce document authority.
    // This is additive to (not replacing) the existing isMedicalDocFirst
    // guard in agent.ts — both must agree for suppression to occur.
    if (
      resolvedDomain === 'medical' &&
      knowledgeCtx.hasKnowledge &&
      knowledgeCtx.docChunkCount > 0 &&
      !knowledgeCtx.retrievalFailed
    ) {
      suppressTools.push('web_search');
      reasons.push('suppress web_search: medical domain with document evidence');
    }

    // 3b: Fact-extraction suppression
    // When query intent is fact_extraction and documents are present,
    // suppress external tools — the answer should come from retrieved
    // evidence only. Consistent with existing agent.ts fact-mode gating.
    if (
      knowledgeCtx.queryIntent === 'fact_extraction' &&
      knowledgeCtx.hasKnowledge &&
      knowledgeCtx.docChunkCount > 0 &&
      !knowledgeCtx.retrievalFailed
    ) {
      if (!suppressTools.includes('web_search')) {
        suppressTools.push('web_search');
      }
      reasons.push('suppress web_search: fact_extraction with document evidence');
    }

    // ── Rule 4: Minimal prompt block ───────────────────────────────
    let promptBlock = '';

    // P8-1.8: Detect explicit document/case references in query
    const hasDocRef = isDocumentReferenceQuery(input.query);

    if (knowledgeCtx.hasKnowledge && knowledgeCtx.docChunkCount > 0 && !knowledgeCtx.retrievalFailed) {
      if (resolvedDomain === 'general' && knowledgeCtx.queryIntent === 'general' && !hasDocRef) {
        // P8-1.7: General everyday queries — soft guidance only.
        // Documents exist but query may be unrelated (e.g. "pizza toppings"
        // when user has legal docs). Don't force document-only mode.
        // P8-1.8: But if user explicitly references documents, use strict.
        promptBlock = '=== Decision Engine Guidance ===\n' +
          'Retrieved documents are available for reference. ' +
          'If they are relevant to the query, incorporate them. ' +
          'Otherwise, answer from your general knowledge.\n' +
          '=== End Decision Engine Guidance ===';
        reasons.push('promptBlock: soft general guidance (P8-1.7 — general domain, not document-specific)');
      } else {
        // Deep domains / fact extraction / technical / doc-reference — strict grounding
        promptBlock = '=== Decision Engine Guidance ===\n' +
          STRICT_GROUNDING_MARKER + '. ' +
          'If evidence is insufficient or ambiguous, say so explicitly. ' +
          'Do not invent facts not present in the sources.\n' +
          '=== End Decision Engine Guidance ===';
        if (hasDocRef && resolvedDomain === 'general') {
          reasons.push('promptBlock: strict grounding — explicit document reference (P8-1.8)');
        } else {
          reasons.push('promptBlock: evidence-grounding guidance');
        }
      }
    }

    // ── Rule 6 (P8-1.3 / P8-1.4): Strategy routing (hardened) ─────
    // Strict priority order (P8-1.4 Rule 5):
    //   1. retrievalFailed → standard (Rule 3)
    //   2. no knowledge    → standard (Rule 4)
    //   3. direct_answer   (Rule 2: excludes legal/medical)
    //   4. hybrid          (Rule 1: requires knowledge)
    //   5. fallback        → standard
    let strategy: DecisionStrategy = 'standard';

    if (knowledgeCtx.retrievalFailed) {
      // P8-1.4 Rule 3: retrieval failure overrides ALL other rules
      reasons.push('strategy: standard — retrieval failed (P8-1.4 R3)');
    } else if (!knowledgeCtx.hasKnowledge) {
      // P8-1.4 Rule 4: no knowledge overrides ALL other rules
      reasons.push('strategy: standard — no knowledge (P8-1.4 R4)');
    } else if (
      knowledgeCtx.queryIntent === 'fact_extraction' &&
      resolvedDomain !== 'legal' &&
      resolvedDomain !== 'medical'
    ) {
      // P8-1.4 Rule 2: direct_answer excludes legal/medical reasoning domains
      // (financial fact_extraction is allowed)
      strategy = 'direct_answer';
      reasons.push('strategy: direct_answer — fact extraction with knowledge, non-legal/medical (P8-1.4 R2)');
    } else if (
      DEEP_DOMAINS.has(resolvedDomain) &&
      knowledgeCtx.queryIntent !== 'fact_extraction'
    ) {
      // P8-1.4 Rule 1: hybrid requires knowledge (guaranteed by Rule 4 guard above)
      strategy = 'hybrid';
      reasons.push(`strategy: hybrid — ${resolvedDomain} domain with knowledge (P8-1.4 R1)`);
    } else {
      reasons.push('strategy: standard — default flow');
    }

    // ── Rule 5: Confidence + reasoning trace ───────────────────────
    let confidence = 1.0;

    if (knowledgeCtx.retrievalFailed) {
      confidence = 0.3;
      reasons.push('low confidence: retrieval failed');
    } else if (knowledgeCtx.hasKnowledge && knowledgeCtx.docChunkCount > 0) {
      // Documents available — higher confidence in routing
      confidence = advisorDecision.knowledgeConfidence === 'high' ? 0.95
        : advisorDecision.knowledgeConfidence === 'medium' ? 0.8
        : advisorDecision.knowledgeConfidence === 'low' ? 0.6
        : 0.5;
      reasons.push(`confidence ${confidence}: docs=${knowledgeCtx.docChunkCount}, advisor=${advisorDecision.knowledgeConfidence}`);
    } else if (!knowledgeCtx.hasKnowledge) {
      confidence = 0.5;
      reasons.push('moderate confidence: no knowledge retrieved');
    }

    const reasoning = reasons.length > 0
      ? `P8-1.1: ${reasons.join('; ')}`
      : 'P8-1.1: no rules triggered, pass-through';

    // P8-1.12c: True structured strict-grounding signal.
    // True when the Decision Engine INTENDS strict evidence grounding:
    //   - specialist domain (legal/medical/financial) with docs
    //   - rescued classification (legal/medical markers found)
    //   - explicit document reference query
    // False for general everyday queries even if upstream queryIntent
    // is 'fact_extraction' (e.g. "what toppings go on a pizza").
    const hasDocsAvailable = knowledgeCtx.hasKnowledge && knowledgeCtx.docChunkCount > 0 && !knowledgeCtx.retrievalFailed;
    const strictGrounding = hasDocsAvailable && (
      (resolvedDomain !== 'general') ||
      classificationSource === 'rescued_legal' ||
      classificationSource === 'rescued_medical' ||
      hasDocRef
    );

    const result: DecisionEngineResult = {
      strategy,
      resolvedDomain,
      forceReasoning,
      suppressTools,
      promptBlock,
      confidence,
      reasoning,
      classificationSource,
      strictGrounding,
    };

    log.debug({
      strategy: result.strategy,
      inputDomain: advisorDecision.detectedDomain,
      resolvedDomain: result.resolvedDomain,
      forceReasoning: result.forceReasoning,
      suppressCount: result.suppressTools.length,
      hasPromptBlock: result.promptBlock.length > 0,
      confidence: result.confidence,
      hasRedFlagGate: !!input.redFlagGate,
    }, 'P8-1.3: Decision Engine result');

    // P8-1.9: Structured execution trace — single debug log
    const trace = DecisionEngine.buildExecutionTrace(result, input);
    log.debug(trace, 'P8-1.9: decision.executionTrace');

    return result;
  }

  // ── P8-1.2: Post-LLM Validation ───────────────────────────────────

  /**
   * Validate whether the final LLM response aligns with the pre-LLM
   * decision expectations.  Runs AFTER all existing safety guards.
   *
   * Rules:
   *   1. If a safety guard already overwrote the response → skip (do not fight)
   *   2. If evidence was expected but response shows no grounded language → soft nudge
   *   3. If overconfident language detected in low-confidence context → soften
   *   4. Never add facts, citations, or change meaning substantially
   *   5. Deterministic: same input always produces same output
   */
  validateResponse(input: DecisionValidationInput): DecisionValidationResult {
    const { responseText, decision, knowledgeCtx } = input;
    const reasons: string[] = [];

    // P8-1.11: Structured flags — set at the true source
    let safetyGuardSkip = false;
    let groundingDriftDetected = false;
    let uncertaintySoftened = false;

    // ── Rule 3: Do not override safety-guarded output ─────────────
    for (const sig of SAFETY_GUARD_SIGNATURES) {
      if (sig.test(responseText)) {
        log.debug('P8-1.2: Safety guard signature detected — skipping validation');
        return {
          status: 'skipped',
          responseText,
          wasModified: false,
          reasons: ['safety guard already intervened'],
          confidence: 1.0,
          safetyGuardSkip: true,
          groundingDriftDetected: false,
          uncertaintySoftened: false,
        };
      }
    }

    // Short/empty responses: nothing useful to validate
    if (responseText.length < 20) {
      return {
        status: 'aligned',
        responseText,
        wasModified: false,
        reasons: ['response too short to validate'],
        confidence: 1.0,
        safetyGuardSkip: false,
        groundingDriftDetected: false,
        uncertaintySoftened: false,
      };
    }

    let modifiedText = responseText;
    let wasModified = false;

    // ── Rule 1: Evidence-grounding drift detection ────────────────
    // P8-1.12c: Use the structured strictGrounding flag — no promptBlock
    // string parsing. The flag is true only when the Decision Engine
    // INTENDED strict evidence grounding (specialist domain, rescued
    // classification, or explicit document reference). General everyday
    // queries and utility fast-path queries are always false.
    if (
      decision.strictGrounding &&
      knowledgeCtx.hasKnowledge &&
      knowledgeCtx.docChunkCount > 0 &&
      !knowledgeCtx.retrievalFailed
    ) {
      const hasGroundedLanguage = GROUNDED_PHRASES.some(p => p.test(responseText));

      if (!hasGroundedLanguage) {
        // Response doesn't reference evidence at all — add soft reminder
        // Only append, never rewrite
        modifiedText = modifiedText.trimEnd() +
          '\n\n*Note: This response should be verified against the retrieved documents.*';
        wasModified = true;
        groundingDriftDetected = true;
        reasons.push('grounding drift: no evidence-referencing language detected, soft reminder added');
      }
    }

    // ── Rule 2: Uncertainty expectation check ─────────────────────
    // If decision confidence was low (retrieval failed or weak knowledge)
    // and the response uses overconfident absolute language, soften it.
    if (decision.confidence <= 0.5) {
      const hasOverconfidence = OVERCONFIDENT_PHRASES.some(p => p.test(responseText));
      const hasUncertainty = UNCERTAINTY_PHRASES.some(p => p.test(responseText));

      if (hasOverconfidence && !hasUncertainty) {
        // Overconfident with no uncertainty markers in a low-confidence context
        modifiedText = modifiedText.trimEnd() +
          '\n\n*Please note: the available evidence for this response is limited. ' +
          'Consider verifying these points independently.*';
        wasModified = true;
        uncertaintySoftened = true;
        reasons.push('uncertainty softening: overconfident language in low-confidence context');
      }
    }

    // Determine final status
    const status: AlignmentStatus = wasModified ? 'softened' : 'aligned';
    const confidence = wasModified ? 0.7 : 1.0;

    if (reasons.length === 0) {
      reasons.push('response aligned with decision expectations');
    }

    log.debug({
      status,
      wasModified,
      reasons,
      decisionConfidence: decision.confidence,
      hasPromptBlock: decision.promptBlock.length > 0,
    }, 'P8-1.2: Post-LLM validation result');

    return {
      status,
      responseText: modifiedText,
      wasModified,
      reasons,
      confidence,
      safetyGuardSkip,
      groundingDriftDetected,
      uncertaintySoftened,
    };
  }

  /**
   * P8-1.11: Build a compact validation summary from the validation result.
   * Purely derived — no new logic. Maps status to the summary status enum.
   */
  static summarizeValidation(result: DecisionValidationResult): ValidationSummary {
    return {
      status: result.wasModified ? 'modified' : result.status === 'skipped' ? 'skipped' : 'aligned',
      modified: result.wasModified,
      reasons: [...result.reasons],
      confidence: result.confidence,
      safetyGuardSkip: result.safetyGuardSkip,
      groundingDriftDetected: result.groundingDriftDetected,
      uncertaintySoftened: result.uncertaintySoftened,
    };
  }
}
