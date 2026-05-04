/**
 * Reasoning Service
 *
 * Universal reasoning layer that interprets structured evidence from
 * cognitive memory and optionally augments with internet context.
 *
 * CRITICAL SOURCE HIERARCHY:
 *   1. MEMORY IS PRIMARY TRUTH — evidence from ingested documents
 *   2. INTERNET IS SECONDARY CONTEXT ONLY — never overrides memory
 *   3. Sources are NEVER merged or blurred
 *   4. All outputs clearly separate memory vs internet sources
 *
 * SAFETY RULES:
 *   - MUST NOT invent facts
 *   - MUST NOT query memory directly (consumes structured context only)
 *   - MUST NOT replace memory claims with internet claims
 *   - MUST degrade safely when evidence is weak or absent
 *   - MUST be explainable and auditable
 */

import type { BaseLLMProvider } from '../llm/base.js';
import type { LLMResponse } from '../types.js';
import { logger } from '../logger.js';

/* ------------------------------------------------------------------ */
/*  Input types                                                        */
/* ------------------------------------------------------------------ */

export interface ReasoningInput {
  /** The original user query */
  query: string;

  /** SQL-derived facts (counts, entity matches) */
  facts: Array<{
    label: string;
    value: string | number;
    source: string;
  }>;

  /** Evidence bundles grouped by document, with citations */
  bundles: Array<{
    document_id: string;
    file_name?: string;
    evidence_items: Array<{
      text: string;
      match_type: string;
      citation: {
        document_id: string;
        chunk_id?: string;
        page_number?: number | null;
        evidence_type: string;
      };
    }>;
  }>;

  /** Detected contradictions between documents */
  contradictions: Array<{
    contradiction_type: string;
    side_a: { document_ids: string[]; evidence_texts: string[] };
    side_b: { document_ids: string[]; evidence_texts: string[] };
    unresolved: boolean;
    reasoning: string;
  }>;

  /** Uncertainty flags */
  uncertainty_flags: Array<{
    reason: string;
    affected_items: number;
  }>;

  /** Route and diagnostics metadata */
  diagnostics: {
    route: string;
    vector_used: boolean;
    fallback_used: boolean;
  };
}

export interface InternetResult {
  /** Short summary/snippet from the web source */
  snippet: string;
  /** URL or source attribution */
  source: string;
  /** Title of the web page/result */
  title?: string;
}

/* ------------------------------------------------------------------ */
/*  Output types                                                       */
/* ------------------------------------------------------------------ */

export type ConfidenceLevel = 'high' | 'medium' | 'low' | 'insufficient';

export interface ReasoningOutput {
  /** High-level answer grounded in memory first */
  summary: string;

  /** Evidence-backed findings from user's documents */
  document_findings: string[];

  /** Referenced citations from memory */
  supporting_evidence: Array<{
    text: string;
    document_id: string;
    chunk_id?: string;
    page_number?: number | null;
  }>;

  /** Conflicting evidence explained */
  contradictions: string[];

  /** External context — clearly separated, labelled */
  external_context: Array<{
    text: string;
    source: string;
    title?: string;
  }>;

  /** Whether internet was used and why */
  internet_used: boolean;
  internet_reason: string | null;

  /** What the combined information suggests */
  interpretation: string;

  /** What the user should consider or do */
  practical_guidance: string[];

  /** Where information is incomplete */
  uncertainties: string[];

  /** Confidence level with justification */
  confidence: {
    level: ConfidenceLevel;
    justification: string;
  };

  /** Validation against evidence */
  validation: {
    passed: boolean;
    claims_verified: number;
    claims_unverified: number;
    sources_separated: boolean;
    degraded: boolean;
    degradation_reason?: string;
  };
}

export interface ReasoningDiagnostics {
  total_reasonings: number;
  last_confidence: ConfidenceLevel | null;
  last_validation_passed: boolean | null;
  last_degraded: boolean;
  last_internet_used: boolean;
  llm_available: boolean;
  health: 'healthy' | 'degraded' | 'unhealthy';
}

/* ------------------------------------------------------------------ */
/*  Internet search provider interface                                 */
/* ------------------------------------------------------------------ */

/**
 * Pluggable internet search provider.
 * Implement this to connect web search to reasoning.
 */
export interface InternetSearchProvider {
  search(query: string, maxResults?: number): Promise<InternetResult[]>;
}

/* ------------------------------------------------------------------ */
/*  Service                                                            */
/* ------------------------------------------------------------------ */

export class ReasoningService {
  private llm: BaseLLMProvider | null;
  private internetProvider: InternetSearchProvider | null;
  private totalReasonings = 0;
  private lastConfidence: ConfidenceLevel | null = null;
  private lastValidationPassed: boolean | null = null;
  private lastDegraded = false;
  private lastInternetUsed = false;

  constructor(llm?: BaseLLMProvider, internetProvider?: InternetSearchProvider) {
    this.llm = llm ?? null;
    this.internetProvider = internetProvider ?? null;
  }

  /* ============================================================== */
  /*  Main entry point                                               */
  /* ============================================================== */

  /**
   * Produce structured reasoning from evidence context.
   *
   * Internet search is used ONLY when:
   *   - Memory evidence is weak or incomplete
   *   - Query asks for general explanation or definitions
   *   - Query asks for up-to-date external information
   *
   * Internet is NOT used when:
   *   - Memory fully answers the question
   *   - Query is document-specific
   *   - Legal/evidence interpretation is strong from memory
   */
  async reason(
    input: ReasoningInput,
    options?: { allowInternet?: boolean },
  ): Promise<ReasoningOutput> {
    this.totalReasonings++;

    // If no evidence at all, return insufficient
    if (input.bundles.length === 0 && input.facts.length === 0) {
      // If internet is allowed, try to provide external context
      if (options?.allowInternet && this.internetProvider) {
        return this.reasonWithInternetOnly(input);
      }
      return this.insufficientEvidence(input);
    }

    // Determine if internet augmentation is needed
    const needsInternet = options?.allowInternet &&
      this.internetProvider &&
      this.shouldUseInternet(input);

    let internetResults: InternetResult[] = [];
    if (needsInternet && this.internetProvider) {
      try {
        internetResults = await this.internetProvider.search(input.query, 3);
        this.lastInternetUsed = true;
      } catch (error) {
        logger.warn(`Internet search failed: ${error instanceof Error ? error.message : String(error)}`);
        this.lastInternetUsed = false;
      }
    } else {
      this.lastInternetUsed = false;
    }

    // If no LLM, produce deterministic evidence summary
    if (!this.llm || !this.llm.isConfigured()) {
      return this.deterministicReasoning(input, internetResults);
    }

    // Task-complexity routing: simple queries use deterministic reasoning
    // to avoid unnecessary LLM latency for straightforward answers.
    const complexity = this.assessComplexity(input);
    if (complexity === 'trivial') {
      return this.deterministicReasoning(input, internetResults);
    }

    // Route maxTokens by complexity to reduce output generation time
    const maxTokens = complexity === 'light' ? 800 : complexity === 'medium' ? 1200 : 2000;

    // Full LLM-powered reasoning
    try {
      const prompt = this.buildPrompt(input, internetResults);
      const response = await this.llm.complete({
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        systemPrompt: REASONING_SYSTEM_PROMPT,
        maxTokens,
        temperature: 0.1,
      });

      const parsed = this.parseResponse(response, internetResults);
      const validated = this.validateOutput(parsed, input, internetResults);

      this.lastConfidence = validated.confidence.level;
      this.lastValidationPassed = validated.validation.passed;
      this.lastDegraded = validated.validation.degraded;

      return validated;
    } catch (error) {
      logger.error(
        `LLM reasoning failed: ${error instanceof Error ? error.message : String(error)}. Falling back to deterministic.`,
      );
      return this.deterministicReasoning(input, internetResults);
    }
  }

  /* ============================================================== */
  /*  Internet decision logic                                        */
  /* ============================================================== */

  /**
   * Determine whether internet augmentation is needed.
   * Conservative — prefers memory-only when sufficient.
   */
  /**
   * Assess reasoning complexity to route model usage.
   *
   * - trivial: count queries, missing entity → deterministic only
   * - light: single entity/exact search → shorter LLM response
   * - medium: moderate evidence → standard LLM response
   * - heavy: multi-entity, contradictions, analytical → full LLM response
   */
  private assessComplexity(input: ReasoningInput): 'trivial' | 'light' | 'medium' | 'heavy' {
    // No evidence at all → trivial (deterministic is fine)
    if (input.bundles.length === 0 && input.facts.length === 0) return 'trivial';

    // Count-only with no bundles → trivial
    if (input.bundles.length === 0 && input.facts.every((f) => f.source === 'sql_count')) return 'trivial';

    // Single fact, no bundles → light
    if (input.bundles.length <= 1 && input.contradictions.length === 0) return 'light';

    // Has contradictions → heavy
    if (input.contradictions.length > 0) return 'heavy';

    // Multiple bundles → medium
    if (input.bundles.length <= 5) return 'medium';

    // Large evidence set → heavy
    return 'heavy';
  }

  private shouldUseInternet(input: ReasoningInput): boolean {
    const queryLower = input.query.toLowerCase();

    // --- Check if query explicitly asks for external context ---
    // Queries like "explain X and relate to my documents" or
    // "how does this compare to industry standards" need internet
    // even when memory has strong evidence for the document part.
    const externalContextPatterns = [
      /\b(explain|what\s+is|define|meaning\s+of)\b/,
      /\b(compar[ei]|industry|standard|best\s+practice|general\s+practice)\b/,
      /\b(relate|context|background|overview)\b.*\b(my|the)\s+(documents?|evidence|case)\b/,
      /\b(should\s+i|what\s+should|what\s+can|what\s+are\s+my\s+(rights|options))\b/,
      /\b(legal|law|regulation|statutory|policy)\b.*\b(say|require|mean)\b/,
    ];
    const asksForExternalContext = externalContextPatterns.some((p) => p.test(queryLower));

    // If query explicitly asks for external context, use internet as secondary
    // even when memory is strong — the user wants BOTH.
    if (asksForExternalContext) return true;

    // --- Pure document queries: memory is sufficient ---
    // Document-specific query (entity/count facts found) → memory only
    if (input.facts.some((f) => f.source === 'entity_index' || f.source === 'sql_count')) return false;

    // Memory is strong with facts → don't use internet
    if (input.bundles.length >= 3 && input.facts.length > 0) return false;

    // --- Memory is weak → consider internet ---
    if (input.bundles.length <= 1) return true;

    // High uncertainty → consider internet
    if (input.uncertainty_flags.length > 0) return true;

    return false;
  }

  /* ============================================================== */
  /*  Prompt construction                                            */
  /* ============================================================== */

  private buildPrompt(input: ReasoningInput, internetResults: InternetResult[]): string {
    const parts: string[] = [];

    parts.push(`USER QUERY: ${input.query}\n`);

    // === MEMORY EVIDENCE (PRIMARY) ===
    parts.push('═══ YOUR DOCUMENTS (PRIMARY SOURCE) ═══\n');

    if (input.facts.length > 0) {
      parts.push('VERIFIED FACTS (from database):');
      for (const f of input.facts) {
        parts.push(`  • ${f.label}: ${f.value} [source: ${f.source}]`);
      }
      parts.push('');
    }

    if (input.bundles.length > 0) {
      // Limit bundles and items to control prompt size.
      // Top 7 bundles × 3 items × 200 chars ≈ 4.2K chars of evidence
      const maxBundles = 7;
      const maxItems = 3;
      const maxSnippet = 200;

      parts.push(`EVIDENCE BUNDLES (${Math.min(input.bundles.length, maxBundles)} of ${input.bundles.length}):`);
      for (const bundle of input.bundles.slice(0, maxBundles)) {
        const docLabel = bundle.file_name || bundle.document_id.substring(0, 8);
        parts.push(`  Doc: ${docLabel}`);
        for (const item of bundle.evidence_items.slice(0, maxItems)) {
          const page = item.citation.page_number != null ? ` [p${item.citation.page_number}]` : '';
          const snippet = item.text.length > maxSnippet ? item.text.substring(0, maxSnippet) + '…' : item.text;
          parts.push(`    [${item.match_type}]${page} "${snippet}"`);
        }
      }
      parts.push('');
    }

    if (input.contradictions.length > 0) {
      // Limit contradictions in prompt to top 3 to reduce generation load
      const maxContra = 3;
      parts.push(`CONTRADICTIONS (${Math.min(input.contradictions.length, maxContra)} most relevant of ${input.contradictions.length}):`);
      for (const c of input.contradictions.slice(0, maxContra)) {
        parts.push(`  ${c.contradiction_type} (${c.unresolved ? 'UNRESOLVED' : 'resolved'})`);
        parts.push(`    A: ${c.side_a.evidence_texts.slice(0, 1).map((t) => t.substring(0, 80)).join(' | ')}`);
        parts.push(`    B: ${c.side_b.evidence_texts.slice(0, 1).map((t) => t.substring(0, 80)).join(' | ')}`);
      }
      parts.push('');
    }

    if (input.uncertainty_flags.length > 0) {
      parts.push('UNCERTAINTY FLAGS:');
      for (const u of input.uncertainty_flags) {
        parts.push(`  ⚠ ${u.reason} (${u.affected_items} items)`);
      }
      parts.push('');
    }

    // === INTERNET CONTEXT (SECONDARY, OPTIONAL) ===
    if (internetResults.length > 0) {
      parts.push('═══ EXTERNAL CONTEXT (SECONDARY — for background only) ═══\n');
      parts.push('NOTE: This information is from the internet. It is CONTEXT ONLY.');
      parts.push('Do NOT use it to override document evidence.\n');
      for (const r of internetResults) {
        parts.push(`  Source: ${r.source}${r.title ? ` — "${r.title}"` : ''}`);
        parts.push(`  "${r.snippet.substring(0, 200)}"`);
        parts.push('');
      }
    }

    parts.push(`RETRIEVAL: route=${input.diagnostics.route}, vector=${input.diagnostics.vector_used}, fallback=${input.diagnostics.fallback_used}`);

    return parts.join('\n');
  }

  /* ============================================================== */
  /*  Response parsing                                               */
  /* ============================================================== */

  private parseResponse(response: LLMResponse, internetResults: InternetResult[]): ReasoningOutput {
    const text = response.content || '';

    return {
      summary: this.extractSection(text, 'SUMMARY') || this.extractSection(text, 'Summary') || text.substring(0, 300),
      document_findings: this.extractBulletPoints(text, 'FINDINGS FROM YOUR DOCUMENTS') || this.extractBulletPoints(text, 'KEY FINDINGS') || [],
      supporting_evidence: [],
      contradictions: this.extractBulletPoints(text, 'CONTRADICTIONS') || [],
      external_context: internetResults.map((r) => ({
        text: r.snippet,
        source: r.source,
        title: r.title,
      })),
      internet_used: internetResults.length > 0,
      internet_reason: internetResults.length > 0 ? 'Memory evidence was weak or incomplete' : null,
      interpretation: this.extractSection(text, 'INTERPRETATION') || this.extractSection(text, 'Interpretation') || '',
      practical_guidance: this.extractBulletPoints(text, 'PRACTICAL GUIDANCE') || this.extractBulletPoints(text, 'Practical Guidance') || [],
      uncertainties: this.extractBulletPoints(text, 'UNCERTAINTIES') || this.extractBulletPoints(text, 'Uncertainties') || [],
      confidence: this.extractConfidence(text),
      validation: { passed: false, claims_verified: 0, claims_unverified: 0, sources_separated: true, degraded: false },
    };
  }

  private extractSection(text: string, header: string): string {
    const pattern = new RegExp(`###?\\s*${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s]*\\n([\\s\\S]*?)(?=###|$)`, 'i');
    const match = text.match(pattern);
    return match ? match[1].trim() : '';
  }

  private extractBulletPoints(text: string, header: string): string[] {
    const section = this.extractSection(text, header);
    if (!section) return [];
    return section
      .split('\n')
      .map((l) => l.replace(/^[\s•\-*]+/, '').trim())
      .filter((l) => l.length > 0);
  }

  private extractConfidence(text: string): { level: ConfidenceLevel; justification: string } {
    const section = this.extractSection(text, 'CONFIDENCE') || this.extractSection(text, 'Confidence Level');
    const lower = (section || text).toLowerCase();
    let level: ConfidenceLevel = 'medium';
    if (lower.includes('high')) level = 'high';
    else if (lower.includes('low')) level = 'low';
    else if (lower.includes('insufficient')) level = 'insufficient';
    return { level, justification: section || 'Based on available evidence' };
  }

  /* ============================================================== */
  /*  Validation — source separation + claim verification            */
  /* ============================================================== */

  private validateOutput(
    output: ReasoningOutput,
    input: ReasoningInput,
    internetResults: InternetResult[],
  ): ReasoningOutput {
    const evidenceTexts = new Set<string>();
    const citations: ReasoningOutput['supporting_evidence'] = [];

    for (const bundle of input.bundles) {
      for (const item of bundle.evidence_items) {
        evidenceTexts.add(item.text.toLowerCase());
        citations.push({
          text: item.text.substring(0, 200),
          document_id: item.citation.document_id,
          chunk_id: item.citation.chunk_id,
          page_number: item.citation.page_number,
        });
      }
    }
    for (const fact of input.facts) {
      evidenceTexts.add(String(fact.value).toLowerCase());
      evidenceTexts.add(fact.label.toLowerCase());
    }

    // Validate document findings against evidence
    let verified = 0;
    let unverified = 0;
    const validFindings: string[] = [];

    for (const finding of output.document_findings) {
      if (this.findingSupported(finding, evidenceTexts, input)) {
        validFindings.push(finding);
        verified++;
      } else {
        validFindings.push(`[unverified] ${finding}`);
        unverified++;
      }
    }

    // Verify source separation: external_context should only contain internet sources
    const sourcesSeparated = output.external_context.every(
      (ec) => internetResults.some((ir) => ir.source === ec.source),
    );

    output.supporting_evidence = citations.slice(0, 20);
    output.document_findings = validFindings;

    const totalClaims = verified + unverified;
    const passed = unverified === 0 || (totalClaims > 0 && verified / totalClaims >= 0.7);

    output.validation = {
      passed,
      claims_verified: verified,
      claims_unverified: unverified,
      sources_separated: sourcesSeparated,
      degraded: !passed || !sourcesSeparated,
      degradation_reason: !passed
        ? `${unverified} of ${totalClaims} findings unverified`
        : !sourcesSeparated
          ? 'Source separation violated — internet content mixed with memory'
          : undefined,
    };

    if (!passed && output.confidence.level === 'high') {
      output.confidence.level = 'medium';
      output.confidence.justification += ' (downgraded: some findings unverified)';
    }

    return output;
  }

  private findingSupported(
    finding: string,
    evidenceTexts: Set<string>,
    input: ReasoningInput,
  ): boolean {
    const findingLower = finding.toLowerCase();
    const findingTokens = findingLower.split(/\s+/).filter((t) => t.length > 3);
    if (findingTokens.length === 0) return true; // trivially short

    // --- Strategy 1: Single-text token overlap (original, strict) ---
    for (const evText of evidenceTexts) {
      const matchCount = findingTokens.filter((t) => evText.includes(t)).length;
      if (findingTokens.length > 0 && matchCount / findingTokens.length >= 0.4) return true;
    }

    // --- Strategy 2: Cross-text corpus overlap ---
    // LLM may synthesize a finding from multiple evidence texts.
    // Check if tokens are supported ACROSS ALL evidence combined.
    const allEvidenceText = [...evidenceTexts].join(' ');
    const crossMatchCount = findingTokens.filter((t) => allEvidenceText.includes(t)).length;
    if (findingTokens.length > 0 && crossMatchCount / findingTokens.length >= 0.5) return true;

    // --- Strategy 3: Entity-name matching ---
    // Findings mentioning known entity names (from facts) are evidence-grounded.
    for (const fact of input.facts) {
      if (fact.source === 'entity_index' && typeof fact.value === 'string') {
        if (findingLower.includes(fact.value.toLowerCase())) return true;
      }
    }

    // --- Strategy 4: Fact-level matching ---
    for (const fact of input.facts) {
      if (findingLower.includes(String(fact.value).toLowerCase())) return true;
      if (findingLower.includes(fact.label.toLowerCase())) return true;
    }

    // --- Strategy 5: File-name matching ---
    for (const bundle of input.bundles) {
      if (bundle.file_name && findingLower.includes(bundle.file_name.toLowerCase())) return true;
    }

    // --- Strategy 6: Contradiction-aware matching ---
    // Findings about contradictions are supported if contradictions exist.
    if (input.contradictions && input.contradictions.length > 0) {
      const contradictionTerms = ['contradict', 'conflict', 'inconsisten', 'disagree', 'dispute', 'different account', 'opposing'];
      if (contradictionTerms.some((t) => findingLower.includes(t))) return true;
    }

    return false;
  }

  /* ============================================================== */
  /*  Deterministic fallback (no LLM)                                */
  /* ============================================================== */

  private deterministicReasoning(input: ReasoningInput, internetResults: InternetResult[]): ReasoningOutput {
    const findings: string[] = [];
    const citations: ReasoningOutput['supporting_evidence'] = [];
    const contradictionTexts: string[] = [];
    const uncertaintyTexts: string[] = [];

    for (const fact of input.facts) {
      findings.push(`${fact.label}: ${fact.value} (${fact.source})`);
    }

    for (const bundle of input.bundles) {
      const docLabel = bundle.file_name || bundle.document_id.substring(0, 8);
      findings.push(`Evidence found in "${docLabel}" (${bundle.evidence_items.length} items)`);
      for (const item of bundle.evidence_items.slice(0, 3)) {
        citations.push({
          text: item.text.substring(0, 200),
          document_id: item.citation.document_id,
          chunk_id: item.citation.chunk_id,
          page_number: item.citation.page_number,
        });
      }
    }

    for (const c of input.contradictions) {
      contradictionTexts.push(
        `${c.contradiction_type}: Conflicting evidence across documents. ${c.unresolved ? 'Unresolved.' : 'Resolved.'} (${c.reasoning})`,
      );
    }

    for (const u of input.uncertainty_flags) {
      uncertaintyTexts.push(`${u.reason} (${u.affected_items} items)`);
    }

    const summary = input.bundles.length > 0
      ? `Found evidence across ${input.bundles.length} document(s) for "${input.query}".${input.contradictions.length > 0 ? ` ${input.contradictions.length} contradiction(s) detected.` : ''}`
      : `Limited evidence found for "${input.query}".`;

    let confidence: ConfidenceLevel = 'medium';
    if (input.bundles.length >= 5 && input.facts.length > 0) confidence = 'high';
    if (input.bundles.length <= 1 && input.facts.length === 0) confidence = 'low';

    this.lastConfidence = confidence;
    this.lastValidationPassed = true;
    this.lastDegraded = true;
    this.lastInternetUsed = internetResults.length > 0;

    return {
      summary,
      document_findings: findings,
      supporting_evidence: citations.slice(0, 20),
      contradictions: contradictionTexts,
      external_context: internetResults.map((r) => ({
        text: r.snippet,
        source: r.source,
        title: r.title,
      })),
      internet_used: internetResults.length > 0,
      internet_reason: internetResults.length > 0 ? 'Memory evidence was weak; internet used for supplementary context' : null,
      interpretation: 'Deterministic summary — LLM reasoning unavailable. Evidence presented as-is without interpretation.',
      practical_guidance: input.contradictions.length > 0
        ? ['Review contradictory evidence carefully', 'Cross-reference document dates and sources']
        : ['Review the cited evidence for further analysis'],
      uncertainties: uncertaintyTexts,
      confidence: {
        level: confidence,
        justification: `Based on ${input.bundles.length} evidence bundle(s), ${input.facts.length} fact(s), ${input.contradictions.length} contradiction(s). Deterministic mode.`,
      },
      validation: {
        passed: true,
        claims_verified: findings.length,
        claims_unverified: 0,
        sources_separated: true,
        degraded: true,
        degradation_reason: 'LLM unavailable — deterministic evidence summary only',
      },
    };
  }

  private insufficientEvidence(input: ReasoningInput): ReasoningOutput {
    this.lastConfidence = 'insufficient';
    this.lastValidationPassed = true;
    this.lastDegraded = false;
    this.lastInternetUsed = false;

    return {
      summary: `No sufficient evidence found for "${input.query}".`,
      document_findings: [],
      supporting_evidence: [],
      contradictions: [],
      external_context: [],
      internet_used: false,
      internet_reason: null,
      interpretation: 'No relevant documents, entities, or text matching this query were found in the ingested corpus.',
      practical_guidance: [
        'Verify the search terms are correct',
        'Check if relevant documents have been ingested',
        'Try rephrasing the query',
      ],
      uncertainties: ['No evidence retrieved for this query'],
      confidence: { level: 'insufficient', justification: 'No evidence retrieved' },
      validation: { passed: true, claims_verified: 0, claims_unverified: 0, sources_separated: true, degraded: false },
    };
  }

  private async reasonWithInternetOnly(input: ReasoningInput): Promise<ReasoningOutput> {
    let internetResults: InternetResult[] = [];
    try {
      if (this.internetProvider) {
        internetResults = await this.internetProvider.search(input.query, 3);
        this.lastInternetUsed = true;
      }
    } catch {
      this.lastInternetUsed = false;
    }

    if (internetResults.length === 0) {
      return this.insufficientEvidence(input);
    }

    this.lastConfidence = 'low';
    this.lastValidationPassed = true;
    this.lastDegraded = false;

    return {
      summary: `No document evidence found for "${input.query}". External context provided below.`,
      document_findings: [],
      supporting_evidence: [],
      contradictions: [],
      external_context: internetResults.map((r) => ({
        text: r.snippet,
        source: r.source,
        title: r.title,
      })),
      internet_used: true,
      internet_reason: 'No memory evidence available — internet used as fallback',
      interpretation: 'This answer is based entirely on external internet sources, not your documents. Treat as general context only.',
      practical_guidance: ['This information comes from external sources — verify independently'],
      uncertainties: ['No document evidence available — relying on external sources only'],
      confidence: { level: 'low', justification: 'No memory evidence; internet-only response' },
      validation: { passed: true, claims_verified: 0, claims_unverified: 0, sources_separated: true, degraded: false },
    };
  }

  /* ============================================================== */
  /*  Diagnostics                                                    */
  /* ============================================================== */

  getDiagnostics(): ReasoningDiagnostics {
    return {
      total_reasonings: this.totalReasonings,
      last_confidence: this.lastConfidence,
      last_validation_passed: this.lastValidationPassed,
      last_degraded: this.lastDegraded,
      last_internet_used: this.lastInternetUsed,
      llm_available: this.llm !== null && this.llm.isConfigured(),
      health: 'healthy',
    };
  }
}

/* ------------------------------------------------------------------ */
/*  System prompt                                                      */
/* ------------------------------------------------------------------ */

const REASONING_SYSTEM_PROMPT = `You are an evidence analysis assistant. You interpret structured evidence and produce clear, auditable reasoning.

CRITICAL SOURCE RULES:
1. DOCUMENTS ARE PRIMARY TRUTH — always ground your answer in the document evidence provided
2. EXTERNAL CONTEXT IS SECONDARY — if external sources are provided, they are for BACKGROUND ONLY
3. NEVER override document evidence with external information
4. NEVER merge sources — always clearly state which source supports which finding
5. If document evidence is sufficient, DO NOT reference external sources
6. If you use external context, explicitly label it as "External context:"

CRITICAL SAFETY RULES:
1. ONLY use evidence provided in the message — do NOT use your training knowledge
2. If evidence is insufficient, say "Insufficient evidence" — do NOT fill gaps
3. Cite which evidence supports each finding
4. Clearly identify contradictions between sources
5. Flag uncertainties honestly

OUTPUT FORMAT (use these exact headers):

### SUMMARY
One paragraph answer grounded in document evidence first.

### FINDINGS FROM YOUR DOCUMENTS
Bullet points of important facts from the documents provided. Each MUST correspond to specific evidence.

### CONTRADICTIONS
If contradictions exist, explain them clearly. Present both sides — do not resolve.

### CONTEXT FROM EXTERNAL SOURCES
Only if external sources were provided AND add value. Label each with its source.
If no external sources were provided, omit this section entirely.

### INTERPRETATION
What the combined evidence suggests. Separate fact from inference.

### PRACTICAL GUIDANCE
Actions to consider. Do not give legal/medical advice — suggest consulting professionals.

### UNCERTAINTIES
What is unclear, missing, or based on weak evidence.

### CONFIDENCE LEVEL
State: High, Medium, Low, or Insufficient. Justify.`;
