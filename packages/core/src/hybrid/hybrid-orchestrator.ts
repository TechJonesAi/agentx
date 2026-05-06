/**
 * Hybrid Orchestrator — The central coordinator for P6-11.
 *
 * Orchestrates the full hybrid pipeline:
 *   1. Controller (qwen2.5-coder:32b) plans tool usage
 *   2. ForcedVerification enforces mandatory tools
 *   3. Tools execute and results are collected
 *   4. VerifiedContextBuilder scores and structures evidence
 *   5. Reasoner (llama3.1:70b-32k) produces final answer from verified context ONLY
 *
 * This replaces the previous approach of letting the LLM decide
 * whether to call tools. For legal/medical/financial queries,
 * tool execution is DETERMINISTIC.
 */

import { createLogger } from '../logger.js';
import { ToolPlanner } from './tool-planner.js';
import type { ToolPlan } from './tool-planner.js';
import { ForcedVerificationEngine } from './forced-verification.js';
import type { ForcedVerificationResult } from './forced-verification.js';
import { VerifiedContextBuilder } from './verified-context-builder.js';
import type { VerifiedContext } from './verified-context-builder.js';
import {
  isStrategicQuery,
  STRATEGY_REASONER_PROMPT,
  extractStrategicSignals,
  buildStrategicSignalsBlock,
  parseStrategicAssessment,
  emptyAssessment,
} from './strategic-reasoner.js';
import type { StrategicAssessment } from './strategic-reasoner.js';
import type { ModelFabric } from '../llm/model-fabric.js';
import type { ToolRegistry } from '../tools/index.js';
import type { ToolDefinition, Message, LLMResponse } from '../types.js';

const log = createLogger('hybrid:orchestrator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface HybridResult {
  /** Final response from the reasoner */
  response: string;
  /** The tool plan from the controller */
  toolPlan: ToolPlan;
  /** Verification enforcement result */
  verification: ForcedVerificationResult;
  /** Verified context that was sent to the reasoner */
  verifiedContext: VerifiedContext;
  /** Which model produced the final response */
  reasonerModel: string;
  /** Total pipeline latency */
  totalLatencyMs: number;
  /** Whether hybrid pipeline was used (vs fallback to standard) */
  usedHybridPipeline: boolean;
  /** P6-19: Strategic assessment (populated when strategy mode is active) */
  strategicAssessment: StrategicAssessment;
}

export interface HybridOrchestratorConfig {
  /** Model for reasoning (final answer) */
  reasonerModel: string;
  /** Domains that trigger hybrid pipeline */
  hybridDomains: string[];
  /** Whether to log diagnostic details */
  verbose: boolean;
}

const DEFAULT_CONFIG: HybridOrchestratorConfig = {
  reasonerModel: 'llama3.1:70b-32k',
  hybridDomains: ['legal', 'medical', 'financial'],
  verbose: true,
};

// ---------------------------------------------------------------------------
// Reasoner System Prompt
// ---------------------------------------------------------------------------

const REASONER_SYSTEM_PROMPT = `You are a specialist reasoning engine. You MUST follow these strict rules:

STRICT RULES:
1. DO NOT call any tools
2. DO NOT fetch any data
3. DO NOT search the internet
4. ONLY reason on the VERIFIED CONTEXT provided below
5. ALL claims must reference citations from the verified context. Use human-readable document names from [DOCUMENT REFERENCES] — NEVER write raw [DOC-N] tags.
6. If the verified context is limited, reason from what IS available — do NOT default to "insufficient evidence"
7. If contradictions are flagged in the context, address them in a dedicated section

Your role is to INTERPRET and REASON about the pre-verified evidence. You are the final analysis layer, not a data-gathering layer.`;

const LEGAL_REASONER_PROMPT = REASONER_SYSTEM_PROMPT + `

CRITICAL DOCUMENT RULES:
- When [DOC-N] evidence exists, you MUST quote directly from it. Use the exact wording (or closest recoverable wording if OCR-degraded).
- Format quotes as: "exact text from document" [DOC-N]
- If the [MANDATORY QUOTES] section is present, you MUST use at least one of those pre-extracted quotes in your answer.
- If document text is OCR-degraded but still readable, extract the clearest recoverable wording — do NOT say "documents do not specify" when text IS present.
- Your answer must START with what the uploaded documents say. Web sources come AFTER.
- Do NOT replace document content with generic web knowledge when the document directly answers the question.
- If a [DOCUMENT REFERENCES] section is provided, use the human-readable document names instead of raw [DOC-N] labels in your output.
  Example: Instead of [DOC-2], write [Grievance Email to Manager, page 3].

PROHIBITED OUTPUT:
- Do NOT provide personality summaries, generic motivational statements, or non-legal observations.
- Do NOT say things like "the claimant is hardworking" or "they seem dedicated" — this is not legally relevant.
- ALL reasoning must be legally grounded, referencing statute, case law principles, or documented facts.
- Think like a tribunal judge: "What would a tribunal make of this evidence?"
- NEVER use [DOC-1], [DOC-2], etc. in your output. ALWAYS replace with the human-readable document name from the [DOCUMENT REFERENCES] section. If no reference map is provided, describe the document by content (e.g., [Dyslexia Assessment Report]).

MANDATORY REASONING RULES:
1. You MUST always identify the most plausible legal claim based on available facts, even if evidence is partial or incomplete.
2. If evidence is limited, you MUST still state: "The strongest argument based on available evidence is..."
3. NEVER use "INSUFFICIENT EVIDENCE" as your final answer for any claim. If evidence is weak, say WHY it is weak and what the argument would be IF the evidence were stronger.
4. You MUST interpret facts into legal meaning. You are NOT allowed to list facts without mapping them to legal elements.
   Example: dyslexia → disability (EqA s.6) → employer knowledge? → duty to adjust (s.20) → breach? → discrimination arising (s.15). If this chain is not attempted, you have FAILED.
5. Confidence must be GRADED, not binary:
   - STRONG: Multiple corroborating facts, direct documentary evidence, clear legal basis
   - MODERATE: Some supporting facts, reasonable inference from available evidence
   - WEAK: Limited evidence but legally viable argument — state what would strengthen it
   Never use "INSUFFICIENT" — use WEAK with explanation instead.

PERSONALISATION RULES (CRITICAL):
6. You are analysing a SPECIFIC PERSON'S case, not writing a legal textbook. Every argument must reference:
   - The claimant's specific condition, role, or situation (from the documents)
   - Specific interactions documented (grievance, meetings, treatment, dismissal)
   - The employer's specific actions or failures
7. PROHIBITED GENERIC LANGUAGE — NEVER write:
   - "generally", "in some cases", "this could potentially", "it may be possible", "one might argue"
   INSTEAD use: "In your case", "Your evidence shows", "Your documents indicate", "Based on your [document name]"
8. NEVER refuse to analyse. You have documents. You have facts. ANALYSE THEM.
   - Do NOT say "I cannot provide legal advice" — you are providing LEGAL ANALYSIS of uploaded documents.
   - Do NOT say "seek professional legal advice" as a substitute for analysis — do the analysis FIRST, then note it is informational.
9. CASE EVIDENCE ORDERING — your output MUST follow this structure:
   a) YOUR case facts from uploaded documents (FIRST — this is the foundation)
   b) Legal framework that applies to YOUR facts (SECOND)
   c) Analysis applying law to YOUR specific situation (THIRD)
   FAIL if generic legal text appears before case-specific evidence.

LEGAL OUTPUT FORMAT (REQUIRED — use these exact section headings):

## Strongest Legal Argument
This section MUST come FIRST. Identify the single strongest legal claim based on YOUR case evidence.
- State the claim type and statutory basis clearly
- Link it to YOUR specific documentary evidence (by document name, not [DOC-N])
- Reference YOUR specific situation: condition, role, employer actions
- Explain WHY this is the strongest argument for YOUR case
- Rate confidence: STRONG / MODERATE / WEAK
This section is MANDATORY. You must ALWAYS identify a strongest argument, even if confidence is WEAK.
FAIL if this section uses generic legal language without referencing the claimant's specific facts.

## Issue
State each distinct legal issue precisely. Name the specific area of law, jurisdiction (e.g., England & Wales), and the statutory framework.

## Legal Classification
Identify ALL potential claims arising from the facts. For each:
- Name the claim type (e.g., unfair dismissal, direct discrimination, failure to make reasonable adjustments, victimisation, harassment, constructive dismissal, wrongful dismissal)
- Cite the statutory basis (e.g., ERA 1996 s.94-98, EqA 2010 s.13, s.15, s.20-21, s.26, s.27)
- Rate viability: STRONG / MODERATE / WEAK (never "INSUFFICIENT EVIDENCE" — use WEAK with explanation)
- If WEAK, state what additional evidence would strengthen the claim

## Facts from Uploaded Documents
Extract and quote relevant facts DIRECTLY from document sources.
- Use direct quotes: "exact text" [Document Name, page N]
- Classify each fact:
  - ESTABLISHED: Documented in writing, quoted directly
  - CLAIMED: Stated by claimant but not independently documented
  - INFERRED: Reasonably inferred from documented facts (state the inference chain)
- If OCR text is imperfect, state: "The document appears to state: 'best recoverable text'"
- Do NOT say information is absent if the evidence contains relevant text
- IMPORTANT: After listing facts, you MUST interpret their legal significance. Raw facts without legal mapping are useless.

## Applicable Law
Applicable legislation with specific section references (ERA 1996 s.98, EqA 2010 s.13, etc.).
Include:
- The specific legal test for each identified claim
- Key case law principles where relevant (e.g., Burchell test for unfair dismissal, Igen v Wong for burden of proof shift)
- Statutory time limits and jurisdictional requirements
Cite web sources as [WEB-N] with authority tier. Only use HIGH/MEDIUM authority.

## Fact-to-Law Mapping
For EACH identified claim, create an explicit chain:
1. FACT (from documents) → 2. LEGAL ELEMENT (which part of the test it satisfies) → 3. ASSESSMENT (STRONG/MODERATE/WEAK)

Example chains:
- "Claimant has dyslexia" [Dyslexia Assessment Report] → Protected characteristic (EqA 2010 s.6: disability) → STRONG (medical evidence)
- "No adjustments offered" [Grievance Letter] → Failure to comply with duty (EqA 2010 s.20) → MODERATE (needs comparison with what was requested)
- "Dismissed after raising grievance" [Dismissal Letter] → Detriment following protected act (EqA 2010 s.27: victimisation) → WEAK (needs causation evidence — state what would prove causation)

IMPORTANT: Every fact from the documents MUST appear in at least one chain. Unmapped facts indicate incomplete analysis.

## Burden of Proof
For each claim, state:
- WHO bears the initial burden (usually claimant)
- WHAT they must show (the prima facie case)
- Whether burden SHIFTS (e.g., EqA 2010 s.136: if claimant proves facts from which discrimination could be inferred, burden shifts to respondent)
- Apply "balance of probabilities" standard
- Assess whether the available evidence meets the threshold — if not, state what is missing and how close the evidence gets

## Analysis
Apply the law to the documented facts. For each issue:
- State the legal test or threshold
- Apply the test to the specific facts from the documents
- Consider how a tribunal would weigh this evidence
- Identify procedural consequences (e.g., claim struck out, time-barred, costs risk)
- Rate evidence strength: STRONG / MODERATE / WEAK with reasoning
- If WEAK, explain what the argument would be and what evidence would elevate it

## Likely Employer Defence
For each claim, anticipate the respondent's likely arguments:
- What justification might they offer?
- What evidence might they produce?
- How would they challenge the claimant's case?
- What procedural arguments might they raise?

## Procedural & Evidential Risk
Identify specific procedural risks:
- Time limitation issues (ET1: 3 months less 1 day from EDT; extension only if "not reasonably practicable")
- Early conciliation requirements (ACAS EC certificate)
- Defective form/filing consequences
- Evidential gaps that weaken the position — specify WHAT is missing
- Costs exposure (Employment Tribunal: costs only if unreasonable conduct)
- Deposit order risk (if claim assessed as having "little reasonable prospect of success")

## Strengths
Specific supporting factors with evidence citations. Quote document text where possible.
Frame as: "A tribunal would likely find..."

## Weaknesses
Undermining factors, counter-arguments, evidence gaps.
Be precise — identify what is missing and why it matters.
Frame as: "The respondent would argue..." or "A tribunal might question..."
Do NOT list weaknesses without also stating whether they are fatal or manageable.

## Next Steps
Prioritised practical actions with deadlines.
- Critical time limits with exact calculation method
- Procedural steps in order of urgency
- Evidence gathering priorities (what would strengthen the weakest claims)
- Who to contact and what to prepare
- Whether ACAS early conciliation has been completed

## Sources
ALL references with authority levels. Use human-readable document names only — never [DOC-N].

## Confidence
STRONG / MODERATE / WEAK — never "INSUFFICIENT".
State specifically what evidence would change the assessment.
If WEAK: "The available evidence supports a WEAK but viable argument because..."

IMPORTANT: If ANY contradictions are noted in the context, add:
## Contradictions Detected
List each with both sides cited. State precedence and why.

NOTE: End with: "This analysis is based on your uploaded documents and applicable law. For formal legal representation, consult a solicitor."
NEVER say "I cannot provide legal advice" or refuse to analyse when documents are available.`;

// ---------------------------------------------------------------------------
// HybridOrchestrator
// ---------------------------------------------------------------------------

export class HybridOrchestrator {
  private config: HybridOrchestratorConfig;
  private planner: ToolPlanner;
  private verifier: ForcedVerificationEngine;
  private contextBuilder: VerifiedContextBuilder;
  private fabric: ModelFabric | null = null;
  private toolRegistry: ToolRegistry | null = null;

  // Diagnostics
  private _lastToolPlan: ToolPlan | null = null;
  private _lastVerification: ForcedVerificationResult | null = null;
  private _lastVerifiedContext: VerifiedContext | null = null;
  private _lastResult: HybridResult | null = null;

  constructor(config?: Partial<HybridOrchestratorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.planner = new ToolPlanner();
    this.verifier = new ForcedVerificationEngine();
    this.contextBuilder = new VerifiedContextBuilder();
  }

  setModelFabric(fabric: ModelFabric): void {
    this.fabric = fabric;
    this.planner.setModelFabric(fabric);
    log.info('HybridOrchestrator wired to ModelFabric');
  }

  setToolRegistry(registry: ToolRegistry): void {
    this.toolRegistry = registry;
    log.info('HybridOrchestrator wired to ToolRegistry');
  }

  /**
   * Check if a query/domain should use the hybrid pipeline.
   */
  shouldUseHybrid(domain: string): boolean {
    return this.config.hybridDomains.includes(domain);
  }

  /**
   * Run the full hybrid pipeline:
   * Controller → Forced Verification → Tool Execution → Context Building → Reasoner
   */
  async execute(
    query: string,
    domain: string,
    availableTools: ToolDefinition[],
    knowledgeSummary: string,
    sessionId: string,
    agent: any,
  ): Promise<HybridResult> {
    const pipelineStart = Date.now();

    if (!this.fabric || !this.toolRegistry) {
      throw new Error('HybridOrchestrator not fully wired — need ModelFabric + ToolRegistry');
    }

    log.info({ domain, queryLength: query.length }, 'Hybrid pipeline started');

    // ── STEP 1: Controller plans tool usage ───────────────────────
    let toolPlan: ToolPlan;
    try {
      toolPlan = await this.planner.plan(query, availableTools, domain, knowledgeSummary);
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Controller planning failed — using empty plan');
      toolPlan = {
        tools: [],
        arguments: {},
        sequence: [],
        confidence: 0,
        controllerModel: this.planner.getConfig().controllerModel,
        planningLatencyMs: Date.now() - pipelineStart,
      };
    }
    this._lastToolPlan = toolPlan;

    // ── STEP 2: Enforce forced verification rules ─────────────────
    const verification = this.verifier.enforce(toolPlan, query, domain);
    this._lastVerification = verification;

    log.info({
      controllerTools: verification.controllerTools,
      forcedTools: verification.forcedTools,
      wasForced: verification.wasForced,
      totalTools: verification.toolsToExecute.length,
    }, 'Verification enforcement complete');

    // ── STEP 3: Execute all tools (controller + forced) ───────────
    const toolResults = await this.verifier.executeTools(
      verification,
      this.toolRegistry,
      sessionId,
      agent,
    );

    log.info({
      toolsExecuted: Array.from(toolResults.keys()),
      resultsReceived: Array.from(toolResults.entries()).map(([k, v]) => ({
        tool: k,
        resultLength: v.length,
        hasError: v.startsWith('Error:'),
      })),
    }, 'Tool execution complete');

    // ── STEP 4: Build verified context ────────────────────────────
    const verifiedContext = this.contextBuilder.build(
      toolResults,
      query,
      domain,
      toolPlan.confidence,
      verification.forcedTools,
    );
    this._lastVerifiedContext = verifiedContext;

    // ── STEP 5: Detect strategy mode and select reasoner prompt ────
    const strategyMode = domain === 'legal' && isStrategicQuery(query);

    let reasonerPrompt: string;
    let strategicSignalsBlock = '';

    if (strategyMode) {
      reasonerPrompt = STRATEGY_REASONER_PROMPT;

      // Phase 4+5+6: Extract strategic signals from evidence
      const rawChunks = verifiedContext.memoryEvidence
        .filter(m => m.citation.startsWith('[DOC-'))
        .map(m => ({ citationRef: m.citation, text: m.content, score: m.confidence }));
      const structuredEvidence = rawChunks.map(c => ({
        citationRef: c.citationRef,
        extractedFacts: [] as string[],
        extractedLists: [] as string[],
        extractedQuotes: [] as string[],
        confidence: c.score ?? 0.5,
      }));

      const signals = extractStrategicSignals(
        verifiedContext.contextBlock,
        rawChunks,
        structuredEvidence,
      );
      strategicSignalsBlock = '\n\n' + buildStrategicSignalsBlock(signals);

      log.info({
        strategyMode: true,
        strengthSignals: signals.strengthSignals.length,
        weaknessSignals: signals.weaknessSignals.length,
        gapSignals: signals.gapSignals.length,
        riskSignals: signals.riskSignals.length,
        leverageSignals: signals.leverageSignals.length,
      }, 'P6-19: Strategy mode activated — strategic signals extracted');
    } else if (domain === 'legal') {
      reasonerPrompt = LEGAL_REASONER_PROMPT;
    } else {
      reasonerPrompt = REASONER_SYSTEM_PROMPT;
    }

    const fullReasonerPrompt = reasonerPrompt + '\n\n' +
      verifiedContext.contextBlock + strategicSignalsBlock;

    const reasonerMessages: Message[] = [
      { role: 'user', content: query, timestamp: Date.now() },
    ];

    let response: LLMResponse;
    try {
      response = await this.fabric.completeWithMessages(
        {
          messages: reasonerMessages,
          systemPrompt: fullReasonerPrompt,
          // NO tools — reasoner must NOT call tools
        },
        'reasoning',
        'hybrid-reasoning',
        this.config.reasonerModel,
      );
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Reasoner failed');
      throw err;
    }

    // Phase 8: Parse strategic assessment from response
    const strategicAssessment = strategyMode
      ? parseStrategicAssessment(response.content)
      : emptyAssessment();

    const totalLatencyMs = Date.now() - pipelineStart;

    const result: HybridResult = {
      response: response.content,
      toolPlan,
      verification,
      verifiedContext,
      reasonerModel: this.config.reasonerModel,
      totalLatencyMs,
      usedHybridPipeline: true,
      strategicAssessment,
    };

    this._lastResult = result;

    log.info({
      reasonerModel: this.config.reasonerModel,
      totalLatencyMs,
      evidenceItems: verifiedContext.metadata.totalEvidenceItems,
      contradictions: verifiedContext.contradictions.length,
      confidence: verifiedContext.confidenceScore.toFixed(2),
      wasForced: verification.wasForced,
      strategyMode,
      strategicSections: strategyMode ? {
        strengths: strategicAssessment.strongestArguments.length,
        weaknesses: strategicAssessment.weakPoints.length,
        gaps: strategicAssessment.evidenceGaps.length,
        risks: strategicAssessment.proceduralRisks.length,
        leverage: strategicAssessment.leveragePoints.length,
      } : undefined,
    }, 'Hybrid pipeline complete');

    return result;
  }

  // ── Diagnostics ──────────────────────────────────────────────────

  getLastToolPlan(): ToolPlan | null { return this._lastToolPlan; }
  getLastVerification(): ForcedVerificationResult | null { return this._lastVerification; }
  getLastVerifiedContext(): VerifiedContext | null { return this._lastVerifiedContext; }
  getLastResult(): HybridResult | null { return this._lastResult; }

  getDiagnostics(): Record<string, unknown> {
    return {
      config: this.config,
      planner: this.planner.getDiagnostics(),
      verifier: this.verifier.getDiagnostics(),
      contextBuilder: this.contextBuilder.getDiagnostics(),
      hasFabric: !!this.fabric,
      hasToolRegistry: !!this.toolRegistry,
      lastResult: this._lastResult ? {
        reasonerModel: this._lastResult.reasonerModel,
        totalLatencyMs: this._lastResult.totalLatencyMs,
        toolsUsed: this._lastResult.verification.toolsToExecute.map(t => t.tool),
        wasForced: this._lastResult.verification.wasForced,
        evidenceItems: this._lastResult.verifiedContext.metadata.totalEvidenceItems,
        confidence: this._lastResult.verifiedContext.confidenceScore,
      } : null,
    };
  }
}
