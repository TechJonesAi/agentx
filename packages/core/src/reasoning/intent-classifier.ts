/**
 * Phase 1 — Intent Classifier
 *
 * Lightweight, pure, synchronous classifier mapping a user query to one of
 * three intents that the Decision Engine consumes via
 * `DecisionKnowledgeContext.queryIntent`.
 *
 * Rules:
 *   - Pure: same input → same output. No state, no IO.
 *   - Disambiguation: when both strategy and fact patterns match, the
 *     classifier returns 'general' (most conservative — DE treats general
 *     most permissively, so misclassifying as fact_extraction or strategy
 *     would be the riskier failure mode).
 */

export type QueryIntent = 'fact_extraction' | 'strategy' | 'general';

const FACT_QUESTION_WORDS = ['what', 'who', 'when', 'where', 'which', 'why'];
const FACT_IMPERATIVE_VERBS = ['find', 'show', 'list', 'extract', 'get', 'tell me', 'look up'];

// Strategy patterns are evaluated as regular expressions against the lower-cased query.
// Apostrophe variants (' and U+2019 ') are both accepted.
const STRATEGY_PATTERNS: RegExp[] = [
  /\bhow\s+(do|should|can|would|might)\s+i\b/i,
  /\bhow\s+to\s+\w/i,
  /\bwhat[’']s\s+the\s+best\s+way\b/i,
  /\bwhat\s+is\s+the\s+best\s+way\b/i,
  /\bplan\s+(a|the|my|an)\b/i,
  /\bhelp\s+me\b/i,
];

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesStrategy(lower: string): boolean {
  for (const re of STRATEGY_PATTERNS) {
    if (re.test(lower)) return true;
  }
  return false;
}

function matchesFact(lower: string): boolean {
  // Question form: ends with '?' AND begins with one of the fact question words.
  // Leading whitespace tolerated.
  if (lower.endsWith('?')) {
    for (const w of FACT_QUESTION_WORDS) {
      const re = new RegExp(`^\\s*${w}\\b`);
      if (re.test(lower)) return true;
    }
  }
  // Imperative form: starts with one of the extraction verbs.
  for (const verb of FACT_IMPERATIVE_VERBS) {
    const escaped = escapeForRegex(verb);
    const re = new RegExp(`^\\s*${escaped}\\b`);
    if (re.test(lower)) return true;
  }
  return false;
}

export class IntentClassifier {
  classify(query: string): QueryIntent {
    if (typeof query !== 'string') return 'general';
    const trimmed = query.trim();
    if (trimmed.length === 0) return 'general';
    const lower = trimmed.toLowerCase();

    const isStrategy = matchesStrategy(lower);
    const isFact = matchesFact(lower);

    // Tie-break: if both match, return 'general' (conservative).
    if (isStrategy && isFact) return 'general';
    if (isStrategy) return 'strategy';
    if (isFact) return 'fact_extraction';
    return 'general';
  }
}
