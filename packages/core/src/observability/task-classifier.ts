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

  // Summarisation
  { task: 'summarisation', weight: 4, pattern: /\b(summari[sz]e|tl;dr|in\s+(one|a\s+few)\s+sentences|key\s+points|condense)\b/i, label: 'summarise-verb' },

  // Reasoning / deep analysis
  { task: 'reasoning', weight: 4, pattern: /\b(why\s+(does|is|did)|explain\s+(why|how)|reason\s+about|step\s+by\s+step|chain\s+of\s+thought)\b/i, label: 'reasoning-verb' },
  { task: 'deep-analysis', weight: 4, pattern: /\b(analy[sz]e|deep\s+dive|investigate|root\s+cause|thorough|comprehensive)\b/i, label: 'analysis-verb' },

  // Retrieval-grounded QA — cites memory/docs
  { task: 'retrieval-grounded-qa', weight: 5, pattern: /\[(MEM|DOC)-\d+\]/i, label: 'citation-marker' },
  { task: 'retrieval-grounded-qa', weight: 3, pattern: /\b(based\s+on|according\s+to)\s+(my|the)\s+(notes|memory|documents|files)\b/i, label: 'cite-source-verb' },
  { task: 'memory-intensive', weight: 3, pattern: /\b(remember\s+when|earlier\s+(you|we)\s+(said|discussed|mentioned))\b/i, label: 'memory-recall' },

  // Tool-heavy
  { task: 'tool-heavy', weight: 3, pattern: /\b(run\s+(this\s+)?(command|shell|script)|execute|chain\s+of\s+tools)\b/i, label: 'tool-verb' },

  // Autonomous repair
  { task: 'autonomous-repair', weight: 5, pattern: /\b(self-?repair|auto-?repair|heal|fix\s+yourself|fix\s+the\s+system)\b/i, label: 'repair-verb' },

  // Fast-response — short conversational fillers only. Tight to avoid
  // swallowing real questions like "Hello, how are you?".
  { task: 'fast-response', weight: 2, pattern: /^\s*(yes|no|ok|okay|sure|thanks|thx|ty|nope|yep|hi|hey)[!.?\s]*$/i, label: 'short-filler' },
];

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
