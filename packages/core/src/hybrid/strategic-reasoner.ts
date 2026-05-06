/**
 * Strategic Reasoning Layer (P6-19)
 *
 * Sits ABOVE the standard answer layer to provide case-level strategic
 * analysis for legal/medical/financial queries. Reuses ALL existing
 * infrastructure — retrieval, evidence weighting, citations, contradiction
 * detection, strict evidence mode — and adds:
 *
 *   1. Strategy-mode detection (is the query strategic?)
 *   2. Strategic assessment data model
 *   3. Enhanced reasoner prompt for strategy mode
 *   4. Argument/weakness/gap extraction from evidence
 *   5. Procedural risk identification
 *   6. Leverage point detection
 *
 * This module does NOT duplicate retrieval, memory, or verification logic.
 */

import { createLogger } from '../logger.js';

const log = createLogger('hybrid:strategic-reasoner');

// ---------------------------------------------------------------------------
// Phase 2: Strategic Reasoning Data Model
// ---------------------------------------------------------------------------

export interface StrategicPoint {
  summary: string;
  supportingCitations: string[];
  sourceType: 'document' | 'memory' | 'web' | 'inferred';
  confidence: number;
  whyItMatters: string;
}

export interface StrategicGap {
  description: string;
  whatIsMissing: string;
  impact: 'critical' | 'significant' | 'minor';
  howToFill: string;
}

export interface StrategicRisk {
  risk: string;
  severity: 'high' | 'medium' | 'low';
  mitigation: string;
  citations: string[];
}

export interface StrategicAction {
  action: string;
  priority: 'urgent' | 'important' | 'advisable';
  deadline?: string;
  reason: string;
}

export interface StrategicAssessment {
  /** Whether strategy mode was activated */
  isStrategyMode: boolean;
  /** Core issue identified */
  issue: string;
  /** Strongest arguments for the case */
  strongestArguments: StrategicPoint[];
  /** Weaknesses and vulnerabilities */
  weakPoints: StrategicPoint[];
  /** Evidence gaps that need filling */
  evidenceGaps: StrategicGap[];
  /** What the opposing side would argue */
  likelyCounterArguments: StrategicPoint[];
  /** Procedural and time-limit risks */
  proceduralRisks: StrategicRisk[];
  /** Strategic leverage points */
  leveragePoints: StrategicPoint[];
  /** Recommended next steps */
  nextSteps: StrategicAction[];
  /** Overall confidence in the assessment */
  confidence: number;
  /** Source traceability — which evidence supports which conclusions */
  traceability: Array<{
    conclusion: string;
    supportedBy: string[];
    category: 'strength' | 'weakness' | 'gap' | 'risk' | 'leverage';
  }>;
}

// ---------------------------------------------------------------------------
// Phase 3: Strategy Mode Detection
// ---------------------------------------------------------------------------

const STRATEGY_PATTERNS = [
  /\b(strongest|best|most\s+powerful)\s+(arguments?|case|claims?|points?|position)/i,
  /\b(weaknesses?|weak\s+points?|vulnerable|undermines?)\b.*\b(case|claim|argument|position)/i,
  /\bwhat\s+would\s+(the\s+)?(employer|respondent|other\s+side|opposition|defendant)\s+(\w+\s+)?(argue|say|claim|counter)/i,
  /\b(counter.?arguments?|opposing\s+arguments?|other\s+side)/i,
  /\b(evidence\s+gap|missing\s+evidence|what\s+evidence|proof\s+.*missing)/i,
  /\b(how\s+should\s+I\s+frame|framing|strategy|strategic|tactical)/i,
  /\b(risk|risks?)\s+(if\s+I|of\s+doing|of\s+not|procedural|tribunal|time\s+limit)|\b(procedural|tribunal)\s+(risks?)/i,
  /\b(leverage|advantage|strongest\s+position|tactical\s+advantage)/i,
  /\b(assess|assessment|evaluate|analyse|analyze)\s+(my\s+)?(case|claim|position|chances)/i,
  /\b(chances?\s+of\s+(winning|success|succeeding))/i,
  /\b(how\s+strong|strengths?\s+and\s+weaknesses?|pros?\s+and\s+cons?)/i,
  /\b(how\s+can\s+(this|it|the\s+claim)\s+be\s+challenged)/i,
  /\b(what\s+are\s+my\s+options)/i,
  /\b(should\s+I\s+(pursue|drop|settle|proceed|file|withdraw))/i,
];

/**
 * Detect whether a query is strategic (requiring case-level reasoning)
 * vs informational (just needing an answer).
 */
export function isStrategicQuery(query: string): boolean {
  const q = query.toLowerCase();
  return STRATEGY_PATTERNS.some(p => p.test(q));
}

// ---------------------------------------------------------------------------
// Phase 3 + 7: Strategy Reasoner Prompt
// ---------------------------------------------------------------------------

export const STRATEGY_REASONER_PROMPT = `You are a specialist LEGAL STRATEGY reasoning engine. You must provide case-level strategic analysis, not just legal summaries.

STRICT RULES:
1. DO NOT call any tools or fetch any data
2. ONLY reason on the VERIFIED CONTEXT provided below
3. ALL claims must reference citations ([DOC-N], [MEM-N], [WEB-N])
4. If evidence is insufficient, say so explicitly — do NOT fabricate
5. Do NOT present yourself as a barrister or give definitive legal advice
6. Reason formally, precisely, and with litigation awareness

DOCUMENT-FIRST ENFORCEMENT:
- [DOC-N] references are PRIMARY evidence from uploaded documents
- Quote directly from [DOC-N] sources using "quoted text" [DOC-N] format
- If [MANDATORY QUOTES] section exists, use at least one quote
- Web sources [WEB-N] are SECONDARY — they verify/supplement only
- If document evidence is weak or missing, state this explicitly

STRATEGIC OUTPUT FORMAT (REQUIRED — use these exact section headings):

## Issue
State the core legal issue precisely. Name the area of law, jurisdiction, and statutory framework.

## Strongest Arguments
For each strong argument:
- State the argument clearly
- Cite supporting evidence ([DOC-N], [MEM-N])
- Explain WHY this argument is strong (legal test met, evidence quality, pattern)
- Rate: STRONG / MODERATE

Look for:
- Repeated patterns of conduct documented across multiple sources
- Documentary inconsistency by employer/respondent
- Procedural failures by employer (no process followed, no investigation)
- Timeline supporting causation (protected act → detriment)
- Absence of proper disciplinary/grievance process
- Written evidence contradicting the employer's stated position

## Weak Points
For each weakness:
- State the weakness honestly
- Explain why it undermines the case
- Suggest how it might be mitigated
- Rate impact: HIGH / MEDIUM / LOW

Look for:
- Missing dates or incomplete chronology
- Missing comparator evidence (discrimination claims)
- Poor documentary support for key allegations
- Ambiguous causation chain
- Delay in raising complaint
- Inconsistent statements from claimant

## Likely Counter-Arguments
For each counter-argument the opposing side would raise:
- State the argument as the opponent would frame it
- Identify the evidence or law they would rely on
- Assess how strong this counter-argument is
- Suggest how to rebut it

Common employer counter-arguments:
- Performance issues, not discrimination/victimisation
- Genuine redundancy/business reorganisation
- No causal link between protected act and treatment
- Fair procedure was followed
- Time-barred / out of jurisdiction
- Reasonable management action

## Evidence Gaps
List specific evidence that is missing and needed:
- What document/witness/record is absent
- Why it matters (which argument it would support or undermine)
- How critical: CRITICAL / SIGNIFICANT / MINOR
- How it could potentially be obtained

## Procedural & Time Limit Risks
Identify specific procedural risks:
- Time limits (ET1: 3 months less 1 day from EDT / last act of discrimination)
- ACAS Early Conciliation requirements and timing
- Incomplete or defective ET1 (Rule 10/12 rejection risk)
- Jurisdiction issues
- Costs exposure and deposit orders
- Strike-out risk for weak claims
- Without prejudice / protected conversation implications

## Strategic Leverage
Identify where the tactical advantage lies:
- Where documentary evidence is strongest
- Employer procedural failures that are difficult to defend
- Inconsistencies between employer's documents/emails and stated position
- Adverse inference opportunities (missing documents, failure to disclose)
- Whether a narrower but stronger claim outperforms a broader weaker one
- Settlement leverage points
- Practical factors (employer reputation, cost of defence)

## Recommended Next Steps
Prioritised practical actions:
1. Urgent (do immediately — time-critical)
2. Important (do soon — strengthens position)
3. Advisable (when possible — improves case)

For each: what to do, why, and any deadline.

## Sources
ALL references: [DOC-N], [MEM-N], [WEB-N] with source type and authority level.

## Confidence
OVERALL: HIGH / MEDIUM / LOW
State what specific evidence or information would increase confidence.

IMPORTANT: If contradictions are flagged in the context, add:
## Contradictions Detected
List each with both sides cited. State which source has higher authority and why.

DISCLAIMER: Always end with: "This is strategic analysis for informational purposes only, not legal advice. Consult a qualified solicitor before taking action."`;

// ---------------------------------------------------------------------------
// Phase 4+5+6: Strategic Argument Extraction from Evidence
// ---------------------------------------------------------------------------

/**
 * Extract strategic arguments from retrieved evidence and verified context.
 * This is a deterministic pre-analysis that helps the LLM produce better
 * strategic output by highlighting patterns the model might miss.
 */
export function extractStrategicSignals(
  contextBlock: string,
  rawChunks: Array<{ citationRef: string; text: string; score?: number }>,
  structuredEvidence: Array<{
    citationRef: string;
    extractedFacts: string[];
    extractedLists: string[];
    extractedQuotes: string[];
    confidence: number;
  }>,
): {
  strengthSignals: string[];
  weaknessSignals: string[];
  gapSignals: string[];
  riskSignals: string[];
  leverageSignals: string[];
} {
  const strengthSignals: string[] = [];
  const weaknessSignals: string[] = [];
  const gapSignals: string[] = [];
  const riskSignals: string[] = [];
  const leverageSignals: string[] = [];

  // Analyse each chunk for strategic patterns
  for (const chunk of rawChunks) {
    const text = chunk.text.toLowerCase();
    const ref = chunk.citationRef;

    // ── STRENGTH signals ──────────────────────────────────
    if (/\b(repeated(ly)?|pattern|multiple\s+occasions|series\s+of|systematic)\b/.test(text)) {
      strengthSignals.push(`${ref}: Evidence of repeated/pattern conduct`);
    }
    if (/\b(fail(ed|ure)?\s+to\s+(follow|conduct|investigate|consult|provide|apply))\b/.test(text)) {
      strengthSignals.push(`${ref}: Procedural failure by employer/respondent`);
    }
    if (/\b(no\s+(investigation|process|hearing|meeting|consultation|procedure))\b/.test(text)) {
      strengthSignals.push(`${ref}: Absence of proper process documented`);
    }
    if (/\b(inconsisten|contradict|at\s+odds|does\s+not\s+match|differs?\s+from)\b/.test(text)) {
      strengthSignals.push(`${ref}: Documentary inconsistency detected`);
    }
    if (/\b(after|following|subsequent\s+to)\b.*\b(complaint|grievance|protected|whistleblow|raised)\b/.test(text)) {
      strengthSignals.push(`${ref}: Timeline may support causation (act → detriment)`);
    }
    if (/\b(email|letter|written|document|record)\b.*\b(show|confirm|prove|evidence|demonstrate)\b/.test(text)) {
      strengthSignals.push(`${ref}: Written evidence supporting claim`);
    }

    // ── WEAKNESS signals ──────────────────────────────────
    if ((chunk.score ?? 1) < 0.3) {
      weaknessSignals.push(`${ref}: Low relevance score (${(chunk.score ?? 0).toFixed(2)}) — evidence may be tangential`);
    }
    if (/\b(unclear|ambiguous|uncertain|vague|not\s+specified)\b/.test(text)) {
      weaknessSignals.push(`${ref}: Contains ambiguous or unclear language`);
    }
    if (/\b(no\s+(date|witness|record|proof|evidence|documentation))\b/.test(text)) {
      weaknessSignals.push(`${ref}: Missing supporting detail noted`);
    }

    // ── RISK signals ──────────────────────────────────────
    if (/\b(time\s*limit|3\s*months?|less\s+1\s+day|out\s+of\s+time|limitation)\b/.test(text)) {
      riskSignals.push(`${ref}: Time limit / limitation period reference`);
    }
    if (/\b(reject(ed|ion)?|struck?\s*out|dismiss(ed)?|barred)\b/.test(text)) {
      riskSignals.push(`${ref}: Rejection/strike-out risk noted`);
    }
    if (/\b(acas|early\s+conciliation|EC\s+certificate)\b/.test(text)) {
      riskSignals.push(`${ref}: ACAS/Early Conciliation procedural point`);
    }
    if (/\b(costs?\s+(order|risk|exposure|warning)|deposit\s+order|wasted\s+costs)\b/.test(text)) {
      riskSignals.push(`${ref}: Costs/deposit risk`);
    }

    // ── LEVERAGE signals ──────────────────────────────────
    if (/\b(employer\s+(fail|did\s+not|never)|no\s+(?:fair|proper|reasonable)\s+(?:process|procedure|investigation))\b/.test(text)) {
      leverageSignals.push(`${ref}: Employer procedural failure — strong leverage`);
    }
    if (/\b(policy|handbook|contract)\b.*\b(breach|violat|not\s+follow|ignored|departed)\b/.test(text)) {
      leverageSignals.push(`${ref}: Employer acted contrary to own policy/contract`);
    }
    if (/\b(adverse\s+inference|fail(ed|ure)?\s+to\s+disclose|missing\s+document)\b/.test(text)) {
      leverageSignals.push(`${ref}: Adverse inference opportunity`);
    }
  }

  // Analyse structured evidence for additional signals
  for (const se of structuredEvidence) {
    const ref = se.citationRef;

    if (se.confidence < 0.4) {
      weaknessSignals.push(`${ref}: OCR confidence low (${se.confidence.toFixed(2)}) — evidence may be difficult to rely on`);
    }

    // Check extracted facts for strategic keywords
    for (const fact of se.extractedFacts) {
      const f = fact.toLowerCase();
      if (/\b(must|shall|required|mandatory|failure)\b/.test(f)) {
        strengthSignals.push(`${ref}: Mandatory obligation identified: "${fact.slice(0, 80)}"`);
      }
      if (/\b(rejected|struck\s+out|time\s+limit|barred)\b/.test(f)) {
        riskSignals.push(`${ref}: Procedural consequence identified: "${fact.slice(0, 80)}"`);
      }
    }
  }

  // ── GAP analysis ──────────────────────────────────────
  // Check for common evidence gaps based on what's NOT in the evidence
  const allText = rawChunks.map(c => c.text.toLowerCase()).join(' ');

  if (!/\b(witness|corroborat|testimony)\b/.test(allText)) {
    gapSignals.push('No witness evidence or corroboration found in documents');
  }
  if (!/\b(grievance|formal\s+complaint|raised\s+.*complaint)\b/.test(allText)) {
    gapSignals.push('No evidence of formal grievance being raised');
  }
  if (!/\b(comparator|treated\s+differently|less\s+favourably)\b/.test(allText)) {
    gapSignals.push('No comparator evidence found (relevant for discrimination claims)');
  }
  if (!/\b(policy|handbook|procedure\s+document)\b/.test(allText)) {
    gapSignals.push('Employer policy/handbook not in evidence');
  }
  if (!/\b(contract|terms?\s+of\s+employment|statement\s+of\s+particulars)\b/.test(allText)) {
    gapSignals.push('Employment contract/terms not in evidence');
  }
  if (!/\b(acas|early\s+conciliation|EC\s+certificate)\b/.test(allText)) {
    gapSignals.push('No ACAS Early Conciliation documentation found');
  }

  // Deduplicate
  const dedup = (arr: string[]) => [...new Set(arr)];

  return {
    strengthSignals: dedup(strengthSignals),
    weaknessSignals: dedup(weaknessSignals),
    gapSignals: dedup(gapSignals),
    riskSignals: dedup(riskSignals),
    leverageSignals: dedup(leverageSignals),
  };
}

/**
 * Build a strategic signals block to inject into the reasoner prompt.
 * This gives the LLM pre-analysed strategic intelligence to work with.
 */
export function buildStrategicSignalsBlock(signals: ReturnType<typeof extractStrategicSignals>): string {
  const parts: string[] = ['[STRATEGIC INTELLIGENCE — Pre-analysed signals from document evidence]'];

  if (signals.strengthSignals.length > 0) {
    parts.push(`STRENGTH SIGNALS (${signals.strengthSignals.length}):`);
    for (const s of signals.strengthSignals.slice(0, 8)) {
      parts.push(`  + ${s}`);
    }
  }

  if (signals.weaknessSignals.length > 0) {
    parts.push(`WEAKNESS SIGNALS (${signals.weaknessSignals.length}):`);
    for (const s of signals.weaknessSignals.slice(0, 6)) {
      parts.push(`  - ${s}`);
    }
  }

  if (signals.gapSignals.length > 0) {
    parts.push(`EVIDENCE GAPS (${signals.gapSignals.length}):`);
    for (const s of signals.gapSignals.slice(0, 6)) {
      parts.push(`  ? ${s}`);
    }
  }

  if (signals.riskSignals.length > 0) {
    parts.push(`PROCEDURAL RISKS (${signals.riskSignals.length}):`);
    for (const s of signals.riskSignals.slice(0, 6)) {
      parts.push(`  ! ${s}`);
    }
  }

  if (signals.leverageSignals.length > 0) {
    parts.push(`LEVERAGE POINTS (${signals.leverageSignals.length}):`);
    for (const s of signals.leverageSignals.slice(0, 6)) {
      parts.push(`  * ${s}`);
    }
  }

  if (parts.length === 1) {
    parts.push('(No strong strategic signals detected in evidence — reason from raw context)');
  }

  parts.push('[END STRATEGIC INTELLIGENCE]');
  return parts.join('\n');
}

/**
 * Parse a structured strategic response into a StrategicAssessment.
 * Falls back gracefully if the model doesn't perfectly follow the format.
 */
export function parseStrategicAssessment(response: string): StrategicAssessment {
  const assessment: StrategicAssessment = {
    isStrategyMode: true,
    issue: '',
    strongestArguments: [],
    weakPoints: [],
    evidenceGaps: [],
    likelyCounterArguments: [],
    proceduralRisks: [],
    leveragePoints: [],
    nextSteps: [],
    confidence: 0.5,
    traceability: [],
  };

  // Extract sections by heading
  const sections = new Map<string, string>();
  const headingPattern = /^##\s+(.+)$/gm;
  let match: RegExpExecArray | null;
  const headings: { name: string; start: number }[] = [];

  while ((match = headingPattern.exec(response)) !== null) {
    headings.push({ name: match[1].trim().toLowerCase(), start: match.index + match[0].length });
  }

  for (let i = 0; i < headings.length; i++) {
    const end = i + 1 < headings.length ? headings[i + 1].start - headings[i + 1].name.length - 4 : response.length;
    sections.set(headings[i].name, response.slice(headings[i].start, end).trim());
  }

  // Parse issue
  assessment.issue = sections.get('issue') ?? '';

  // Parse confidence
  const confSection = sections.get('confidence') ?? '';
  if (/\bHIGH\b/i.test(confSection)) assessment.confidence = 0.85;
  else if (/\bMEDIUM\b/i.test(confSection)) assessment.confidence = 0.55;
  else if (/\bLOW\b/i.test(confSection)) assessment.confidence = 0.25;

  // Extract citations from any section
  const extractCitations = (text: string): string[] => {
    return [...new Set((text.match(/\[(DOC|WEB|MEM)-\d+\]/g) ?? []))];
  };

  // Parse strongest arguments
  const strengthText = sections.get('strongest arguments') ?? '';
  if (strengthText) {
    const points = strengthText.split(/\n(?=[-•*]\s|\d+\.\s)/).filter(s => s.trim().length > 10);
    for (const p of points.slice(0, 6)) {
      const cites = extractCitations(p);
      assessment.strongestArguments.push({
        summary: p.replace(/\[(DOC|WEB|MEM)-\d+\]/g, '').trim().slice(0, 300),
        supportingCitations: cites,
        sourceType: cites.some(c => c.startsWith('[DOC')) ? 'document' : cites.length > 0 ? 'web' : 'inferred',
        confidence: cites.some(c => c.startsWith('[DOC')) ? 0.8 : 0.5,
        whyItMatters: '',
      });
      if (cites.length > 0) {
        assessment.traceability.push({
          conclusion: p.slice(0, 100),
          supportedBy: cites,
          category: 'strength',
        });
      }
    }
  }

  // Parse weak points
  const weakText = sections.get('weak points') ?? '';
  if (weakText) {
    const points = weakText.split(/\n(?=[-•*]\s|\d+\.\s)/).filter(s => s.trim().length > 10);
    for (const p of points.slice(0, 6)) {
      const cites = extractCitations(p);
      assessment.weakPoints.push({
        summary: p.replace(/\[(DOC|WEB|MEM)-\d+\]/g, '').trim().slice(0, 300),
        supportingCitations: cites,
        sourceType: cites.length > 0 ? 'document' : 'inferred',
        confidence: 0.6,
        whyItMatters: '',
      });
      if (cites.length > 0) {
        assessment.traceability.push({
          conclusion: p.slice(0, 100),
          supportedBy: cites,
          category: 'weakness',
        });
      }
    }
  }

  // Parse evidence gaps
  const gapText = sections.get('evidence gaps') ?? '';
  if (gapText) {
    const points = gapText.split(/\n(?=[-•*]\s|\d+\.\s)/).filter(s => s.trim().length > 10);
    for (const p of points.slice(0, 6)) {
      const impact = /CRITICAL/i.test(p) ? 'critical' : /SIGNIFICANT/i.test(p) ? 'significant' : 'minor';
      assessment.evidenceGaps.push({
        description: p.trim().slice(0, 300),
        whatIsMissing: '',
        impact,
        howToFill: '',
      });
      assessment.traceability.push({
        conclusion: p.slice(0, 100),
        supportedBy: extractCitations(p),
        category: 'gap',
      });
    }
  }

  // Parse counter-arguments
  const counterText = sections.get('likely counter-arguments') ?? sections.get('counter-arguments') ?? '';
  if (counterText) {
    const points = counterText.split(/\n(?=[-•*]\s|\d+\.\s)/).filter(s => s.trim().length > 10);
    for (const p of points.slice(0, 6)) {
      const cites = extractCitations(p);
      assessment.likelyCounterArguments.push({
        summary: p.replace(/\[(DOC|WEB|MEM)-\d+\]/g, '').trim().slice(0, 300),
        supportingCitations: cites,
        sourceType: cites.length > 0 ? 'web' : 'inferred',
        confidence: 0.5,
        whyItMatters: '',
      });
    }
  }

  // Parse procedural risks
  const riskText = sections.get('procedural & time limit risks') ?? sections.get('procedural risks') ?? '';
  if (riskText) {
    const points = riskText.split(/\n(?=[-•*]\s|\d+\.\s)/).filter(s => s.trim().length > 10);
    for (const p of points.slice(0, 6)) {
      const severity = /\bhigh\b/i.test(p) ? 'high' : /\bmedium\b/i.test(p) ? 'medium' : 'low';
      assessment.proceduralRisks.push({
        risk: p.trim().slice(0, 300),
        severity,
        mitigation: '',
        citations: extractCitations(p),
      });
      assessment.traceability.push({
        conclusion: p.slice(0, 100),
        supportedBy: extractCitations(p),
        category: 'risk',
      });
    }
  }

  // Parse leverage points
  const leverageText = sections.get('strategic leverage') ?? sections.get('leverage') ?? '';
  if (leverageText) {
    const points = leverageText.split(/\n(?=[-•*]\s|\d+\.\s)/).filter(s => s.trim().length > 10);
    for (const p of points.slice(0, 6)) {
      const cites = extractCitations(p);
      assessment.leveragePoints.push({
        summary: p.replace(/\[(DOC|WEB|MEM)-\d+\]/g, '').trim().slice(0, 300),
        supportingCitations: cites,
        sourceType: cites.some(c => c.startsWith('[DOC')) ? 'document' : 'inferred',
        confidence: cites.length > 0 ? 0.7 : 0.4,
        whyItMatters: '',
      });
      if (cites.length > 0) {
        assessment.traceability.push({
          conclusion: p.slice(0, 100),
          supportedBy: cites,
          category: 'leverage',
        });
      }
    }
  }

  // Parse next steps
  const stepsText = sections.get('recommended next steps') ?? sections.get('next steps') ?? '';
  if (stepsText) {
    const points = stepsText.split(/\n(?=[-•*]\s|\d+\.\s)/).filter(s => s.trim().length > 10);
    for (const p of points.slice(0, 8)) {
      const priority = /\burgent\b/i.test(p) ? 'urgent' : /\bimportant\b/i.test(p) ? 'important' : 'advisable';
      assessment.nextSteps.push({
        action: p.trim().slice(0, 300),
        priority,
        reason: '',
      });
    }
  }

  log.info({
    isStrategy: true,
    strengths: assessment.strongestArguments.length,
    weaknesses: assessment.weakPoints.length,
    gaps: assessment.evidenceGaps.length,
    counterArgs: assessment.likelyCounterArguments.length,
    risks: assessment.proceduralRisks.length,
    leverage: assessment.leveragePoints.length,
    nextSteps: assessment.nextSteps.length,
    confidence: assessment.confidence,
    traceabilityItems: assessment.traceability.length,
  }, 'Strategic assessment parsed');

  return assessment;
}

/**
 * Create an empty (non-strategy) assessment for non-strategic queries.
 */
export function emptyAssessment(): StrategicAssessment {
  return {
    isStrategyMode: false,
    issue: '',
    strongestArguments: [],
    weakPoints: [],
    evidenceGaps: [],
    likelyCounterArguments: [],
    proceduralRisks: [],
    leveragePoints: [],
    nextSteps: [],
    confidence: 0,
    traceability: [],
  };
}
