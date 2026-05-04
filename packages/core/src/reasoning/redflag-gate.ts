/**
 * Phase 3 — Red-flag Gate
 *
 * Pure, synchronous keyword classifier that detects high-urgency medical or
 * legal triggers in a user query. Returns the matched keyword in `reason`
 * (or `null` when no trigger matches).
 *
 * This module owns ONLY trigger detection. How callers respond to a red flag
 * (refuse, advise emergency services, route to a strict-gate path, etc.) is
 * the responsibility of the Phase-4 orchestrator. This file contains no
 * routing decisions, no prompt content, and no IO.
 *
 * Match rules:
 *   - Single-word triggers ("sue", "bleeding", "unconscious") use whole-word
 *     boundary matching so "lawsuit" does NOT match "sue" and "supersue"
 *     does NOT match "sue".
 *   - Multi-word triggers ("chest pain", "can't breathe", "court order",
 *     "legal advice urgent") use case-insensitive substring matching.
 *   - For "can't breathe", both straight apostrophe (') and curly
 *     apostrophe (’ U+2019) are accepted.
 *   - When multiple triggers are present, the first match in the declared
 *     order wins (medical triggers take precedence over legal).
 */

export interface RedFlagResult {
  isRedFlag: boolean;
  reason: string | null;
}

interface TriggerSpec {
  keyword: string;
  /** Optional explicit list of substring forms to test (e.g. apostrophe variants). */
  forms?: readonly string[];
  /** When true, requires whole-word boundaries. Default: inferred (true if keyword has no spaces). */
  wholeWord?: boolean;
}

const TRIGGERS: readonly TriggerSpec[] = [
  // Medical (declared first — higher priority on tie)
  { keyword: 'chest pain' },
  { keyword: "can't breathe", forms: ["can't breathe", 'can’t breathe', 'cant breathe'] },
  { keyword: 'bleeding', wholeWord: true },
  { keyword: 'unconscious', wholeWord: true },
  // Legal
  { keyword: 'sue', wholeWord: true },
  { keyword: 'court order' },
  { keyword: 'legal advice urgent' },
];

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isWholeWord(spec: TriggerSpec): boolean {
  if (typeof spec.wholeWord === 'boolean') return spec.wholeWord;
  return !spec.keyword.includes(' ');
}

function matches(lower: string, spec: TriggerSpec): boolean {
  const forms = spec.forms ?? [spec.keyword];
  for (const form of forms) {
    if (isWholeWord(spec)) {
      const re = new RegExp(`\\b${escapeForRegex(form)}\\b`);
      if (re.test(lower)) return true;
    } else {
      if (lower.includes(form)) return true;
    }
  }
  return false;
}

export function detectRedFlag(query: string): RedFlagResult {
  if (typeof query !== 'string' || query.trim().length === 0) {
    return { isRedFlag: false, reason: null };
  }
  const lower = query.toLowerCase();
  for (const spec of TRIGGERS) {
    if (matches(lower, spec)) {
      return { isRedFlag: true, reason: spec.keyword };
    }
  }
  return { isRedFlag: false, reason: null };
}
