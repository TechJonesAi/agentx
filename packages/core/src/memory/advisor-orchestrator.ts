/**
 * Advisor Orchestrator — Controlled routing for knowledge-aware chat
 *
 * Decides per-query how to combine knowledge sources and tools.
 * Produces an orchestration decision that is logged and inspectable.
 *
 * This is NOT autonomous planning. It is deterministic routing logic
 * that prevents redundant retrieval and provides clear advisory guidance
 * to the LLM about what knowledge is already available.
 *
 * Routing policy:
 *   1. Knowledge augmentation runs first (memory + docs)
 *   2. If knowledge is sufficient → advise LLM to answer from context
 *   3. If knowledge is insufficient → advise LLM to use tools if needed
 *   4. Prevent redundant memory_search tool calls when memory is already injected
 */

import { createLogger } from '../logger.js';
import type { KnowledgeContext } from './knowledge-augmenter.js';

const log = createLogger('memory:advisor');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AdvisorDecision {
  /** Which sources were used */
  usedMemory: boolean;
  usedDocs: boolean;
  /** Whether tool usage is recommended */
  toolsRecommended: boolean;
  /** Advisory instruction appended to system prompt */
  advisoryInstruction: string;
  /** Human-readable reasoning */
  reasoning: string;
  /** Confidence level in the available knowledge */
  knowledgeConfidence: 'high' | 'medium' | 'low' | 'none';
  /** Whether the query was classified as personal (identity, preferences, etc.) */
  isPersonalQuery: boolean;
  /** Detected domain for specialized reasoning */
  detectedDomain: 'legal' | 'medical' | 'technical' | 'financial' | 'general';
  /** Whether external verification was recommended */
  externalVerificationNeeded: boolean;
  /** Number of source citations available */
  citationCount: number;
  /** Timestamp */
  timestamp: number;
}

export interface AdvisorConfig {
  /** If true, orchestrator advises LLM on tool usage */
  enabled: boolean;
  /** Min memory items to consider knowledge "sufficient" */
  memoryThreshold: number;
  /** Min doc chunks to consider knowledge "sufficient" */
  docsThreshold: number;
  /** Tools to suppress when knowledge covers the query */
  redundantTools: string[];
}

export const DEFAULT_ADVISOR_CONFIG: AdvisorConfig = {
  enabled: true,
  memoryThreshold: 1,
  docsThreshold: 2,
  redundantTools: ['memory_search'],
};

// ---------------------------------------------------------------------------
// Personal Query Detection
// ---------------------------------------------------------------------------

/** Patterns that indicate the query is about the user's personal information */
const PERSONAL_QUERY_PATTERNS = [
  /\b(?:what(?:'s| is) )?my\s+(?:name|email|job|role|title|employer|company|workplace)/i,
  /\bwhere\s+do\s+i\s+(?:work|live|study)/i,
  /\bwho\s+am\s+i\b/i,
  /\bwhat\s+(?:do\s+i|is\s+my)\s+(?:do|prefer|like|use|favorite|favourite)/i,
  /\b(?:tell\s+me\s+)?about\s+(?:me|myself)\b/i,
  /\bdo\s+(?:you\s+)?(?:know|remember)\s+(?:my|me|who\s+i)/i,
  /\bwhat\s+(?:have\s+)?(?:i|you)\s+(?:told|taught|said|mentioned)\b/i,
  /\bremember\s+(?:what|that|when|my)\b/i,
];

export function isPersonalQuery(query: string): boolean {
  return PERSONAL_QUERY_PATTERNS.some(p => p.test(query));
}

// ---------------------------------------------------------------------------
// AdvisorOrchestrator
// ---------------------------------------------------------------------------

export class AdvisorOrchestrator {
  private config: AdvisorConfig;
  private decisionHistory: AdvisorDecision[] = [];

  constructor(config?: Partial<AdvisorConfig>) {
    this.config = { ...DEFAULT_ADVISOR_CONFIG, ...config };
  }

  /**
   * Given the knowledge context from the augmenter, produce an orchestration
   * decision that guides the LLM's tool usage and response strategy.
   */
  decide(query: string, knowledgeCtx: KnowledgeContext): AdvisorDecision {
    if (!this.config.enabled) {
      return this.neutralDecision();
    }

    const usedMemory = knowledgeCtx.memoryItemCount > 0;
    const usedDocs = knowledgeCtx.docChunkCount > 0;
    const memoryAboveThreshold = knowledgeCtx.memoryItemCount >= this.config.memoryThreshold;
    const docsAboveThreshold = knowledgeCtx.docChunkCount >= this.config.docsThreshold;

    let knowledgeConfidence: AdvisorDecision['knowledgeConfidence'];
    let toolsRecommended: boolean;
    let advisoryInstruction: string;
    let reasoning: string;

    if (memoryAboveThreshold && docsAboveThreshold) {
      // Strong knowledge from both sources
      knowledgeConfidence = 'high';
      toolsRecommended = false;
      advisoryInstruction =
        'You have relevant knowledge from both your memory and ingested documents. ' +
        'Answer using this retrieved context. Do not call memory_search — the relevant memories are already provided above. ' +
        'Only use tools if you need to perform an ACTION (like running a command), not for information retrieval.';
      reasoning = `High confidence: ${knowledgeCtx.memoryItemCount} memory items + ${knowledgeCtx.docChunkCount} doc chunks available`;

    } else if (memoryAboveThreshold || docsAboveThreshold) {
      // Moderate knowledge from one source
      knowledgeConfidence = 'medium';
      toolsRecommended = false;
      advisoryInstruction =
        'You have some relevant knowledge from your ' +
        (memoryAboveThreshold ? 'memory' : 'document corpus') +
        '. Use it to ground your answer. Do not call memory_search — any relevant memories are already provided above. ' +
        'Use tools only if you need to perform an action or if the provided context is clearly insufficient.';
      reasoning = `Medium confidence: ${knowledgeCtx.memoryItemCount} memory + ${knowledgeCtx.docChunkCount} docs`;

    } else if (usedMemory || usedDocs) {
      // Weak knowledge — some results but below thresholds
      // P8-2.2g: Email queries with evidence should NOT be marked as weak
      if (knowledgeCtx.isEmailFocused && usedDocs) {
        knowledgeConfidence = 'high';
        toolsRecommended = false;
        advisoryInstruction =
          'You have email evidence from the user\'s inbox in the [DOC-N] chunks above. ' +
          'Answer using this email content. Do not call memory_search or cognitive_query — the emails are already provided. ' +
          'Do not suggest checking external sources or email clients.';
        reasoning = `Email evidence mode: ${knowledgeCtx.docChunkCount} email chunks loaded — treating as high confidence`;
      } else {
        knowledgeConfidence = 'low';
        toolsRecommended = true;
        advisoryInstruction =
          'Limited knowledge was found. You may use the provided context but consider using tools if more information is needed. ' +
          'Do not call memory_search — any relevant memories are already provided above.';
        reasoning = `Low confidence: only ${knowledgeCtx.memoryItemCount} memory + ${knowledgeCtx.docChunkCount} docs`;
      }

    } else {
      // No knowledge found
      knowledgeConfidence = 'none';
      toolsRecommended = true;

      // P8-2.2g: Email queries with zero results — truthful internal fallback
      if (knowledgeCtx.isEmailFocused) {
        toolsRecommended = false;
        advisoryInstruction =
          'No email content was found in AgentX memory for this query. ' +
          'Tell the user: "I couldn\'t find any emails in AgentX memory matching that query." ' +
          'Do NOT suggest checking an email client or external sources. ' +
          'Do NOT fabricate or hallucinate email content.';
        reasoning = 'Email query but no email evidence found — truthful fallback';
      // STEP 3 ENFORCEMENT: Personal queries with zero memory MUST NOT hallucinate
      } else if (isPersonalQuery(query)) {
        advisoryInstruction =
          'IMPORTANT: This appears to be a personal query about the user, but NO relevant stored information was found in memory. ' +
          'You MUST NOT guess or hallucinate personal details. Instead, respond with something like: ' +
          '"I don\'t have that information stored in my memory. Could you tell me, and I\'ll remember it for next time?" ' +
          'Do NOT answer confidently with made-up personal information.';
        reasoning = 'Personal query detected but NO memory found — hallucination guard active';
        log.warn({ query: query.slice(0, 80) }, 'Personal query with ZERO memory results — hallucination guard enforced');
      } else {
        advisoryInstruction =
          'No relevant knowledge was found in memory or documents for this query. ' +
          'Answer from your general knowledge, or use tools if you need to perform an action or look up information.';
        reasoning = 'No knowledge found in any source';
      }
    }

    const personal = isPersonalQuery(query);
    const detectedDomain = knowledgeCtx.detectedDomain ?? 'general';
    const externalVerificationNeeded = knowledgeCtx.externalVerificationNeeded ?? false;
    const citationCount = knowledgeCtx.citations?.length ?? 0;

    // ── P6-19.9: Query Intent for mode routing ──────────────────────
    const queryIntent = knowledgeCtx.queryIntent;

    // ── Domain-Specific Advisory Layer ──────────────────────────────
    // Append specialized instructions based on detected domain
    // P6-19.9: Skip legal strategy advisory for fact extraction queries
    // P8-2.2g: Skip domain advisory entirely for email-focused queries — it conflicts with email evidence mode
    if (queryIntent !== 'fact_extraction' && !knowledgeCtx.isEmailFocused) {
      const domainAdvisory = this.buildDomainAdvisory(detectedDomain, externalVerificationNeeded, knowledgeConfidence);
      if (domainAdvisory) {
        advisoryInstruction += '\n\n' + domainAdvisory;
      }
    }

    // ── Structured Advice Format ────────────────────────────────────
    // For substantive queries (not simple greetings/commands), require structured output
    const isSubstantiveQuery = query.length > 30 && !query.startsWith('/');
    if (isSubstantiveQuery && (usedMemory || usedDocs || externalVerificationNeeded)) {
      // P8-2.2g: Email evidence mode ALWAYS takes priority — must read evidence first
      // Even when query crosses into legal domain ("how could this email help my tribunal"),
      // the model must READ the email evidence before applying any legal analysis.
      if (knowledgeCtx.isEmailFocused && usedDocs) {
        // P8-2.2g: Email-specific advisory — MUST NOT invite uncertainty or external fallback
        // This takes priority even when domain is legal/medical — the model must read the
        // email evidence FIRST, then apply domain-specific analysis to what it found.
        advisoryInstruction += '\n\n' +
          'RESPONSE FORMAT FOR EMAIL QUERIES:\n' +
          'CRITICAL: Read ALL [DOC-N] email evidence chunks above FIRST. They contain REAL emails.\n' +
          'Answer directly from the email evidence provided in the [DOC-N] chunks above.\n' +
          'Summarise, analyse, or answer based on what the emails actually say.\n' +
          'Reference specific senders, dates, subjects, and content from the evidence.\n' +
          'Do NOT say information is missing or uncertain — the emails ARE the answer.\n' +
          'Do NOT say "I don\'t see an email from [name]" — READ the [DOC-N] chunks carefully.\n' +
          'Do NOT suggest checking external sources, email clients, or other tools.\n' +
          'Do NOT mention relevance scores, confidence levels, or retrieval internals.\n' +
          'If the user asks for thoughts or analysis, provide substantive analysis of the email content.\n' +
          'If the user asks about legal/tribunal implications, analyse the ACTUAL email content for legal relevance.';
      } else if (detectedDomain === 'legal' && queryIntent !== 'fact_extraction') {
        // P6-19.9: Legal verified output format only for strategy queries, NOT fact extraction
        advisoryInstruction += '\n\n' +
          'VERIFIED LEGAL OUTPUT FORMAT (REQUIRED — you MUST use these exact section headings for all legal responses):\n\n' +
          '## Issue\n' +
          'State each distinct legal issue clearly. Name the area of law and jurisdiction.\n\n' +
          '## Facts\n' +
          'Summarise relevant facts from memory/documents. Cite each as [MEM-N] or [DOC-N].\n' +
          'Classify each fact:\n' +
          '- ESTABLISHED — supported by a document, email, or contract\n' +
          '- CLAIMED — stated verbally by the user, not yet documented\n' +
          '- ASSUMED — inferred from context, not directly stated\n\n' +
          '## Law\n' +
          'State the applicable legislation, regulations, and case law with specific references.\n' +
          'Include section numbers (e.g., ERA 1996 s.98). Cite web sources as [WEB-N] with authority tier (HIGH/MEDIUM).\n' +
          'Only rely on HIGH and MEDIUM authority sources. Do NOT cite LOW authority sources for legal positions.\n\n' +
          '## Analysis\n' +
          'Apply law to facts for each issue. State who bears the burden of proof.\n' +
          'Rate evidence strength: STRONG (documented + corroborated), MODERATE (documented OR corroborated), WEAK (verbal only).\n\n' +
          '## Strengths\n' +
          'List specific factors supporting the user\'s position. Cite the evidence for each.\n\n' +
          '## Weaknesses\n' +
          'List specific factors that could undermine the user\'s position.\n' +
          'Include likely counter-arguments the opposing side would raise.\n' +
          'Note any gaps in evidence or procedural vulnerabilities.\n\n' +
          '## Next Steps\n' +
          'Practical, prioritised actions with deadlines where applicable.\n' +
          'Include: evidence to gather, people to contact, formal steps to take.\n' +
          'Note critical time limits (e.g., 3 months less 1 day for ET1 claims).\n\n' +
          '## Sources\n' +
          'List ALL references used:\n' +
          '- [MEM-N] — memory items (with category)\n' +
          '- [DOC-N] — uploaded documents\n' +
          '- [WEB-N] — web sources with authority level (HIGH/MEDIUM only)\n\n' +
          '## Confidence\n' +
          'Rate overall confidence: HIGH / MEDIUM / LOW.\n' +
          'State what specific additional information or evidence would increase confidence.\n\n' +
          'CONTRADICTION RULE: If ANY source contradicts another — memory vs law, document vs document, ' +
          'or current vs outdated — you MUST add a section:\n' +
          '## ⚠ Contradictions Detected\n' +
          'List each contradiction with both sides cited. State which source should take precedence and why.';
      } else {
        advisoryInstruction += '\n\n' +
          'RESPONSE FORMAT: Structure your response with these sections when providing advice or analysis:\n' +
          '1. **Context** — What relevant information was found in memory/documents (cite sources using [MEM-N] or [DOC-N] references)\n' +
          '2. **Analysis** — Your reasoning connecting the evidence to the question\n' +
          '3. **Advice** — Clear, actionable next steps or answer\n' +
          '4. **Sources** — List the memory and document references used\n' +
          'If information is uncertain or incomplete, explicitly state what is missing and what assumptions you are making.\n' +
          'If external verification is recommended, suggest specific searches or sources the user should consult.';
      }
    }

    const decision: AdvisorDecision = {
      usedMemory,
      usedDocs,
      toolsRecommended,
      advisoryInstruction,
      reasoning,
      knowledgeConfidence,
      isPersonalQuery: personal,
      detectedDomain,
      externalVerificationNeeded,
      citationCount,
      timestamp: Date.now(),
    };

    this.decisionHistory.push(decision);
    // Keep history bounded
    if (this.decisionHistory.length > 100) {
      this.decisionHistory = this.decisionHistory.slice(-50);
    }

    log.info({
      confidence: knowledgeConfidence,
      memory: knowledgeCtx.memoryItemCount,
      docs: knowledgeCtx.docChunkCount,
      toolsRecommended,
    }, 'Advisory decision made');

    return decision;
  }

  /**
   * Get the list of tools that should be suppressed when knowledge is sufficient.
   */
  getRedundantTools(): string[] {
    return this.config.redundantTools;
  }

  getDiagnostics(): Record<string, unknown> {
    const recent = this.decisionHistory.slice(-20);
    const confidenceDist = {
      high: recent.filter(d => d.knowledgeConfidence === 'high').length,
      medium: recent.filter(d => d.knowledgeConfidence === 'medium').length,
      low: recent.filter(d => d.knowledgeConfidence === 'low').length,
      none: recent.filter(d => d.knowledgeConfidence === 'none').length,
    };

    return {
      enabled: this.config.enabled,
      totalDecisions: this.decisionHistory.length,
      recentConfidenceDistribution: confidenceDist,
      redundantTools: this.config.redundantTools,
      lastDecision: this.decisionHistory.length > 0
        ? this.decisionHistory[this.decisionHistory.length - 1]
        : null,
    };
  }

  /**
   * Build domain-specific advisory instructions for specialized reasoning modes.
   */
  private buildDomainAdvisory(
    domain: AdvisorDecision['detectedDomain'],
    externalVerificationNeeded: boolean,
    confidence: AdvisorDecision['knowledgeConfidence'],
  ): string {
    const parts: string[] = [];

    switch (domain) {
      case 'legal':
        parts.push(
          'ADVANCED LEGAL REASONING MODE:',
          '',
          '**Issue Identification:**',
          '- Identify all distinct legal issues raised by the query',
          '- For each issue, state the specific area of law (employment, contract, tort, etc.)',
          '- Note which jurisdiction applies (UK/England & Wales unless stated otherwise)',
          '',
          '**Legal Test Application:**',
          '- Apply relevant statutory tests (e.g., ERA 1996 s.98 for unfair dismissal)',
          '- Reference specific legislation by name, section, and year',
          '- Note qualifying periods, time limits, and procedural requirements',
          '',
          '**Burden of Proof:**',
          '- State who bears the burden of proof for each issue',
          '- Distinguish between balance of probabilities (civil) and beyond reasonable doubt (criminal)',
          '',
          '**Evidence Ranking:**',
          '- Primary evidence: contracts, written correspondence, official documents',
          '- Secondary evidence: witness accounts, verbal agreements, custom & practice',
          '- Rate evidence strength: STRONG (documented + corroborated), MODERATE (documented OR corroborated), WEAK (verbal/uncorroborated)',
          '',
          '**Counter-Arguments:**',
          '- For each issue, present BOTH sides — the user\'s position AND likely opposing arguments',
          '- Identify potential weaknesses in the user\'s case',
          '- Note any facts that could undermine the claim',
          '',
          '**Risk Analysis:**',
          '- Assess likelihood of success for each issue (High/Medium/Low)',
          '- Note costs, time, and practical risks of pursuing each avenue',
          '- Consider alternative dispute resolution (ACAS, mediation) vs tribunal',
          '',
          '**Strategy Suggestions:**',
          '- Recommend immediate practical steps',
          '- Suggest evidence to gather or preserve',
          '- Note critical deadlines (e.g., 3-month less 1 day for ET claims)',
          '',
          '- Cross-reference memory documents with applicable law',
          '- Highlight any contradictions between the user\'s account and legal requirements',
          '- ALWAYS include disclaimer: "This is informational guidance, not legal advice. Consult a qualified solicitor for specific legal matters."',
        );
        if (externalVerificationNeeded) {
          parts.push(
            '',
            '**External Verification (REQUIRED for legal queries):**',
            '- Use web_search with domain="legal" to verify current statutory positions',
            '- Prioritise HIGH authority sources: legislation.gov.uk, gov.uk, judiciary.uk',
            '- Only cite HIGH/MEDIUM authority sources in your analysis',
            '- If web search returns contradictory information to memory, flag it explicitly',
          );
        }
        break;

      case 'medical':
        parts.push(
          'MEDICAL REASONING MODE:',
          '- Be cautious and evidence-based',
          '- Never diagnose or prescribe',
          '- ALWAYS include a disclaimer: "This is general health information, not medical advice. Consult a healthcare professional."',
          '- If uncertain, recommend professional consultation',
        );
        break;

      case 'financial':
        parts.push(
          'FINANCIAL REASONING MODE:',
          '- Distinguish between general information and financial advice',
          '- Note that regulations and rates change frequently',
          '- ALWAYS include a disclaimer: "This is general financial information, not personalized financial advice. Consult a qualified financial advisor."',
        );
        if (externalVerificationNeeded) {
          parts.push('- Use web_search to verify current rates, regulations, or deadlines');
        }
        break;

      case 'technical':
        parts.push(
          'TECHNICAL REASONING MODE:',
          '- Be precise and step-by-step',
          '- Include code examples where helpful',
          '- Note version-specific differences',
          '- Distinguish between documented behavior and common practice',
        );
        break;

      default:
        // General — no special instructions
        break;
    }

    if (confidence === 'low' || confidence === 'none') {
      parts.push(
        'INFORMATION INTEGRITY:',
        '- You have LIMITED or NO stored knowledge for this query',
        '- Do NOT present assumptions as facts',
        '- Clearly state what you know vs. what you are inferring',
        '- If the question requires specific factual data you do not have, say so explicitly',
      );
    }

    return parts.length > 0 ? parts.join('\n') : '';
  }

  private neutralDecision(): AdvisorDecision {
    return {
      usedMemory: false,
      usedDocs: false,
      toolsRecommended: true,
      advisoryInstruction: '',
      reasoning: 'Orchestrator disabled',
      knowledgeConfidence: 'none',
      isPersonalQuery: false,
      detectedDomain: 'general',
      externalVerificationNeeded: false,
      citationCount: 0,
      timestamp: Date.now(),
    };
  }
}
