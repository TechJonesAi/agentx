/**
 * Knowledge Augmenter — Pre-response knowledge retrieval for chat
 *
 * Retrieves relevant context from lifelong memory and cognitive documents
 * before the LLM generates a response. Produces a compact, token-bounded
 * knowledge block that is injected as a system message.
 *
 * This is NOT unified orchestration. It is a pre-response augmentation layer.
 *
 * Retrieval policy:
 *   - Always query lifelong memory (fast, <5ms)
 *   - Always query cognitive docs (fast, FTS-based)
 *   - Inject only top-K results per source
 *   - Cap total injected tokens
 *   - Preserve source provenance
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { createLogger } from '../logger.js';
import { getRecentUploadStore } from './recent-upload-store.js';
import { isEmailFocusedQuery } from './email-focus-detector.js';
import { TemporalRanker, type TemporalHint } from '../retrieval/temporal-ranker.js';

const log = createLogger('memory:knowledge-augmenter');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface KnowledgeAugmentConfig {
  enabled: boolean;
  /** Max lifelong memory items to inject */
  memoryTopK: number;
  /** Max cognitive document chunks to inject */
  docsTopK: number;
  /** Max total characters for the knowledge block */
  maxContextChars: number;
  /** Min finalScore to include memory items from search */
  memoryMinScore: number;
  /**
   * Min finalScore for a result to be injected into context.
   * Results below this are considered noise even if they pass memoryMinScore.
   * This prevents low-relevance memories from contaminating generic queries.
   */
  memoryInjectionFloor: number;
  /** Whether to include source labels */
  showProvenance: boolean;
}

export const DEFAULT_AUGMENT_CONFIG: KnowledgeAugmentConfig = {
  enabled: true,
  memoryTopK: 8,
  docsTopK: 8,
  maxContextChars: 8000,
  memoryMinScore: 0.1,
  memoryInjectionFloor: 0.35,
  showProvenance: true,
};

// ---------------------------------------------------------------------------
// Source interfaces (loose coupling — no hard imports of stores)
// ---------------------------------------------------------------------------

export interface MemorySource {
  search(query: string, opts?: Record<string, unknown>): Array<{
    memory: { id: string; content: string; category: string; source: string };
    finalScore: number;
    matchedTerms: string[];
  }>;
}

export interface CognitiveSource {
  retrieve(query: string, topK?: number, originTypeFilter?: string): {
    route: string;
    chunks: Array<{
      chunk_id: string;
      document_id: string;
      chunk_text: string;
      score?: number;
      /** P6-19.7: Document filename for human-readable references */
      file_name?: string | null;
      /** P6-19.7: Page number within document */
      page_number?: number | null;
      /** P8-2.2: Document origin — 'email' for email-sourced docs */
      origin_type?: string | null;
      /** P8-2.2: Sender address for email-origin documents */
      sender?: string | null;
      /** P8-4.3: Original sender of forwarded emails */
      original_sender?: string | null;
      /** P8-4.3: Original send date of forwarded emails */
      original_date?: string | null;
      /** P8-2.2b: Document creation timestamp for date-aware boosting */
      created_at?: string | null;
      /** P8-2.3: Actual email/document date (from document_date column) */
      document_date?: string | null;
    }>;
    documents: Array<{ document_id: string; file_name: string; sender?: string }>;
    count: number | null;
    count_label: string | null;
  };
  /** P8-2.3: Retrieve most recent email documents by date (not text match) */
  retrieveRecentEmails?(limit?: number): {
    route: string;
    chunks: Array<{
      chunk_id: string;
      document_id: string;
      chunk_text: string;
      score?: number;
      file_name?: string | null;
      page_number?: number | null;
      origin_type?: string | null;
      sender?: string | null;
      original_sender?: string | null;
      original_date?: string | null;
      created_at?: string | null;
      document_date?: string | null;
    }>;
    documents: Array<{ document_id: string; file_name: string; sender?: string }>;
    count: number | null;
    count_label: string | null;
  };
}

// ---------------------------------------------------------------------------
// Augmentation result
// ---------------------------------------------------------------------------

/**
 * Evidence weight tiers — NOT blended into a single score.
 *
 * - primary:        Emails, uploaded documents, attachments, contracts, official correspondence
 * - legal_authority: Statute, official government guidance, tribunal/court decisions
 * - secondary:      Commentary, user-stated facts, notes, blog references, general memory
 *
 * These are distinct tiers used for ranking and filtering.
 * Legal answers MUST prefer legal_authority over secondary commentary.
 * Primary evidence (the user's own documents) is fact, not interpretation.
 */
export type EvidenceWeight = 'primary' | 'legal_authority' | 'secondary';

export interface WeightedCitation {
  sourceType: 'memory' | 'document' | 'entity' | 'web';
  sourceId: string;
  label: string;
  category?: string;
  score?: number;
  /** Evidence weight tier — distinct, not blended */
  weight: EvidenceWeight;
  /** Human-readable weight reason */
  weightReason: string;
  /** Confidence in this specific piece of evidence (0-1) */
  confidence: number;
}

// ---------------------------------------------------------------------------
// Structured Document Evidence — Phase 3 of Strict Evidence Mode
// ---------------------------------------------------------------------------

export interface StructuredDocumentEvidence {
  sourceId: string;
  citationRef: string;
  extractedLists: string[];
  extractedFacts: string[];
  extractedQuotes: string[];
  confidence: number;
}

// ---------------------------------------------------------------------------
// Document Evidence Mode — Phase 1 of Strict Evidence Mode
// ---------------------------------------------------------------------------

export interface DocumentEvidenceMode {
  hasRelevantDocs: boolean;
  docCount: number;
  mustUseDocs: boolean;
  mustQuoteDocs: boolean;
  webSecondaryOnly: boolean;
  /** Raw retrieved chunks for evidence visibility (Phase 4) */
  rawChunks: Array<{ citationRef: string; documentId: string; text: string; score?: number; fileName?: string | null; pageNumber?: number | null }>;
  /** Structured extractions from OCR/document text (Phase 3) */
  structuredEvidence: StructuredDocumentEvidence[];
  /** P6-19.7: Map from [DOC-N] to human-readable label, e.g. "[DOC-1]" → "Equality Act 2010 Notes, page 3" */
  documentReferenceMap: Record<string, string>;
}

export interface KnowledgeContext {
  /** Formatted text block to inject into chat prompt */
  contextBlock: string;
  /** Number of memory items used */
  memoryItemCount: number;
  /** Number of doc chunks used */
  docChunkCount: number;
  /** Total characters injected */
  totalChars: number;
  /** Whether any knowledge was found */
  hasKnowledge: boolean;
  /** Whether memory source was available and queried */
  memoryQueried: boolean;
  /** Whether cognitive/doc source was available and queried */
  docsQueried: boolean;
  /** Any warnings from the retrieval pipeline */
  warnings: string[];
  /** Source citations for transparency */
  citations: Array<{
    sourceType: 'memory' | 'document' | 'entity';
    sourceId: string;
    label: string;
    category?: string;
    score?: number;
  }>;
  /** Weighted citations with evidence tier and confidence */
  weightedCitations: WeightedCitation[];
  /** Overall evidence confidence (0-1) across all sources */
  evidenceConfidence: number;
  /** Detected contradictions between sources */
  contradictions: string[];
  /** Detected domain/intent of the query */
  detectedDomain: 'legal' | 'medical' | 'technical' | 'financial' | 'general';
  /** P6-19.9: Query intent — fact extraction vs strategy analysis */
  queryIntent: 'fact_extraction' | 'strategy' | 'general';
  /** Whether external verification is recommended */
  externalVerificationNeeded: boolean;
  /** Document evidence mode — strict evidence enforcement state */
  documentEvidenceMode: DocumentEvidenceMode;
  /** P6-19.5: Whether retrieval failed (NOT empty — failed) */
  retrievalFailed: boolean;
  /** P6-19.5: Reason for retrieval failure (empty string if ok) */
  retrievalFailureReason: string;
  /** P8-2.2: Whether this query is email-focused (triggers email-origin boosting) */
  isEmailFocused: boolean;
}

// ---------------------------------------------------------------------------
// KnowledgeAugmenter
// ---------------------------------------------------------------------------

export class KnowledgeAugmenter {
  private config: KnowledgeAugmentConfig;
  private memorySource: MemorySource | null = null;
  private cognitiveSource: CognitiveSource | null = null;

  constructor(config?: Partial<KnowledgeAugmentConfig>) {
    this.config = { ...DEFAULT_AUGMENT_CONFIG, ...config };
  }

  setMemorySource(source: MemorySource): void {
    this.memorySource = source;
  }

  setCognitiveSource(source: CognitiveSource): void {
    this.cognitiveSource = source;
  }

  /**
   * Classify evidence weight into one of three distinct tiers:
   *
   * - primary:         The user's own documents — emails, uploaded files,
   *                    attachments, contracts, employment letters, payslips.
   *                    These are FACTS about the user's situation.
   *
   * - legal_authority:  Statute, official government guidance, tribunal decisions,
   *                    ACAS guidance, court rulings. These define what the LAW says.
   *
   * - secondary:       User-stated facts (verbal), general memory, commentary,
   *                    blog references, notes. These are CLAIMS or CONTEXT.
   *
   * These tiers are NOT blended. Legal answers must cite legal_authority
   * for legal positions and primary for the user's facts.
   */
  private classifyEvidenceWeight(
    sourceType: string,
    category: string | undefined,
    content: string,
  ): { weight: EvidenceWeight; reason: string; confidence: number } {
    const lc = content.toLowerCase();

    // ── Legal Authority: statute, official guidance, tribunal/court references ──
    if (
      /\b(legislation|statute|act\s+\d{4}|regulation\s+\d|statutory\s+instrument)\b/i.test(lc) ||
      /\b(s\.\d+|section\s+\d+|article\s+\d+|schedule\s+\d+)\b/i.test(lc) ||
      /\b(tribunal|court\s+of\s+appeal|supreme\s+court|high\s+court|EAT)\b/i.test(lc) ||
      /\b(ACAS\s+(?:code|guidance|early\s+conciliation))\b/i.test(lc) ||
      /\b(gov\.uk|legislation\.gov\.uk|judiciary\.uk)\b/i.test(lc)
    ) {
      return { weight: 'legal_authority', reason: 'Statute/official guidance/tribunal decision', confidence: 0.95 };
    }

    // ── Primary Evidence: the user's own documents, emails, attachments ──
    if (sourceType === 'document') {
      return { weight: 'primary', reason: 'Uploaded document', confidence: 0.9 };
    }
    if (
      category === 'email' ||
      /\b(contract|agreement|letter|offer\s+letter|payslip|p45|p60)\b/i.test(lc) ||
      /\b(signed|dated|attached|enclosed)\b/i.test(lc)
    ) {
      return { weight: 'primary', reason: 'Written correspondence/official document', confidence: 0.85 };
    }
    if (category === 'document') {
      return { weight: 'primary', reason: 'Stored document', confidence: 0.85 };
    }

    // ── Secondary: everything else — user teaching, notes, memory, commentary ──
    if (category === 'user_teaching') {
      return { weight: 'secondary', reason: 'User-stated fact (verbal/chat)', confidence: 0.6 };
    }
    if (category === 'fact' || category === 'preference') {
      return { weight: 'secondary', reason: 'Stored factual memory', confidence: 0.55 };
    }
    return { weight: 'secondary', reason: 'General memory/inferred', confidence: 0.4 };
  }

  /**
   * Calculate overall evidence confidence from weighted citations.
   * Each tier contributes differently — legal_authority and primary
   * carry more weight than secondary commentary.
   */
  private calculateEvidenceConfidence(weightedCitations: WeightedCitation[]): number {
    if (weightedCitations.length === 0) return 0;

    const tierMultiplier: Record<EvidenceWeight, number> = {
      primary: 1.0,
      legal_authority: 1.0,
      secondary: 0.5,
    };
    let totalWeight = 0;
    let weightedSum = 0;

    for (const c of weightedCitations) {
      const m = tierMultiplier[c.weight];
      weightedSum += c.confidence * m;
      totalWeight += m;
    }

    return totalWeight > 0 ? Math.min(1, weightedSum / totalWeight) : 0;
  }

  /**
   * Detect the domain/intent of a query for specialized reasoning modes.
   */
  private detectDomain(query: string): KnowledgeContext['detectedDomain'] {
    const q = query.toLowerCase();

    // Legal domain detection
    const legalPatterns = /\b(legal|law|court|tribunal|employment\s*rights?|unfair(?:ly)?\s*dismiss(?:al|ed)?|dismiss(?:al|ed)|statutory|legislation|claimant|respondent|hearing|solicitor|barrister|contract\s*law|discrimination|grievance|acas|settlement|judicial|clause|regulation|statute|jurisdiction|liability|damages|breach|remedy|injunction|redundan(?:cy|t)|notice\s*period|wrongful\s*(?:termination|dismissal)|constructive\s*dismissal|employment\s*(?:contract|law|tribunal)|worker'?s?\s*rights?|my\s+rights?\s+(?:if|when|after)|gross\s*misconduct|misconduct|disciplinary|suspension|employer\s+(?:dismissed|fired|sacked|terminated)|(?:fired|sacked)\s+(?:from|by)|unfair\s*treatment|harassment|whistleblow(?:ing|er)|maternity|paternity|redundancy\s*(?:pay|package)|sick\s*(?:pay|leave)|ssp|statutory\s*sick\s*pay|minimum\s*wage|zero.?hours?\s*contract|ET[13]\b|claim\s*form|protected\s*conversations?|without\s*prejudice|equality\s*act|early\s*conciliation|time\s*limit|prescribed\s*form|strike\s*out|struck\s*out|costs?\s*order|protected\s*characteristics?|protective\s*award|my\s+case|strongest\s+argument|weakness(?:es)?(?:\s+in\s+my|\s+of\s+my)?|my\s+claim|my\s+employer|my\s+evidence|dyslexia|disability\s+discrimination|flexible\s*working)\b/;
    if (legalPatterns.test(q)) return 'legal';

    // Medical domain detection — P7-1: expanded for medical fact integrity
    const medicalPatterns = /\b(medical|health|diagnosis|diagnoses|diagnosed|treatment|symptom|symptoms|doctor|hospital|prescription|therapy|surgery|condition|illness|disease|patient|clinical|pharmaceutical|dosage|medication|medications|medicine|medicines|referred|referral|scan|MRI|CT|X-ray|xray|ultrasound|blood\s*(?:test|result|pressure)|HbA1c|cholesterol|BMI|GP|consultant|specialist|clinic|appointment|test\s*result|lab\s*result|discharge|radiology|pathology|biopsy|ECG|EEG|endoscopy|chest\s*pain|headache|dizz(?:y|iness)|breathless|nausea|vomit|fatigue|fever|rash|swollen|numbness|palpitation|cough(?:ing)?|diarrh|constipat|seizure|faint)\b/;
    if (medicalPatterns.test(q)) return 'medical';

    // Financial domain detection
    const financialPatterns = /\b(tax|investment|pension|salary|mortgage|insurance|financial|budget|accounting|dividend|interest\s*rate|capital\s*gains|inheritance|deductible)\b/;
    if (financialPatterns.test(q)) return 'financial';

    // Technical domain detection
    const technicalPatterns = /\b(code|programming|api|database|server|deploy|docker|kubernetes|git|typescript|python|react|algorithm|architecture|debug|compile|runtime|npm|package)\b/;
    if (technicalPatterns.test(q)) return 'technical';

    return 'general';
  }

  /**
   * P6-19.9: Classify query intent — fact extraction vs strategy analysis.
   * Fact extraction queries ask for specific data points from documents.
   * Strategy queries ask for analysis, advice, arguments, or case assessment.
   * Fact extraction ALWAYS takes priority.
   */
  classifyQueryIntent(query: string): KnowledgeContext['queryIntent'] {
    const q = query.toLowerCase();

    // ── P8-2.2b: Email analysis / opinion queries should NOT be fact extraction ──
    // "What are your thoughts on the emails" asks for analysis, not data extraction.
    // Check for analysis/opinion phrasing BEFORE fact patterns to prevent misclassification.
    const analysisOverridePatterns = [
      /\bwhat\s+are\s+your\s+(thoughts|views|opinions?|impressions?|takes?)\b/,
      /\byour\s+(thoughts|views|opinions?|analysis|take)\s+(on|about|regarding)\b/,
      /\bwhat\s+do\s+you\s+(think|make\s+of|reckon)\b/,
      /\bhow\s+(?:can|should|would)\s+I\s+use\b/,
    ];
    const isAnalysisQuery = analysisOverridePatterns.some(p => p.test(q));

    // ── Fact extraction signals (HIGH PRIORITY — checked first) ──
    const factPatterns = [
      /\bwhat\s+is\s+(the\s+)?\w/,                   // "What is the percentage..." or "What is SSP..."
      /\bwhat\s+are\s+(the\s+)?(key\s+)?(?!your\b)\w/,  // "What are the key dates..." — but NOT "What are your thoughts"
      /\bhow\s+much\b/,                              // "How much is SSP..."
      /\bhow\s+many\b/,                              // "How many days..."
      /\bhow\s+long\b/,                              // "How long is the notice period..."
      /\bfrom\s+what\s+(day|date|point)\b/,           // "From what day is SSP paid..."
      /\bwhat\s+(percentage|rate|amount|figure|number|limit|maximum|minimum)\b/, // data terms
      /\b(percentage|rate|amount|figure|limit|maximum|minimum|award|pay)\s*(is|for|of)\b/, // "percentage is/for..."
      /\b\d+\s*(%|percent|days?|weeks?|months?|years?|£|pounds?)\b/, // numbers with units
      /\b%\b/,                                        // P6-19.12: bare % sign in query
      /\busing\s+only\s+(the\s+)?documents?\b/i,     // explicit extraction request
      /\bextract\b/,                                  // "extract the values..."
      /\blist\s+(the|all)\s+\w/,                      // "list the key dates..."
      /\bwhat\s+does\s+(it|the|my)\s+\w+\s+say\b/,   // "what does it say about..."
      /^\s*\d+\.\s/m,                                // numbered questions (multi-part)
      /\bwhen\s+does\b/,                              // P6-19.12: "when does it start..."
      /\bwhen\s+is\b/,                                // P6-19.12: "when is the deadline..."
      /\bsummar(y|ise|ize)\b/,                        // P6-19.12: "summarise the facts..."
    ];

    // P8-2.2b: Analysis/opinion queries bypass fact extraction even if fact patterns match
    const isFact = !isAnalysisQuery && factPatterns.some(p => p.test(q));
    if (isFact) return 'fact_extraction';

    // ── Strategy signals ──
    const strategyPatterns = [
      /\bwhat\s+should\s+I\b/,                       // "What should I do..."
      /\bshould\s+I\s+(file|claim|pursue|appeal)\b/, // "Should I claim..."
      /\bstrongest\s+(argument|claim|case|point)\b/, // "strongest argument..."
      /\bweakness(es)?\s+(in|of)\b/,                 // "weaknesses in my case..."
      /\bchances?\s+of\s+(success|winning)\b/,       // "chances of success..."
      /\bstrategy\b/,                                 // "strategy..."
      /\badvice\b/,                                   // "advice..."
      /\banalyse\s+my\s+(case|claim|situation)\b/,   // "analyse my case..."
      /\bhow\s+strong\s+is\b/,                       // "how strong is my claim..."
      /\blikelihood\b/,                               // "likelihood of..."
      /\bwhat\s+are\s+my\s+(options|rights|chances)\b/, // "what are my options..."
      /\bpros?\s+(and|&)\s+cons?\b/,                 // "pros and cons..."
    ];

    const isStrategy = strategyPatterns.some(p => p.test(q));
    if (isStrategy) return 'strategy';

    return 'general';
  }

  /**
   * Determine if external verification is recommended based on query domain.
   */
  private needsExternalVerification(query: string, domain: KnowledgeContext['detectedDomain']): boolean {
    // Legal, medical, and financial always need verification
    if (domain === 'legal' || domain === 'medical' || domain === 'financial') return true;

    // Questions about current events, policies, or real-world facts
    const currentInfoPatterns = /\b(current|latest|recent|today|now|2024|2025|2026|policy|regulation|rate|price|deadline|updated)\b/i;
    if (currentInfoPatterns.test(query)) return true;

    return false;
  }

  /**
   * Retrieve knowledge relevant to the user's query and produce
   * a compact context block for injection into the chat prompt.
   */
  augment(query: string): KnowledgeContext {
    if (!this.config.enabled) {
      log.warn('Knowledge augmentation is DISABLED — memory will not be used');
      return this.empty();
    }

    const parts: string[] = [];
    let memoryItemCount = 0;
    let docChunkCount = 0;
    let totalChars = 0;
    const budget = this.config.maxContextChars;
    // Reserve at least 60% of the budget for document chunks so memory items
    // can't starve uploaded documents.  Memory gets at most 40%.
    const memoryBudget = Math.floor(budget * 0.4);
    const docBudget = budget; // docs can use the full remaining budget

    // Phase 1 & 3 & 4: Strict Evidence Mode tracking
    const rawChunks: DocumentEvidenceMode['rawChunks'] = [];
    const structuredEvidence: StructuredDocumentEvidence[] = [];
    const documentReferenceMap: Record<string, string> = {}; // P6-19.7: DOC-N → human-readable
    const warnings: string[] = [];
    const citations: KnowledgeContext['citations'] = [];
    const contradictions: string[] = [];
    const detectedDomain = this.detectDomain(query);
    const queryIntent = this.classifyQueryIntent(query);
    const externalVerificationNeeded = this.needsExternalVerification(query, detectedDomain);
    const isEmailFocused = isEmailFocusedQuery(query);

    // ── Source availability checks ─────────────────────────────────
    if (!this.memorySource) {
      warnings.push('memorySource not wired — lifelong memory unavailable');
      log.warn('KnowledgeAugmenter: memorySource is NULL — no lifelong memory will be queried');
    }
    if (!this.cognitiveSource) {
      warnings.push('cognitiveSource not wired — document retrieval unavailable');
      log.warn('KnowledgeAugmenter: cognitiveSource is NULL — no document retrieval available');
    }

    // ── Lifelong memory retrieval ───────────────────────────────────
    // Two-pass search: first general search, then a focused user_teaching
    // search to ensure personal facts surface even when buried by noise.
    if (this.memorySource) {
      try {
        const generalResults = this.memorySource.search(query, { limit: this.config.memoryTopK });
        const teachingResults = this.memorySource.search(query, {
          limit: this.config.memoryTopK * 3,
          category: 'user_teaching' as any,
        });
        log.debug({
          query: query.slice(0, 50),
          generalCount: generalResults.length,
          teachingCount: teachingResults.length,
        }, 'Memory search results');

        // ── Relevance gate ─────────────────────────────────────────
        // A result is only injected if:
        //   1. finalScore >= memoryInjectionFloor (0.35)  AND
        //   2. At least one MEANINGFUL (non-stop-word) query term appears
        //      in the memory content.
        // This prevents high-scoring but topically-irrelevant memories
        // (boosted by category/recency/strength) from contaminating
        // generic queries like "What is 2+2?" or "Capital of France?".
        const floor = this.config.memoryInjectionFloor;

        // Import stop words to filter matched terms
        const GATE_STOP_WORDS = new Set([
          'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it',
          'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
          'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her',
          'she', 'or', 'an', 'will', 'its', 'so', 'up', 'out', 'if',
          'about', 'who', 'get', 'which', 'go', 'me', 'when', 'can', 'no',
          'just', 'him', 'how', 'has', 'more', 'now', 'did', 'been',
          'am', 'are', 'was', 'were', 'where', 'what', 'is',
        ]);

        // P8-2.2e: For email-focused queries with document evidence, suppress
        // user_teaching memories that contain prior assistant responses.
        // These "Correction:" memories store previous (potentially hallucinated)
        // answers and create a self-reinforcing loop where the model
        // pattern-matches against its own prior hallucination instead of
        // reading the actual email evidence provided in [DOC-N] chunks.
        const isPoisonousTeaching = (r: typeof generalResults[0]): boolean => {
          if (!isEmailFocused) return false;
          if (r.memory.category !== 'user_teaching') return false;
          const content = r.memory.content;
          // Suppress memories that are stored prior responses (contain "Correction:" + "assistant" pattern)
          if (/^Correction:/i.test(content) && /assistant\s+\d{1,2}:\d{2}/i.test(content)) return true;
          // Suppress memories that echo the query pattern with a prior answer embedded
          if (/\*\*Context\*\*|I don't have access|no specific documents/i.test(content)) return true;
          return false;
        };

        const isRelevant = (r: typeof generalResults[0]): boolean => {
          if (r.finalScore < floor) return false;
          // Require at least one meaningful matched term (not a stop word)
          const meaningfulTerms = r.matchedTerms.filter(t => !GATE_STOP_WORDS.has(t));
          if (meaningfulTerms.length === 0) return false;
          // P8-2.2e: Reject poisonous teaching memories for evidence-backed queries
          if (isPoisonousTeaching(r)) {
            log.info({
              memoryId: r.memory.id,
              category: r.memory.category,
              score: r.finalScore.toFixed(3),
              contentPreview: r.memory.content.slice(0, 80),
            }, 'P8-2.2e: Suppressed poisonous user_teaching memory — prior hallucinated response');
            return false;
          }
          return true;
        };

        const seen = new Set<string>();
        const merged: typeof generalResults = [];

        // Prioritise concise teaching results (< 200 chars)
        for (const r of teachingResults) {
          if (isRelevant(r) && !seen.has(r.memory.id) && r.memory.content.length < 200) {
            seen.add(r.memory.id);
            merged.push(r);
          }
        }
        for (const r of generalResults) {
          if (isRelevant(r) && !seen.has(r.memory.id)) {
            seen.add(r.memory.id);
            merged.push(r);
          }
        }

        if (merged.length === 0 && (generalResults.length > 0 || teachingResults.length > 0)) {
          const bestScore = Math.max(
            ...generalResults.map(r => r.finalScore),
            ...teachingResults.map(r => r.finalScore),
            0,
          );
          const bestTerms = Math.max(
            ...generalResults.map(r => r.matchedTerms.length),
            ...teachingResults.map(r => r.matchedTerms.length),
            0,
          );
          log.info({
            query: query.slice(0, 50),
            bestScore: bestScore.toFixed(3),
            bestMatchedTerms: bestTerms,
            floor: floor.toFixed(2),
            candidateCount: generalResults.length + teachingResults.length,
          }, 'Memory results GATED — no result passes relevance gate');
        }

        if (merged.length > 0) {
          const memLines: string[] = [];
          for (const r of merged) {
            const citationRef = `[MEM-${memoryItemCount + 1}]`;
            const line = this.config.showProvenance
              ? `- ${citationRef} [${r.memory.category}] ${r.memory.content}`
              : `- ${citationRef} ${r.memory.content}`;

            if (totalChars + line.length > memoryBudget) break;
            memLines.push(line);
            totalChars += line.length;
            memoryItemCount++;

            citations.push({
              sourceType: 'memory',
              sourceId: r.memory.id,
              label: `${citationRef} ${r.memory.category}: ${r.memory.content.slice(0, 60)}...`,
              category: r.memory.category,
              score: r.finalScore,
            });
          }

          if (memLines.length > 0) {
            parts.push('[Relevant Memory]\n' + memLines.join('\n'));
          }
        }
      } catch (err) {
        log.warn({ error: (err as Error)?.message ?? err }, 'Memory retrieval failed');
      }
    }

    log.info({
      memoryItemCount,
      memoryCharsUsed: totalChars,
      memoryBudget,
      remainingForDocs: budget - totalChars,
    }, 'KnowledgeAugmenter: memory phase complete, starting document retrieval');

    // ── Cognitive document retrieval ─────────────────────────────────
    let retrievalFailed = false;
    let retrievalFailureReason = '';

    if (this.cognitiveSource) {
      try {
        // P6-19.10: Multi-part query decomposition — split numbered questions
        // into sub-queries for better coverage across different documents
        let subQueries = this._decomposeQuery(query);

        // P6-19.12: Query expansion — expand common abbreviations to full terms
        // FTS5 can't match "SSP" to "Statutory Sick Pay" so we add the expansion
        const abbreviationMap: Record<string, string> = {
          'ssp': 'statutory sick pay',
          'tupe': 'transfer of undertakings',
          'acas': 'advisory conciliation and arbitration service',
          'et1': 'employment tribunal claim form',
          'fwa': 'fair work agency',
          'lea': 'lower earnings limit',
          'nda': 'non-disclosure agreement',
        };
        const expandedQueries: string[] = [];
        for (const sq of subQueries) {
          expandedQueries.push(sq);
          const sqLower = sq.toLowerCase();
          for (const [abbr, expanded] of Object.entries(abbreviationMap)) {
            if (new RegExp(`\\b${abbr}\\b`, 'i').test(sqLower)) {
              const expandedQuery = sq.replace(new RegExp(`\\b${abbr}\\b`, 'gi'), expanded);
              expandedQueries.push(expandedQuery);
              log.info({ original: sq.slice(0, 50), expanded: expandedQuery.slice(0, 50) }, 'P6-19.12: Query expansion — abbreviation expanded');
            }
          }
        }
        subQueries = expandedQueries;

        // P8-2.3: Email-focused queries use date-based email retrieval
        // FTS text matching fails for email queries because the user's query
        // ("emails I received today") doesn't appear in the email body text.
        // Instead, retrieve emails by date (most recent first).
        let result: ReturnType<typeof this._retrieveWithCoverage>;
        if (isEmailFocused && this.cognitiveSource?.retrieveRecentEmails) {
          // Primary: get recent emails by date
          const emailResult = this.cognitiveSource.retrieveRecentEmails(this.config.docsTopK);
          log.info({ emailChunks: emailResult.chunks.length, route: emailResult.route }, 'P8-2.3: Date-based email retrieval');
          result = emailResult;

          // Also do FTS search on email-only to catch keyword-specific matches
          const ftsResult = this._retrieveWithCoverage(subQueries, 'email');
          if (ftsResult.chunks.length > 0) {
            const seenIds = new Set(result.chunks.map(c => c.chunk_id));
            for (const chunk of ftsResult.chunks) {
              if (!seenIds.has(chunk.chunk_id)) {
                seenIds.add(chunk.chunk_id);
                result.chunks.push(chunk);
              }
            }
            for (const doc of ftsResult.documents) {
              if (!result.documents.some(d => d.document_id === doc.document_id)) {
                result.documents.push(doc);
              }
            }
            log.info({ ftsAdded: ftsResult.chunks.length }, 'P8-2.3: FTS email results merged');
          }
        } else if (isEmailFocused) {
          // Fallback if retrieveRecentEmails not available — use FTS email-only
          result = this._retrieveWithCoverage(subQueries, 'email');
          log.info({ emailOnlyChunks: result.chunks.length }, 'P8-2.3: FTS email-only retrieval (no date method)');
        } else {
          result = this._retrieveWithCoverage(subQueries);
        }

        log.info({
          chunksReturned: result.chunks.length,
          countLabel: result.count_label,
          count: result.count,
          route: result.route,
          firstChunkScore: result.chunks[0]?.score,
          documentsCount: result.documents.length,
        }, 'KnowledgeAugmenter: cognitiveSource.retrieve() result');

        // P6-19.5: Detect structured retrieval failure (not just empty results)
        if (result.route === 'retrieval-failed' || result.route === 'all-failed') {
          retrievalFailed = true;
          retrievalFailureReason = result.count_label?.replace('RETRIEVAL_FAILED: ', '') ?? 'retrieval pipeline failed';
          log.error({ route: result.route, reason: retrievalFailureReason }, 'KnowledgeAugmenter: retrieval FAILED — flagging for agent');
          warnings.push(`retrieval failed: ${retrievalFailureReason}`);
        }

        // For COUNT-only queries (no chunks), inject the count label directly
        if (result.count_label && result.count !== null && result.chunks.length === 0) {
          const countLine = `- ${result.count_label}`;
          if (totalChars + countLine.length <= budget) {
            parts.push('[Document Evidence]\n' + countLine);
            totalChars += countLine.length;
            docChunkCount++;
          }
        }

        // For chunk results, inject top-K excerpts (gate by score + relevance + case dominance)
        if (result.chunks.length > 0) {
          const docLines: string[] = [];
          // P6-19.8: Extract query keywords for relevance filtering
          const queryKeywords = query.toLowerCase()
            .replace(/[^\w\s]/g, '')
            .split(/\s+/)
            .filter(w => w.length > 2 && !['the', 'and', 'for', 'are', 'was', 'were', 'has', 'have', 'been', 'what', 'how', 'does', 'with', 'this', 'that', 'from', 'your', 'can', 'will', 'which', 'about', 'into', 'most', 'than'].includes(w));

          // P6-21: Get recent upload document IDs for recency boosting
          const recentDocIds = getRecentUploadStore().getRecentDocumentIds();

          // P6-19.9: Case-specific signal patterns for dominance boosting
          const caseSignals = /\b(grievance|complaint|dismissal|dismissed|terminated|disciplinary|suspension|suspended|meeting|hearing|manager|supervisor|employer|employee|claimant|respondent|dyslexia|dyslexic|diagnosis|assessment|report|medical|occupational\s*health|reasonable\s*adjustments?|notice\s*period|contract|induction|training|probation|sickness|sick\s*leave|absence|warning|capability|performance|redundancy|TUPE|settlement|ET1|acas|conciliation)\b/i;
          const irrelevantSourcePatterns = /\b(parliamentary|hansard|house\s+of\s+(commons|lords)|debate|committee\s+report|research\s+briefing|ethnic\s+diversity|public\s+life|productivity|political)\b/i;

          // P8-4: Temporal ranker — detect the query's temporal intent once
          //        so we can apply a consistent recency/window boost per chunk.
          const temporalRanker = new TemporalRanker();
          const temporalHint: TemporalHint = temporalRanker.detect(query);

          // P8-4.2: Sender-name candidates — extract proper-noun tokens from
          //         queries like "email from Rob" so we can boost chunks where
          //         that name actually appears as the sender.
          //         Excludes obvious sentence-start stop words.
          const SENDER_QUERY_STOP = new Set([
            'the', 'this', 'that', 'these', 'those', 'it', 'he', 'she', 'they',
            'we', 'you', 'i', 'a', 'an', 'and', 'but', 'or', 'if', 'so', 'what',
            'when', 'where', 'why', 'how', 'which', 'who', 'whose', 'latest',
            'recent', 'oldest', 'first', 'last', 'newest', 'today', 'yesterday',
            'tomorrow', 'email', 'emails', 'message', 'messages', 'from', 'about',
            'regarding', 're', 'fw', 'fwd',
          ]);
          const senderCandidates: string[] = [];
          {
            const matches = query.match(/\b[A-Z][a-zA-Z-]{1,}\b/g) ?? [];
            for (const m of matches) {
              const lower = m.toLowerCase();
              if (SENDER_QUERY_STOP.has(lower)) continue;
              if (lower.length < 3) continue;
              senderCandidates.push(lower);
            }
          }

          // P8-4.2: If query mentions a person, merge sender-match chunks into
          //         the retrieval pool. Base FTS can miss these because "rob"
          //         in chunk text scores lower than "Rob's emails" in a subject
          //         line — explicit sender lookup ensures real matches surface.
          if (senderCandidates.length > 0 && (this.cognitiveSource as any)?.retrieveBySender) {
            const senderResult = (this.cognitiveSource as any).retrieveBySender(senderCandidates, 6);
            if (senderResult?.chunks?.length > 0) {
              const seenIds = new Set(result.chunks.map(c => c.chunk_id));
              let added = 0;
              for (const chunk of senderResult.chunks) {
                if (!seenIds.has(chunk.chunk_id)) {
                  seenIds.add(chunk.chunk_id);
                  result.chunks.push(chunk);
                  added++;
                }
              }
              for (const doc of senderResult.documents ?? []) {
                if (!result.documents.some(d => d.document_id === doc.document_id)) {
                  result.documents.push(doc);
                }
              }
              log.info({
                senderCandidates,
                senderMatchChunks: senderResult.chunks.length,
                added,
              }, 'P8-4.2: Sender-match retrieval merged');
            }
          }

          // P6-19.9: Score-boost and filter chunks for case dominance
          const scoredChunks = result.chunks
            .filter(c => c.score === undefined || c.score >= 0.15)
            .map(c => {
              const chunkLower = c.chunk_text.toLowerCase();
              const fileNameLower = (c.file_name ?? '').toLowerCase();
              let boostedScore = c.score ?? 0.3;

              // CASE PRIORITY BOOST: chunks with case-specific signals get boosted
              const caseMatches = chunkLower.match(caseSignals);
              if (caseMatches) {
                boostedScore += 0.4;
              }

              // UPLOADED DOCUMENT BOOST: user's own docs are primary evidence
              // (all chunks from cognitiveSource are uploaded — but case-specific filenames get extra)
              const caseFileSignals = /\b(complaint|grievance|statement|evidence|chronolog|letter|email|contract|assessment|report|induction|training)\b/i;
              if (caseFileSignals.test(fileNameLower)) {
                boostedScore *= 1.5;
              }

              // P6-19.10: FACTSHEET BOOST — specific factsheets rank higher than
              // overview/briefing documents. A "statutory-sick-pay-factsheet" should
              // outrank "Employment Rights Bill" or "Research Briefing" for SSP queries
              if (/factsheet/i.test(fileNameLower)) {
                boostedScore *= 1.8;
              }

              // P6-19.13: TOPIC-SPECIFIC FILENAME BOOST — when query explicitly mentions
              // a topic, documents with matching filenames get priority.
              // e.g. "protective award" / "collective consultation" → "collective-redundancy" docs
              const topicFileBoosts: Array<{ queryPattern: RegExp; filePattern: RegExp; multiplier: number }> = [
                { queryPattern: /\b(protective\s*award|collective\s*(consultation|redundancy))\b/i, filePattern: /collective.?redundancy/i, multiplier: 1.5 },
                { queryPattern: /\b(statutory\s*sick\s*pay|ssp)\b/i, filePattern: /sick.?pay|ssp/i, multiplier: 1.5 },
                { queryPattern: /\b(unfair\s*dismissal)\b/i, filePattern: /dismissal/i, multiplier: 1.5 },
                { queryPattern: /\b(notice\s*period|notice\s*pay)\b/i, filePattern: /notice/i, multiplier: 1.5 },
              ];
              for (const { queryPattern, filePattern, multiplier } of topicFileBoosts) {
                if (queryPattern.test(query) && filePattern.test(fileNameLower)) {
                  boostedScore *= multiplier;
                }
              }

              // IRRELEVANT SOURCE PENALTY: parliamentary/textbook sources get penalised
              const isIrrelevant = irrelevantSourcePatterns.test(chunkLower) || irrelevantSourcePatterns.test(fileNameLower);
              if (isIrrelevant) {
                boostedScore *= 0.3; // Heavy penalty
              }

              // Keyword relevance check — boost chunks that contain query terms
              let keywordOverlap = 0;
              if (queryKeywords.length > 0) {
                keywordOverlap = queryKeywords.filter(kw => chunkLower.includes(kw)).length;
                // P6-19.11: Keyword overlap boost — chunks with more query keywords rank higher
                if (keywordOverlap > 0) {
                  const overlapRatio = keywordOverlap / queryKeywords.length;
                  boostedScore += overlapRatio * 0.4; // up to +0.4 for full keyword coverage
                }
              }

              // P6-19.11: ANSWER VALUE BOOST — chunks containing numbers, percentages, dates
              // are more likely to contain extractable answers for fact queries
              if (queryIntent === 'fact_extraction') {
                const hasNumericData = /\b\d+(\.\d+)?(%|£|days?|weeks?|months?|years?|hours?)\b/i.test(c.chunk_text);
                if (hasNumericData && keywordOverlap > 0) {
                  boostedScore += 0.3; // Chunks with both query terms AND numeric data
                }
              }

              // P6-21: RECENCY BOOST — recently uploaded documents get priority
              if (recentDocIds.has(c.document_id)) {
                boostedScore += 0.5;
              }

              // P8-2.2: EMAIL ORIGIN BOOST — when query is email-focused,
              // boost chunks from email-origin documents and email-named files
              if (isEmailFocused) {
                const originType = (c as any).origin_type ?? '';
                const senderField = (c as any).sender ?? '';
                if (originType === 'email' || senderField) {
                  boostedScore += 0.6; // Strong boost for confirmed email-origin
                } else if (/\bemail[:\-_\s]/i.test(fileNameLower) || /^email/i.test(fileNameLower)) {
                  boostedScore += 0.4; // Moderate boost for email-named files
                }

                // P8-2.3 (superseded by P8-4 below): legacy ad-hoc date regexes
                // left here intentionally minimal — TemporalRanker applies the real
                // recency/window logic for every chunk regardless of email focus.
              }

              // P8-4: TEMPORAL BOOST — apply recency/window scoring consistently
              // across all retrieval, not just email queries. The ranker is a no-op
              // when the query has no temporal signal and the doc is old.
              const docDateStrForTemporal = (c as any).document_date ?? (c as any).created_at ?? null;
              const temporalBoost = temporalRanker.boostFromString(docDateStrForTemporal, temporalHint);
              boostedScore += temporalBoost.delta;

              // P8-4.2: SENDER-NAME BOOST — when the query mentions a person
              // (e.g. "email from Rob"), chunks where that name is the sender
              // should outrank chunks that merely mention the name in a subject
              // or body. Three signals checked (in priority order):
              //   (a) the chunk's `original_sender` matches (P8-4.3: primary
              //       originator of a forwarded thread — most important)
              //   (b) the chunk's outer `sender` column matches
              //   (c) the chunk text opens with a "From: <name>" line
              if (senderCandidates.length > 0) {
                const senderField = String((c as any).sender ?? '').toLowerCase();
                const originalSenderField = String((c as any).original_sender ?? '').toLowerCase();
                const chunkHead = c.chunk_text.slice(0, 250);
                const fromLineMatch = chunkHead.match(/^\s*From:\s*([^\r\n]+)/im);
                const fromLine = fromLineMatch ? fromLineMatch[1].toLowerCase() : '';

                for (const cand of senderCandidates) {
                  if (originalSenderField.includes(cand)) {
                    boostedScore += 0.9;   // strongest — primary originator
                    break;
                  }
                  if (senderField.includes(cand)) {
                    boostedScore += 0.8;
                    break;
                  }
                  if (fromLine && fromLine.includes(cand)) {
                    boostedScore += 0.5;
                    break;
                  }
                }
              }

              // P8-2.2f: EMAIL HEADER BOOST — chunks with real email headers
              // (From:/Sent:/Subject:) are real email content and should outrank
              // OCR'd attachment text (garbled ACAS scans, etc.)
              if (isEmailFocused) {
                const hasEmailHeaders = /\b(From|Sent|Subject):\s/i.test(c.chunk_text.slice(0, 500));
                if (hasEmailHeaders) {
                  boostedScore += 0.3; // Real email body with headers
                }
              }

              return { ...c, _boostedScore: boostedScore, _keywordOverlap: keywordOverlap, _isIrrelevant: isIrrelevant };
            });

          // P8-2.2: Log email boost stats
          if (isEmailFocused) {
            const emailBoosted = scoredChunks.filter(c => {
              const ot = (c as any).origin_type ?? '';
              const sn = (c as any).sender ?? '';
              const fn = (c.file_name ?? '').toLowerCase();
              return ot === 'email' || !!sn || /\bemail[:\-_\s]/i.test(fn) || /^email/i.test(fn);
            }).length;
            log.info({ emailBoosted, totalChunks: scoredChunks.length }, 'P8-2.2: Email origin boost applied');
          }

          // P8-4: Log temporal ranker activity (observability in Logs tab)
          if (temporalHint.kind !== 'none') {
            log.info({
              hintKind: temporalHint.kind,
              trigger: temporalHint.trigger,
              windowStart: temporalHint.windowStart?.toISOString(),
              windowEnd: temporalHint.windowEnd?.toISOString(),
              totalChunks: scoredChunks.length,
            }, 'P8-4: Temporal ranker applied');
          }

          // P6-19.9: Separate case-specific and irrelevant chunks
          const caseChunks = scoredChunks.filter(c => !c._isIrrelevant);
          const hasCaseChunks = caseChunks.length > 0;

          // P6-19.9: If case-specific chunks exist, DROP irrelevant ones entirely
          // Only fall back to irrelevant chunks if NO case docs exist
          const filteredChunks = (hasCaseChunks ? caseChunks : scoredChunks)
            .filter(c => {
              // Case-boosted chunks (score boosted by case signals) are ALWAYS kept
              if (c._boostedScore >= 0.7) return true;
              // Must have keyword overlap OR reasonable boosted score
              if (c._keywordOverlap > 0) return true;
              if (c._boostedScore > 0.4) return true;
              return false;
            })
            // Sort by boosted score descending — case documents first
            .sort((a, b) => b._boostedScore - a._boostedScore)
            // P6-19.11: Fact extraction gets more chunks to ensure complete coverage
            .slice(0, queryIntent === 'fact_extraction' ? this.config.docsTopK * 2 : this.config.docsTopK);

          if (hasCaseChunks) {
            log.info({ caseChunks: caseChunks.length, dropped: scoredChunks.length - caseChunks.length }, 'P6-19.9: Case dominance — irrelevant chunks dropped');
          }

          // P6-19.11: Factsheet completeness — ensure ALL chunks from selected
          // factsheet documents are included. A factsheet is a short, focused document;
          // missing even one chunk can cause answer extraction failures.
          const selectedDocIds = new Set(filteredChunks.map(c => c.document_id));
          const factsheetDocIds = new Set(
            filteredChunks
              .filter(c => /factsheet/i.test(c.file_name ?? ''))
              .map(c => c.document_id)
          );
          if (factsheetDocIds.size > 0 && queryIntent === 'fact_extraction') {
            // Add missing chunks from factsheet documents that were in scoredChunks
            const missingFactsheetChunks = scoredChunks.filter(c =>
              factsheetDocIds.has(c.document_id) &&
              !filteredChunks.some(f => f.chunk_id === c.chunk_id)
            );
            if (missingFactsheetChunks.length > 0) {
              filteredChunks.push(...missingFactsheetChunks);
              filteredChunks.sort((a, b) => b._boostedScore - a._boostedScore);
              log.info({
                added: missingFactsheetChunks.length,
                factsheets: [...factsheetDocIds].length,
              }, 'P6-19.11: Factsheet completeness — added missing sibling chunks');
            }
          }

          const chunks = filteredChunks;

          // Per-chunk character limit: scale based on domain and query intent.
          // Legal/medical/financial documents need more context to preserve meaning.
          // P6-19.11: Fact extraction queries need full chunk text — critical values
          // (percentages, dates, amounts) are often beyond the 600-char mark.
          // P8-2.3: Email chunks get generous limit — the full body is the evidence
          const isHighDetailDomain = detectedDomain === 'legal' || detectedDomain === 'medical' || detectedDomain === 'financial';
          const chunkCharLimit = isEmailFocused ? 1500
            : queryIntent === 'fact_extraction' ? 1200
            : isHighDetailDomain ? 800 : 600;

          for (const chunk of chunks) {
            const chunkOrigin = (chunk as any).origin_type ?? '';
            const isEmailChunk = isEmailFocused && (chunkOrigin === 'email' || /^Email:/i.test(chunk.file_name ?? '') || /^email-/i.test(chunk.file_name ?? ''));

            // P8-2.3: For email chunks, PRESERVE newlines so LLM can see
            // From:/Sent:/To:/Subject: headers clearly. For other chunks,
            // collapse newlines to save space.
            const rawText = chunk.chunk_text.slice(0, chunkCharLimit);
            const text = isEmailChunk
              ? rawText.replace(/\n{3,}/g, '\n\n').trim()  // preserve structure, just collapse excessive blanks
              : rawText.replace(/\n+/g, ' ').trim();
            const citationRef = `[DOC-${docChunkCount + 1}]`;

            // P6-19.7: Build human-readable document label
            const fileName = chunk.file_name ?? null;
            const pageNum = chunk.page_number ?? null;
            let readableLabel = citationRef;
            if (isEmailChunk) {
              // P8-2.3: For email chunks, just use a simple EMAIL marker.
              // The actual sender/date/subject is in the chunk text itself.
              readableLabel = '[EMAIL]';
            } else if (fileName) {
              // Clean up filename: remove extension, truncate
              const cleanName = fileName.replace(/\.[^.]+$/, '').slice(0, 60);
              readableLabel = pageNum
                ? `[${cleanName}, page ${pageNum}]`
                : `[${cleanName}]`;
            } else if (pageNum) {
              readableLabel = `[Document ${chunk.document_id.slice(0, 8)}, page ${pageNum}]`;
            } else {
              // P6-19.9: Fallback — derive label from first meaningful words of chunk text
              const firstWords = text.replace(/[^\w\s]/g, '').trim().split(/\s+/).slice(0, 5).join(' ');
              if (firstWords.length > 5) {
                readableLabel = `[${firstWords.slice(0, 40)}...]`;
              } else {
                readableLabel = `[Document ${chunk.document_id.slice(0, 8)}]`;
              }
            }
            documentReferenceMap[citationRef] = readableLabel;

            // P8-2.3: For email chunks, prefix with structured metadata.
            // P8-4.3: When the email is FORWARDED, tell the LLM explicitly
            // who the ORIGINAL sender was — BOTH as a metadata tag after
            // [DOC-N] AND as a prominent in-body line. The in-body notice
            // is critical: the chunk text itself starts with "From: <forwarder>"
            // (the outer header), which the LLM reads as authoritative.
            // Prepending a PRIMARY SENDER notice disambiguates.
            let line: string;
            if (isEmailFocused && chunkOrigin === 'email') {
              const outerSender = (chunk as any).sender ?? null;
              const originalSender = (chunk as any).original_sender ?? null;
              const originalDate = (chunk as any).original_date ?? null;
              const docDate = (chunk as any).document_date ?? null;

              const metaParts: string[] = [];
              let bodyPrefix = '';
              if (originalSender && outerSender && originalSender !== outerSender) {
                // Forwarded email — make primary attribution explicit and
                // prominent. The LLM must treat original sender as the source.
                metaParts.push(`ORIGINAL SENDER: ${originalSender}`);
                if (originalDate) metaParts.push(`ORIGINAL DATE: ${originalDate}`);
                metaParts.push(`FORWARDED BY: ${outerSender}`);
                if (docDate) metaParts.push(`FORWARD DATE: ${docDate}`);

                bodyPrefix = `*** PRIMARY SENDER: ${originalSender}` +
                  (originalDate ? ` (sent ${originalDate})` : '') +
                  ` *** [this email was originated by ${originalSender}; ` +
                  `${outerSender} forwarded it` +
                  (docDate ? ` on ${docDate}` : '') + `. ` +
                  `Treat this as an email FROM ${originalSender}, not from ${outerSender}.]\n\n`;
              } else if (outerSender) {
                metaParts.push(`SENDER: ${outerSender}`);
                if (docDate) metaParts.push(`DATE: ${docDate}`);
              }
              const metaPrefix = `${citationRef} ${readableLabel}`;
              const metaSuffix = metaParts.length > 0
                ? ` (${metaParts.join(' | ')})`
                : '';
              line = `- ${metaPrefix}${metaSuffix}\n  ${bodyPrefix}${text}`;
            } else {
              line = this.config.showProvenance
                ? `- ${citationRef} [doc:${chunk.document_id.slice(0, 12)}] ${text}`
                : `- ${citationRef} ${text}`;
            }

            if (totalChars + line.length > budget) break;
            docLines.push(line);
            totalChars += line.length;
            docChunkCount++;

            // Phase 4: Track raw chunks for evidence visibility (with metadata)
            rawChunks.push({
              citationRef,
              documentId: chunk.document_id,
              text,
              score: chunk.score,
              fileName,
              pageNumber: pageNum,
            });

            // Phase 3: Run structured extraction on each chunk
            const extracted = this.extractStructuredEvidence(
              citationRef, chunk.document_id, text, chunk.score,
            );
            if (extracted.extractedFacts.length > 0 || extracted.extractedLists.length > 0 || extracted.extractedQuotes.length > 0) {
              structuredEvidence.push(extracted);
            }

            citations.push({
              sourceType: 'document',
              sourceId: chunk.document_id,
              label: `${readableLabel} — ${text.slice(0, 80)}...`,
              score: chunk.score,
            });
          }

          if (docLines.length > 0) {
            // Document priority instruction: uploaded documents are first-class evidence
            const priorityNote = isHighDetailDomain
              ? '[PRIORITY: The following document evidence comes from the user\'s uploaded documents. Cite these as [DOC-N] in your answer. Use them as PRIMARY evidence. Web sources should verify or supplement, not override.]\n'
              : '';
            if (!parts.some(p => p.startsWith('[Document Evidence]'))) {
              parts.push('[Document Evidence]\n' + priorityNote + docLines.join('\n'));
            } else {
              parts[parts.length - 1] += '\n' + docLines.join('\n');
            }

            // Phase 3 (P6-18): Append structured extraction summary for high-detail domains
            if (isHighDetailDomain && structuredEvidence.length > 0) {
              const extractionLines: string[] = ['[Structured Document Extractions]'];
              for (const se of structuredEvidence) {
                if (se.extractedFacts.length > 0) {
                  extractionLines.push(`${se.citationRef} Key facts: ${se.extractedFacts.slice(0, 8).join('; ')}`);
                }
                if (se.extractedLists.length > 0) {
                  extractionLines.push(`${se.citationRef} Listed items: ${se.extractedLists.slice(0, 10).join('; ')}`);
                }
                if (se.extractedQuotes.length > 0) {
                  extractionLines.push(`${se.citationRef} Notable text: ${se.extractedQuotes.slice(0, 4).join('; ')}`);
                }
              }
              if (extractionLines.length > 1) {
                parts.push(extractionLines.join('\n'));
              }
            }

            // Phase 1 (P6-18): Best quotable passages — pre-extracted for the LLM
            if (isHighDetailDomain && rawChunks.length > 0) {
              const bestQuotes = this.extractBestQuotes(rawChunks);
              if (bestQuotes.length > 0) {
                parts.push(
                  '[MANDATORY QUOTES — You MUST use at least one of these direct quotes in your answer]\n' +
                  bestQuotes.slice(0, 5).join('\n'),
                );
              }
            }
          }

            // P6-19.11: FACT MODE DATA EXTRACTION — scan chunks for specific
            // data values (numbers, percentages, dates, amounts) and present
            // them as a pre-extracted answer block. This helps local LLMs that
            // struggle to follow complex prompt instructions.
            if (queryIntent === 'fact_extraction' && rawChunks.length > 0) {
              const dataValues: string[] = [];
              for (const chunk of rawChunks) {
                const text = chunk.text ?? '';
                const fileName = chunk.fileName ?? 'unknown document';
                // Extract sentences containing numeric data
                const sentences = text.split(/[.!]\s+/);
                for (const sentence of sentences) {
                  // Match sentences with percentages, monetary values, dates, or time periods
                  if (/\b\d+(\.\d+)?(%|£|\$|days?|weeks?|months?|years?|hours?)\b/i.test(sentence) ||
                      /\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i.test(sentence) ||
                      /\b(first\s+day|waiting\s+period|lower\s+earnings)\b/i.test(sentence)) {
                    // Check if any query keyword appears in this sentence
                    const sentLower = sentence.toLowerCase();
                    const hasQueryKeyword = queryKeywords.some(kw => sentLower.includes(kw));
                    if (hasQueryKeyword && sentence.length > 15 && sentence.length < 300) {
                      const cleanSentence = sentence.replace(/\n+/g, ' ').trim();
                      dataValues.push(`• ${cleanSentence} — [${fileName.replace(/\.[^.]+$/, '')}]`);
                    }
                  }
                }
              }
              if (dataValues.length > 0) {
                // Deduplicate
                const unique = [...new Set(dataValues)].slice(0, 10);
                parts.push(
                  '[PRE-EXTRACTED DATA VALUES — Use these to answer the question directly]\n' +
                  unique.join('\n')
                );
                log.info({ dataValues: unique.length }, 'P6-19.11: Pre-extracted data values for fact mode');
              }
            }
        }

        // For sender/metadata matches (document-level)
        if (result.documents.length > 0 && docChunkCount === 0) {
          const docLines: string[] = [];
          for (const doc of result.documents.slice(0, this.config.docsTopK)) {
            const line = `- Document "${doc.file_name}"${doc.sender ? ` (from: ${doc.sender})` : ''}`;
            if (totalChars + line.length > budget) break;
            docLines.push(line);
            totalChars += line.length;
            docChunkCount++;
          }
          if (docLines.length > 0) {
            parts.push('[Document Evidence]\n' + docLines.join('\n'));
          }
        }
      } catch (err) {
        const errMsg = (err as Error)?.message ?? String(err);
        log.warn({ error: errMsg }, 'Cognitive document retrieval FAILED — documents will not be available for this query');
        warnings.push('cognitive retrieval error');
        retrievalFailed = true;
        retrievalFailureReason = errMsg;
      }
    }

    const memoryQueried = !!this.memorySource;
    const docsQueried = !!this.cognitiveSource;

    if (parts.length === 0) {
      if (warnings.length > 0) {
        log.warn({ query: query.slice(0, 50), warnings }, 'Knowledge augmentation returned ZERO results with warnings');
      }
      return {
        contextBlock: '',
        memoryItemCount: 0,
        docChunkCount: 0,
        totalChars: 0,
        hasKnowledge: false,
        memoryQueried,
        docsQueried,
        warnings,
        citations: [],
        weightedCitations: [],
        evidenceConfidence: 0,
        contradictions: [],
        detectedDomain,
        queryIntent,
        externalVerificationNeeded,
        documentEvidenceMode: {
          hasRelevantDocs: false,
          docCount: 0,
          mustUseDocs: false,
          mustQuoteDocs: false,
          webSecondaryOnly: false,
          rawChunks: [],
          structuredEvidence: [],
          documentReferenceMap: {},
        },
        retrievalFailed,
        retrievalFailureReason,
        isEmailFocused,
      };
    }

    // ── Build weighted citations from raw citations ──────────────────
    const weightedCitations: WeightedCitation[] = citations.map(c => {
      const content = c.label ?? '';
      const { weight, reason, confidence } = this.classifyEvidenceWeight(
        c.sourceType,
        c.category,
        content,
      );
      return {
        sourceType: c.sourceType,
        sourceId: c.sourceId,
        label: c.label,
        category: c.category,
        score: c.score,
        weight,
        weightReason: reason,
        confidence,
      };
    });
    const evidenceConfidence = this.calculateEvidenceConfidence(weightedCitations);

    // Add domain and verification metadata to context block
    if (detectedDomain !== 'general') {
      parts.push(`[Query Domain: ${detectedDomain.toUpperCase()}]`);
    }
    // P7-2A.5: For medical domain with uploaded documents, suppress external verification
    // recommendation. Documents are the primary authority. The tool gate in agent.ts
    // will also filter out web_search, but this prevents the LLM from being primed
    // to look for external sources when documents already contain the evidence.
    const suppressMedicalExternalVerification = detectedDomain === 'medical' && docChunkCount > 0;
    if (externalVerificationNeeded && !suppressMedicalExternalVerification) {
      parts.push('[VERIFICATION RECOMMENDED: This topic may require external source verification]');
    } else if (suppressMedicalExternalVerification) {
      parts.push('[DOCUMENT-FIRST: Your uploaded medical documents are the primary source of evidence. Answer from these first.]');
    }

    // P8-2.3 / P8-2.2f: Email-focused context injection — tell the LLM to prioritise email evidence
    if (isEmailFocused && docChunkCount > 0) {
      const emailOriginCount = rawChunks.length;
      // P8-2.2f: Inject full date reference table so LLM can resolve
      // "today", "yesterday", "this morning", "this week", "latest", "recent"
      const now = new Date();
      const todayStr = now.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const yesterday = new Date(now);
      yesterday.setDate(yesterday.getDate() - 1);
      const yesterdayStr = yesterday.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
      const weekStart = new Date(now);
      weekStart.setDate(weekStart.getDate() - 7);
      const weekStartStr = weekStart.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });

      parts.push(
        `[EMAIL EVIDENCE — ${emailOriginCount} email chunks loaded]\n` +
        'DATE REFERENCE TABLE:\n' +
        `  "today" = ${todayStr}\n` +
        `  "yesterday" = ${yesterdayStr}\n` +
        `  "this morning" = ${todayStr}\n` +
        `  "this week" = ${weekStartStr} through ${todayStr}\n` +
        `  "latest" / "recent" = most recent emails by Sent: date\n` +
        '\nINSTRUCTIONS FOR ANSWERING:\n' +
        '1. The [DOC-N] evidence above contains REAL EMAIL CONTENT from the user\'s inbox.\n' +
        '2. Read each chunk carefully. Look for "From:", "Sent:", "Subject:" lines — these contain the REAL email metadata.\n' +
        '3. Match the user\'s date request (today/yesterday/this week/latest) against the "Sent:" dates in the chunks using the DATE REFERENCE TABLE above.\n' +
        '4. You MUST reference the ACTUAL content — use real sender names, real dates, real subjects, and real body text from the chunks.\n' +
        '5. DO NOT invent or fabricate email content. Only describe what is explicitly in the [DOC-N] evidence.\n' +
        '6. DO NOT say "I don\'t have access to your emails" — the emails ARE provided above as [DOC-N] evidence.\n' +
        '7. DO NOT say "check your email client" or "low relevance scores" — answer from the evidence provided.\n' +
        '8. If no emails match the requested date range, say "I couldn\'t find any emails in your AgentX memory for [date range]" — do NOT suggest external email clients.\n' +
        '9. Some chunks may be OCR text from email attachments (garbled text without From/Sent/Subject headers). Prioritise chunks that have clear email headers.',
      );
      log.info({ emailFocused: true, docChunks: docChunkCount, emailOriginCount, today: todayStr, yesterday: yesterdayStr }, 'P8-2.2f: Email-focused context injection with full date table');
    }

    // Add evidence tier summary for legal/medical/financial queries
    if (['legal', 'medical', 'financial'].includes(detectedDomain) && weightedCitations.length > 0) {
      const primaryCount = weightedCitations.filter(c => c.weight === 'primary').length;
      const legalAuthCount = weightedCitations.filter(c => c.weight === 'legal_authority').length;
      const secondaryCount = weightedCitations.filter(c => c.weight === 'secondary').length;
      parts.push(
        `[Evidence Tiers: ${primaryCount} primary (user docs), ${legalAuthCount} legal authority, ${secondaryCount} secondary | Confidence: ${(evidenceConfidence * 100).toFixed(0)}%]`,
      );
    }

    const contextBlock = parts.join('\n\n');

    // P8-2.2e: Optional debug dump of email context block (controlled by env var).
    // Security: email context frequently contains PII and body text. We
    // write it under ~/.agentx/debug with mode 0o600 so it's owner-only —
    // never to world-readable /tmp.
    if (isEmailFocused && process.env['AGENTX_DEBUG_EMAIL_PROMPT']) {
      try {
        const home = process.env['HOME'] ?? '';
        if (home) {
          const debugDir = nodePath.join(home, '.agentx', 'debug');
          if (!nodeFs.existsSync(debugDir)) nodeFs.mkdirSync(debugDir, { recursive: true, mode: 0o700 });
          const debugPath = nodePath.join(debugDir, 'email-context-block.txt');
          nodeFs.writeFileSync(debugPath, contextBlock, { encoding: 'utf-8', mode: 0o600 });
          log.info({ chars: contextBlock.length, path: debugPath }, 'DEBUG: Email context block written (owner-only)');
        }
      } catch { /* ignore */ }
    }

    log.info({
      memoryItems: memoryItemCount,
      docChunks: docChunkCount,
      totalChars,
      domain: detectedDomain,
      queryIntent,
      verificationNeeded: externalVerificationNeeded,
      citationCount: citations.length,
      evidenceConfidence: evidenceConfidence.toFixed(2),
      query: query.slice(0, 50),
      contextBlockPreview: contextBlock.slice(0, 200),
      warnings: warnings.length > 0 ? warnings : undefined,
    }, 'Knowledge augmentation complete');

    // Phase 1: Build DocumentEvidenceMode
    const isStrictDomain = ['legal', 'medical', 'financial'].includes(detectedDomain);
    // P6-19.11: Fact extraction queries ALWAYS use docs when available
    const forceDocsForFactMode = queryIntent === 'fact_extraction' && docChunkCount > 0;
    const documentEvidenceMode: DocumentEvidenceMode = {
      hasRelevantDocs: docChunkCount > 0,
      docCount: docChunkCount,
      mustUseDocs: (isStrictDomain && docChunkCount > 0) || forceDocsForFactMode,
      mustQuoteDocs: (isStrictDomain && docChunkCount > 0) || forceDocsForFactMode,
      webSecondaryOnly: (isStrictDomain && docChunkCount > 0) || forceDocsForFactMode,
      rawChunks,
      structuredEvidence,
      documentReferenceMap,
    };

    if (documentEvidenceMode.mustUseDocs) {
      log.info({
        docCount: docChunkCount,
        structuredExtractions: structuredEvidence.length,
        rawChunkCount: rawChunks.length,
        domain: detectedDomain,
      }, 'STRICT EVIDENCE MODE activated — documents are PRIMARY');
    }

    return {
      contextBlock,
      memoryItemCount,
      docChunkCount,
      totalChars,
      hasKnowledge: true,
      memoryQueried,
      docsQueried,
      warnings,
      citations,
      weightedCitations,
      evidenceConfidence,
      contradictions,
      detectedDomain,
      queryIntent,
      externalVerificationNeeded,
      documentEvidenceMode,
      retrievalFailed,
      retrievalFailureReason,
      isEmailFocused,
    };
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      memoryTopK: this.config.memoryTopK,
      docsTopK: this.config.docsTopK,
      maxContextChars: this.config.maxContextChars,
      hasMemorySource: !!this.memorySource,
      hasCognitiveSource: !!this.cognitiveSource,
    };
  }

  /**
   * P6-19.10: Decompose multi-part queries into sub-queries for targeted retrieval.
   * E.g. "1. What is SSP? 2. What is the protective award?" → ["What is SSP", "What is the protective award"]
   * Single questions return as a single-element array.
   */
  /** P6-19.12: Public for multi-part verification in response guard */
  _decomposeQuery(query: string): string[] {
    // Detect numbered questions: "1. ... 2. ... 3. ..."
    const numberedParts = query.split(/(?:^|\n)\s*\d+\.\s+/).filter(s => s.trim().length > 5);
    if (numberedParts.length >= 2) {
      log.info({ parts: numberedParts.length }, 'P6-19.10: Decomposed multi-part query');
      return numberedParts.map(p => p.replace(/\n/g, ' ').trim());
    }

    // Detect " and " conjunctions joining distinct topics
    // "What is X and what is Y?" → ["What is X", "what is Y"]
    const andParts = query.split(/\s+and\s+(?=what|how|when|where|who|why)/i);
    if (andParts.length >= 2) {
      log.info({ parts: andParts.length }, 'P6-19.10: Decomposed conjunction query');
      return andParts.map(p => p.trim());
    }

    // P6-19.12: Detect "what is X and Y" pattern where X and Y are separate topics
    // "What is SSP % and protective award?" → ["What is SSP %", "What is protective award"]
    const whatIsAndMatch = query.match(/^(what\s+(?:is|are)\s+)(.+?)\s+and\s+(.+?)[\?\.]?\s*$/i);
    if (whatIsAndMatch) {
      const prefix = whatIsAndMatch[1]; // "What is "
      const part1 = whatIsAndMatch[2];   // "SSP %"
      const part2 = whatIsAndMatch[3];   // "protective award?"
      // Only split if both parts are distinct topics (not a single compound noun)
      if (part1.length > 2 && part2.length > 2) {
        log.info({ parts: 2 }, 'P6-19.12: Decomposed "what is X and Y" query');
        return [`${prefix}${part1}`.trim(), `${prefix}${part2}`.trim()];
      }
    }

    // Detect question marks separating parts: "What is X? What is Y?"
    const questionParts = query.split(/\?\s+/).filter(s => s.trim().length > 5);
    if (questionParts.length >= 2) {
      log.info({ parts: questionParts.length }, 'P6-19.10: Decomposed multi-question query');
      return questionParts.map(p => p.replace(/\?$/, '').trim());
    }

    return [query];
  }

  /**
   * P6-19.10: Retrieve with coverage — runs separate retrieval for each sub-query
   * and merges results to ensure diverse topic coverage.
   * Returns a combined result that covers all query parts.
   */
  private _retrieveWithCoverage(subQueries: string[], originTypeFilter?: string): { route: string; chunks: any[]; documents: any[]; count: number | null; count_label: string | null } {
    if (!this.cognitiveSource) {
      return { route: 'no-source', chunks: [], documents: [], count: 0, count_label: 'no cognitive source' };
    }

    if (subQueries.length <= 1) {
      // Single query — use wider retrieval window so signal boosting can re-rank
      // P6-19.11: Fetch 3× topK to give factsheet/case-specific boosts room to promote
      const singleResult = this.cognitiveSource.retrieve(subQueries[0], this.config.docsTopK * 3, originTypeFilter);

      // P6-19.11: Sibling expansion for single queries too — factsheet chunks
      // using different wording won't match the query but belong with their siblings
      const seenIds = new Set(singleResult.chunks.map((c: any) => c.chunk_id));
      const factsheetNames = new Set<string>();
      for (const chunk of singleResult.chunks) {
        const fn = chunk.file_name ?? '';
        if (/factsheet/i.test(fn) && fn.length > 5) {
          factsheetNames.add(fn);
        }
      }
      for (const name of factsheetNames) {
        const cleanName = name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
        const siblingResult = this.cognitiveSource.retrieve(cleanName, 12, originTypeFilter);
        for (const chunk of siblingResult.chunks) {
          if (!seenIds.has(chunk.chunk_id)) {
            seenIds.add(chunk.chunk_id);
            singleResult.chunks.push(chunk);
          }
        }
      }

      return singleResult;
    }

    // Multi-part: run separate retrievals and merge with deduplication
    const allChunks: any[] = [];
    const seenChunkIds = new Set<string>();
    // P6-19.11: Fetch wide per sub-query to ensure factsheet chunks aren't missed
    const perQueryLimit = Math.max(8, this.config.docsTopK * 2);

    for (const subQuery of subQueries) {
      const result = this.cognitiveSource.retrieve(subQuery, perQueryLimit, originTypeFilter); // wide window for re-ranking
      log.info({
        subQuery: subQuery.slice(0, 60),
        chunksReturned: result.chunks.length,
      }, 'P6-19.10: Sub-query retrieval');

      for (const chunk of result.chunks) {
        if (!seenChunkIds.has(chunk.chunk_id)) {
          seenChunkIds.add(chunk.chunk_id);
          allChunks.push(chunk);
        }
      }
    }

    // Also run the full combined query to catch cross-topic matches
    const fullResult = this.cognitiveSource.retrieve(subQueries.join(' '), perQueryLimit, originTypeFilter);
    for (const chunk of fullResult.chunks) {
      if (!seenChunkIds.has(chunk.chunk_id)) {
        seenChunkIds.add(chunk.chunk_id);
        allChunks.push(chunk);
      }
    }

    // P6-19.11: Sibling chunk expansion for factsheets — search by filename
    // to pull chunks that may use different wording but are in the same factsheet
    if (this.cognitiveSource) {
      const factsheetNames = new Set<string>();
      for (const chunk of allChunks) {
        const fn = chunk.file_name ?? '';
        if (/factsheet/i.test(fn) && fn.length > 5) {
          factsheetNames.add(fn);
        }
      }
      for (const name of factsheetNames) {
        // Search by factsheet title words to retrieve additional chunks
        const cleanName = name.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ');
        const siblingResult = this.cognitiveSource.retrieve(cleanName, 12, originTypeFilter);
        let added = 0;
        for (const chunk of siblingResult.chunks) {
          if (!seenChunkIds.has(chunk.chunk_id)) {
            seenChunkIds.add(chunk.chunk_id);
            allChunks.push(chunk);
            added++;
          }
        }
        if (added > 0) {
          log.info({ factsheet: name, added }, 'P6-19.11: Factsheet sibling chunks expanded');
        }
      }
    }

    // Sort by score descending, take topK — but ALWAYS preserve factsheet chunks
    // P6-19.11: Factsheet sibling chunks often have low raw BM25 scores because
    // they use different wording (e.g. "80% rate" instead of "percentage").
    // The signal boosting pipeline will re-rank them, so we must not cut them here.
    const factsheetChunks = allChunks.filter(c => /factsheet/i.test(c.file_name ?? ''));
    const nonFactsheetChunks = allChunks.filter(c => !/factsheet/i.test(c.file_name ?? ''));
    const sorted = [
      ...nonFactsheetChunks
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, this.config.docsTopK + 4),
      ...factsheetChunks.filter(fc =>
        !nonFactsheetChunks.slice(0, this.config.docsTopK + 4).some(nc => nc.chunk_id === fc.chunk_id)
      ),
    ];

    // Gather unique documents
    const docIds = [...new Set(sorted.map((c: any) => c.document_id))];
    const documents = docIds.map(id => {
      const chunk = sorted.find((c: any) => c.document_id === id);
      return { document_id: id, file_name: chunk?.file_name ?? 'unknown' };
    });

    log.info({
      subQueries: subQueries.length,
      totalChunks: allChunks.length,
      dedupedChunks: sorted.length,
      documents: documents.length,
    }, 'P6-19.10: Multi-part retrieval merged');

    return {
      route: fullResult.route,
      chunks: sorted,
      documents,
      count: sorted.length,
      count_label: `${sorted.length} chunks from ${documents.length} documents (${subQueries.length} sub-queries)`,
    };
  }

  private empty(): KnowledgeContext {
    return {
      contextBlock: '',
      memoryItemCount: 0,
      docChunkCount: 0,
      totalChars: 0,
      hasKnowledge: false,
      memoryQueried: false,
      docsQueried: false,
      warnings: ['augmentation disabled or called before initialization'],
      citations: [],
      weightedCitations: [],
      evidenceConfidence: 0,
      contradictions: [],
      detectedDomain: 'general',
      queryIntent: 'general',
      externalVerificationNeeded: false,
      documentEvidenceMode: {
        hasRelevantDocs: false,
        docCount: 0,
        mustUseDocs: false,
        mustQuoteDocs: false,
        webSecondaryOnly: false,
        rawChunks: [],
        structuredEvidence: [],
        documentReferenceMap: {},
      },
      retrievalFailed: false,
      retrievalFailureReason: '',
      isEmailFocused: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 3: Structured Document Extraction
  // ---------------------------------------------------------------------------
  // Converts messy OCR / document text into structured evidence that the LLM
  // can more reliably use. Deterministic heuristics — no extra LLM call.

  private extractStructuredEvidence(
    citationRef: string,
    documentId: string,
    text: string,
    score?: number,
  ): StructuredDocumentEvidence {
    const extractedLists: string[] = [];
    const extractedFacts: string[] = [];
    const extractedQuotes: string[] = [];
    let confidence = 0.5;

    // ── Phase 2 (P6-18): OCR cleanup before extraction ──────────────
    // Clean common OCR artefacts: pipe columns, stray brackets, broken spacing
    const cleaned = text
      .replace(/\|/g, ' ')           // Remove table pipe separators
      .replace(/[{}\[\]]/g, '')      // Remove stray brackets
      .replace(/\s{3,}/g, '  ')      // Collapse excessive spaces
      .replace(/([a-z])\s{2}([a-z])/gi, '$1 $2')  // Fix broken words
      .replace(/[§¢£€¥]/g, '')      // Remove currency/symbol noise
      .replace(/\s*[~*#]+\s*/g, ' ') // Remove decoration chars
      .trim();

    // Split on sentences/newlines but preserve longer phrases
    const lines = cleaned
      .split(/(?<=[.!?])\s+|\n/)
      .map(l => l.trim())
      .filter(l => l.length > 8);

    for (const line of lines) {
      // ── List detection (expanded for OCR tolerance) ──────────────
      // Standard numbered/bulleted items
      if (/^[\d]+[.)]\s|^[-•–—*]\s|^[a-z]\)\s|^\([a-z]\)\s|^\([ivxlcdm]+\)\s/i.test(line)) {
        extractedLists.push(line);
        continue;
      }
      // OCR-corrupted list markers: "0 " or "o " at start (common OCR for bullet)
      if (/^[oO0]\s+[A-Z]/.test(line) && line.length > 15) {
        extractedLists.push(line.replace(/^[oO0]\s+/, '• '));
        continue;
      }

      // ── Comma-separated enumerations (protected characteristics, grounds, etc.) ──
      const commaItems = line.split(/,\s*/).filter(i => i.length > 2);
      if (commaItems.length >= 4 && /\b(age|sex|race|religion|disability|gender|orientation|belief|marriage|pregnancy|reassignment|characteristic|ground|discrimination)\b/i.test(line)) {
        extractedLists.push(line);
        continue;
      }

      // ── Semi-colon separated items (common in legal lists) ──
      const semiItems = line.split(/;\s*/).filter(i => i.length > 3);
      if (semiItems.length >= 3) {
        for (const item of semiItems) {
          if (item.length > 8) extractedLists.push(item.trim());
        }
        continue;
      }

      // ── Dates (legal context: commencement dates, deadlines) ──
      if (/\b\d{1,2}\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{4}\b/i.test(line)) {
        extractedFacts.push(line);
        continue;
      }

      // ── Consequence/obligation patterns (expanded) ──
      if (/\b(must|shall|will result|failure to|required to|entitled to|may not|cannot|prohibited|mandatory|unless|rejected|struck out|dismissed|barred|time.?limit|within \d+|not be accepted|will not proceed)\b/i.test(line)) {
        extractedFacts.push(line);
        continue;
      }

      // ── Definitions / protected characteristics / claim types ──
      if (/\b(means|includes?|defined as|refers? to|protected|characteristic|ground|type of claim|prescribed form|early conciliation|ACAS|ET[13]|tribunal)\b/i.test(line)) {
        extractedFacts.push(line);
        continue;
      }

      // ── Procedural steps (numbered paragraphs like "6.1 The first step...") ──
      if (/^\d+\.\d+\s+/i.test(line) && line.length > 20) {
        extractedFacts.push(line);
        continue;
      }

      // ── Quotable passages (in quotes, or formal section references) ──
      if (/["'\u201c\u201d].*["'\u201c\u201d]/.test(line) || /\b(section|regulation|act|rule|article|schedule|part)\s+\d+/i.test(line)) {
        extractedQuotes.push(line);
        continue;
      }

      // ── Legal keyword sentences (catch remaining legal content) ──
      if (/\b(claimant|respondent|employment tribunal|unfair dismissal|discrimination|redundancy|notice period|breach|damages|remedy|grievance|disciplinary|settlement|without prejudice|protected conversation)\b/i.test(line) && line.length > 25) {
        extractedFacts.push(line);
        continue;
      }
    }

    // ── Assess OCR quality ──────────────────────────────────────────
    const garbledRatio = (text.match(/[^\x20-\x7E\n\r]/g)?.length ?? 0) / Math.max(text.length, 1);
    const wordCount = text.split(/\s+/).length;
    const totalExtractions = extractedFacts.length + extractedLists.length + extractedQuotes.length;

    if (garbledRatio > 0.15) {
      confidence = totalExtractions > 0 ? 0.4 : 0.2; // Degraded but still attempt
    } else if (garbledRatio > 0.05) {
      confidence = totalExtractions > 2 ? 0.7 : 0.5;
    } else if (wordCount > 20 && totalExtractions > 0) {
      confidence = 0.85;
    } else if (wordCount > 10) {
      confidence = 0.7;
    }

    return {
      sourceId: documentId,
      citationRef,
      extractedLists,
      extractedFacts,
      extractedQuotes,
      confidence,
    };
  }

  // ---------------------------------------------------------------------------
  // Phase 1 (P6-18): Extract best quotable passages for hard quote enforcement
  // ---------------------------------------------------------------------------
  // Picks the single most quotable passage from each DOC chunk — a clean,
  // self-contained sentence that the LLM can use as a direct quote.

  extractBestQuotes(rawChunks: DocumentEvidenceMode['rawChunks']): string[] {
    const quotes: string[] = [];
    for (const chunk of rawChunks) {
      // Clean OCR noise first
      const cleaned = chunk.text
        .replace(/\|/g, ' ')
        .replace(/[{}\[\]§¢£€¥]/g, '')
        .replace(/\s{3,}/g, '  ')
        .trim();

      // Split into sentences
      const sentences = cleaned
        .split(/(?<=[.!?])\s+/)
        .map(s => s.trim())
        .filter(s => s.length > 15 && s.length < 300);

      // Score each sentence for quotability
      let bestSentence = '';
      let bestScore = 0;
      for (const s of sentences) {
        let score = 0;
        // Legal keyword density
        const legalMatches = s.match(/\b(must|shall|failure|required|entitled|rejected|dismissed|tribunal|claimant|respondent|discrimination|protected|section|act|rule|unless|prescribed|mandatory|claim|ET[13]|ACAS|conciliation)\b/gi);
        score += (legalMatches?.length ?? 0) * 2;
        // Completeness: has subject + verb
        if (/\b(is|are|was|were|has|have|shall|must|may|will|can)\b/i.test(s)) score += 3;
        // Penalty for garbled text
        const garbled = (s.match(/[^\x20-\x7E]/g)?.length ?? 0) / s.length;
        if (garbled > 0.1) score -= 5;
        // Bonus for consequence statements
        if (/\b(failure to|will result|will not|shall not|may be|must be|is required)\b/i.test(s)) score += 4;
        // Bonus for being a complete thought (ends with period)
        if (s.endsWith('.')) score += 2;

        if (score > bestScore) {
          bestScore = score;
          bestSentence = s;
        }
      }

      if (bestSentence && bestScore >= 3) {
        quotes.push(`${chunk.citationRef}: "${bestSentence}"`);
      }
    }
    return quotes;
  }
}
