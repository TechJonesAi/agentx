/**
 * TaskClassifier — Batch 3 routing input.
 *
 * Lightweight, dependency-free heuristic that classifies a user message into
 * one of the routing engine's task types. Outputs both a primary type and a
 * confidence in [0,1]. Designed to be replaced/augmented by an ML classifier
 * in a later batch without changing the public contract.
 *
 * The classifier is intentionally simple: no external calls, no LLM, fast,
 * deterministic, testable.
 */

export type TaskType =
  | 'chat'
  | 'coding'
  | 'reasoning'
  | 'retrieval-grounded-qa'
  | 'summarisation'
  | 'multimodal'
  | 'ocr'
  | 'vision'
  | 'builder'
  | 'tool-heavy'
  | 'autonomous-repair'
  | 'memory-intensive'
  | 'fast-response'
  | 'deep-analysis';

export interface TaskClassification {
  primary: TaskType;
  confidence: number;
  signals: string[];      // human-readable cues that contributed to the choice
}

/** Regex patterns mapped to task types. Order matters for ties — earlier
 *  rules win unless a later rule has strictly higher score. */
const RULES: Array<{ task: TaskType; weight: number; pattern: RegExp; label: string }> = [
  // Builder / app generation — allow adjectives between verb and noun.
  { task: 'builder', weight: 5, pattern: /\b(build|scaffold|generate|create)\b[^.\n]{0,80}\b(app|application|website|web\s*app|service|api|tool|dashboard)\b/i, label: 'build-app-keyword' },
  { task: 'builder', weight: 4, pattern: /\bbuilder\s*v?2?\b/i, label: 'builder-keyword' },

  // Coding
  { task: 'coding', weight: 4, pattern: /```|\bfunction\s+\w+\(|\bclass\s+\w+\b|\bimport\s+.*from\b|\bdef\s+\w+\(|\bconst\s+\w+\s*=/i, label: 'code-pattern' },
  { task: 'coding', weight: 3, pattern: /\b(refactor|debug|fix\s+the\s+bug|implement|write\s+(a\s+)?(function|class|test|test case|module))\b/i, label: 'code-verb' },
  { task: 'coding', weight: 3, pattern: /\b(typescript|javascript|python|rust|golang|java|c\+\+|sql|bash|shell)\b/i, label: 'language' },

  // OCR / Vision (separable)
  { task: 'ocr', weight: 5, pattern: /\b(ocr|extract\s+text|read\s+this\s+(image|photo|screenshot|pdf))\b/i, label: 'ocr-keyword' },
  { task: 'vision', weight: 5, pattern: /\b(image|photo|screenshot|picture|visual)\b/i, label: 'image-keyword' },
  { task: 'multimodal', weight: 3, pattern: /\b(audio|video|voice|speech)\b/i, label: 'multimodal-keyword' },

  // Summarisation — weight 6 clears the P12-1 routing confidence gate
  // (0.6) so plain summaries ride the fast lane. Doc-grounded signals
  // are weight 7 (strictly higher) so "summarise the tribunal bundle"
  // still routes heavy.
  { task: 'summarisation', weight: 6, pattern: /\b(summari[sz]e|tl;dr|in\s+(one|a\s+few)\s+sentences|key\s+points|condense)\b/i, label: 'summarise-verb' },

  // Reasoning / deep analysis
  { task: 'reasoning', weight: 4, pattern: /\b(why\s+(does|is|did)|explain\s+(why|how)|reason\s+about|step\s+by\s+step|chain\s+of\s+thought)\b/i, label: 'reasoning-verb' },
  { task: 'deep-analysis', weight: 4, pattern: /\b(analy[sz]e|deep\s+dive|investigate|root\s+cause|thorough|comprehensive)\b/i, label: 'analysis-verb' },

  // Retrieval-grounded QA — cites memory/docs
  { task: 'retrieval-grounded-qa', weight: 5, pattern: /\[(MEM|DOC)-\d+\]/i, label: 'citation-marker' },
  { task: 'retrieval-grounded-qa', weight: 3, pattern: /\b(based\s+on|according\s+to)\s+(my|the)\s+(notes|memory|documents|files)\b/i, label: 'cite-source-verb' },
  // P12-1 — Document-grounded query signals. These queries MUST route to
  // the heavy reasoning model (legal/medical accuracy is non-negotiable),
  // so they must never fall through to 'chat' and get fast-laned:
  //   • explicit filename mention ("In Blackstone.pdf, …")
  //   • structural anchors (clause / section / article N — statute-speak)
  //   • legal / medical / tribunal terms of art
  //   • corpus phrasing ("in my documents / emails / library")
  // Weight 7 (strictly > every task-verb rule incl. summarisation at 6)
  // so a doc-grounded signal ALWAYS out-scores verbs — "Summarise the
  // tribunal bundle" must stay on the heavy model, not the fast lane.
  { task: 'retrieval-grounded-qa', weight: 7, pattern: /\b[\w][\w\s'-]{0,40}\.(?:pdf|docx?|eml|png|jpe?g|txt)\b/i, label: 'filename-mention' },
  { task: 'retrieval-grounded-qa', weight: 7, pattern: /\b(?:clause|section|article|paragraph|schedule|annex)\s+\d{1,4}\b/i, label: 'statute-anchor' },
  { task: 'retrieval-grounded-qa', weight: 7, pattern: /\b(?:tribunal|claimant|respondent|statute|magna\s+carta|et1|acas|dismissal|discrimination|reasonable\s+adjustments?|witness\s+statement|hearing\s+bundle)\b/i, label: 'legal-term' },
  { task: 'retrieval-grounded-qa', weight: 7, pattern: /\b(?:diagnosis|patient|clinical|prognosis|gmc|prescription|symptom)\b/i, label: 'medical-term' },
  { task: 'retrieval-grounded-qa', weight: 7, pattern: /\b(?:in|from|across|search)\s+my\s+(?:stored\s+)?(?:documents?|files?|e-?mails?|library|inbox|messages)\b/i, label: 'corpus-phrase' },
  { task: 'memory-intensive', weight: 3, pattern: /\b(remember\s+when|earlier\s+(you|we)\s+(said|discussed|mentioned))\b/i, label: 'memory-recall' },

  // Tool-heavy
  { task: 'tool-heavy', weight: 3, pattern: /\b(run\s+(this\s+)?(command|shell|script)|execute|chain\s+of\s+tools)\b/i, label: 'tool-verb' },

  // Autonomous repair
  { task: 'autonomous-repair', weight: 5, pattern: /\b(self-?repair|auto-?repair|heal|fix\s+yourself|fix\s+the\s+system)\b/i, label: 'repair-verb' },

  // Fast-response — short conversational fillers only. The regex is
  // fully anchored (entire message must be a filler) so false positives
  // are impossible; weight 6 clears the P12-1 routing confidence gate.
  { task: 'fast-response', weight: 6, pattern: /^\s*(yes|no|ok|okay|sure|thanks|thx|ty|nope|yep|hi|hey)[!.?\s]*$/i, label: 'short-filler' },

  // P12-1 — Positive smalltalk signals. 'chat' is otherwise the no-match
  // DEFAULT (confidence 0.5, below the routing gate → heavy model). Only
  // explicit greeting / smalltalk phrasing earns the fast lane; anything
  // ambiguous stays on the heavy default for accuracy. Fast requires
  // positive evidence — never a guess.
  { task: 'chat', weight: 6, pattern: /^\s*(?:hi|hello|hey|good\s+(?:morning|afternoon|evening))\b|\btell\s+me\s+a\s+joke\b|\bhow\s+are\s+you\b/i, label: 'smalltalk' },
];

/**
 * P13 fix — Retrieval gate for smalltalk. Greetings, fillers, and pure
 * conversational openers must NOT hit the document corpus: "hello"
 * semantically matches every email that opens "Hello Darren", flooding
 * the chat UI with a 10-document evidence panel for a greeting.
 *
 * True when the message is an anchored filler (fast-response) or an
 * explicit smalltalk opener — the same positive-evidence signals the
 * router uses, so gating stays consistent with routing.
 */
export function shouldSkipRetrievalForSmalltalk(input: string): boolean {
  const c = classifyTask(input);
  if (c.primary === 'fast-response') return true;
  if (c.primary === 'chat' && c.signals.some((s) => s.startsWith('smalltalk'))) return true;
  return false;
}

/** Classify a message. Returns the highest-scoring task type. Ties broken
 *  by rule order. Defaults to 'chat' with confidence 0.5 when nothing matches. */
export function classifyTask(input: string): TaskClassification {
  const text = String(input ?? '');
  const scores = new Map<TaskType, number>();
  const signals: string[] = [];

  for (const r of RULES) {
    if (r.pattern.test(text)) {
      scores.set(r.task, (scores.get(r.task) ?? 0) + r.weight);
      signals.push(`${r.label}:${r.task}`);
    }
  }

  // Multi-rule reinforcement: 2+ coding signals → bump confidence.
  if ((scores.get('coding') ?? 0) >= 6) scores.set('coding', (scores.get('coding') ?? 0) + 2);

  if (scores.size === 0) {
    return { primary: 'chat', confidence: 0.5, signals: [] };
  }

  let bestTask: TaskType = 'chat';
  let bestScore = -1;
  for (const [task, score] of scores) {
    if (score > bestScore) {
      bestScore = score;
      bestTask = task;
    }
  }

  // Normalise confidence to [0,1]. Cap at the score / 10.
  const confidence = Math.max(0.5, Math.min(1, bestScore / 10));
  return { primary: bestTask, confidence: Math.round(confidence * 100) / 100, signals };
}
