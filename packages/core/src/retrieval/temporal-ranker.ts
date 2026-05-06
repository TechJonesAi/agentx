/**
 * TemporalRanker — context-aware recency boost for retrieval.
 *
 * Problem it solves:
 *   Base retrieval scores by textual relevance only. "Rob's latest email"
 *   and "What did Rob say in December 2024?" both just score by keyword
 *   overlap, so you get whichever Rob-email happens to match keywords best.
 *
 * How this fixes it:
 *   1. Parse the query for a `TemporalHint`:
 *        - 'recent'   : "latest", "most recent", "newest", "recent", "new"
 *        - 'oldest'   : "oldest", "earliest", "first"
 *        - 'window'   : "today", "yesterday", "this week", "this month" +
 *                        explicit dates like "14 April 2026", "December 2024"
 *        - 'none'     : no temporal signal
 *   2. For each retrieved chunk, apply a boost based on (hint, chunk_date):
 *        - 'recent'   : exponential decay — newest +0.6, 30d old +0.3, 180d +0.05
 *        - 'oldest'   : inverse decay — oldest +0.5
 *        - 'window'   : +0.5 if inside the window, -0.25 if outside
 *        - 'none'     : gentle tilt — last 7d +0.10, last 30d +0.05, else 0
 *
 * Design notes:
 *   - Pure function: no DB access, no side effects. Easy to test.
 *   - Permissive date parsing to handle the formats we see in documents
 *     (ISO, "31 December 2024 10:26", "Tuesday, April 14, 2026 10:32 AM").
 *   - Returns 0 when no date can be parsed — never throws.
 */

export type TemporalHintKind = 'recent' | 'oldest' | 'window' | 'none';

export interface TemporalHint {
  kind: TemporalHintKind;
  /** Explicit window (used when kind === 'window'). */
  windowStart?: Date;
  windowEnd?: Date;
  /** The phrase that triggered detection (for debug/trace). */
  trigger?: string;
}

// ─── Query intent detection ──────────────────────────────────────────

const RECENT_MARKERS: RegExp[] = [
  /\b(latest|most recent|newest|most[-\s]up[-\s]to[-\s]date|the new(?:est)?)\b/i,
  /\b(recent(?:ly)?|just now|lately)\b/i,
  /\bwhat[''\s]*s new\b/i,
  /\bany new\b/i,
  /\blast email\b/i,                // "the last email from Rob"
];

const OLDEST_MARKERS: RegExp[] = [
  /\b(oldest|earliest|first)\b/i,
  /\b(original|initial)\b/i,
];

// Relative windows: "today", "yesterday", "this week", "last week", etc.
const RELATIVE_WINDOW_MARKERS: Array<{ re: RegExp; kind: string }> = [
  { re: /\btoday\b/i, kind: 'today' },
  { re: /\byesterday\b/i, kind: 'yesterday' },
  { re: /\bthis morning\b/i, kind: 'today' },
  { re: /\bthis afternoon\b/i, kind: 'today' },
  { re: /\bthis evening\b/i, kind: 'today' },
  { re: /\bthis week\b/i, kind: 'this-week' },
  { re: /\blast week\b/i, kind: 'last-week' },
  { re: /\bthis month\b/i, kind: 'this-month' },
  { re: /\blast month\b/i, kind: 'last-month' },
  { re: /\bthis year\b/i, kind: 'this-year' },
  { re: /\blast year\b/i, kind: 'last-year' },
  { re: /\b(?:the\s+)?past (\d{1,3}) days?\b/i, kind: 'past-N-days' },
  { re: /\blast (\d{1,3}) days?\b/i, kind: 'past-N-days' },
];

// Month names — keep this set tight to avoid false positives on proper nouns
const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const MONTH_RE = new RegExp(`\\b(${MONTH_NAMES.join('|')})\\b(?:\\s+(\\d{4}))?`, 'i');
// "14 April 2026", "April 14 2026", "April 14, 2026"
const EXPLICIT_DATE_RE = new RegExp(`\\b(\\d{1,2})\\s+(${MONTH_NAMES.join('|')})(?:\\s+(\\d{4}))?\\b|\\b(${MONTH_NAMES.join('|')})\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?\\b`, 'i');

/** Resolve a relative window marker to a [start, end] range relative to now.
 *  Uses UTC so window boundaries are consistent regardless of server timezone. */
function relativeWindow(kind: string, now: Date, captured?: string): { start: Date; end: Date } | null {
  const start = new Date(now);
  const end = new Date(now);

  switch (kind) {
    case 'today':
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    case 'yesterday':
      start.setUTCDate(start.getUTCDate() - 1);
      start.setUTCHours(0, 0, 0, 0);
      end.setUTCDate(end.getUTCDate() - 1);
      end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    case 'this-week': {
      const dow = (now.getUTCDay() + 6) % 7;          // 0=Mon (UTC)
      start.setUTCDate(start.getUTCDate() - dow);
      start.setUTCHours(0, 0, 0, 0);
      end.setTime(start.getTime() + 6 * 24 * 60 * 60 * 1000);
      end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    }
    case 'last-week': {
      const dow = (now.getUTCDay() + 6) % 7;
      start.setUTCDate(start.getUTCDate() - dow - 7);
      start.setUTCHours(0, 0, 0, 0);
      end.setTime(start.getTime() + 6 * 24 * 60 * 60 * 1000);
      end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    }
    case 'this-month':
      start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0);
      end.setUTCMonth(start.getUTCMonth() + 1, 0); end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    case 'last-month':
      start.setUTCMonth(start.getUTCMonth() - 1, 1); start.setUTCHours(0, 0, 0, 0);
      end.setUTCMonth(start.getUTCMonth() + 1, 0); end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    case 'this-year':
      start.setUTCMonth(0, 1); start.setUTCHours(0, 0, 0, 0);
      end.setUTCMonth(11, 31); end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    case 'last-year':
      start.setUTCFullYear(start.getUTCFullYear() - 1, 0, 1); start.setUTCHours(0, 0, 0, 0);
      end.setUTCFullYear(start.getUTCFullYear(), 11, 31); end.setUTCHours(23, 59, 59, 999);
      return { start, end };
    case 'past-N-days': {
      const n = captured ? parseInt(captured, 10) : NaN;
      if (!Number.isFinite(n) || n <= 0) return null;
      start.setUTCDate(start.getUTCDate() - n); start.setUTCHours(0, 0, 0, 0);
      return { start, end };
    }
  }
  return null;
}

/** Try to resolve an explicit date reference in the query. Uses UTC boundaries. */
function explicitWindow(query: string, now: Date): { start: Date; end: Date; trigger: string } | null {
  // "14 April 2026" or "April 14, 2026" (explicit day + month)
  const m = EXPLICIT_DATE_RE.exec(query);
  if (m) {
    const day = parseInt(m[1] || m[5] || '0', 10);
    const monthName = (m[2] || m[4] || '').toLowerCase();
    const yearStr = m[3] || m[6];
    const year = yearStr ? parseInt(yearStr, 10) : now.getUTCFullYear();
    const monthIdx = MONTH_NAMES.findIndex(mn => mn.toLowerCase() === monthName);
    if (day > 0 && day <= 31 && monthIdx >= 0) {
      const start = new Date(Date.UTC(year, monthIdx, day, 0, 0, 0, 0));
      const end = new Date(Date.UTC(year, monthIdx, day, 23, 59, 59, 999));
      return { start, end, trigger: m[0] };
    }
  }
  // "December 2024" or "December" alone → whole month
  const m2 = MONTH_RE.exec(query);
  if (m2) {
    const monthName = m2[1].toLowerCase();
    const monthIdx = MONTH_NAMES.findIndex(mn => mn.toLowerCase() === monthName);
    const yearStr = m2[2];
    const year = yearStr ? parseInt(yearStr, 10) : now.getUTCFullYear();
    if (monthIdx >= 0) {
      const start = new Date(Date.UTC(year, monthIdx, 1, 0, 0, 0, 0));
      const end = new Date(Date.UTC(year, monthIdx + 1, 0, 23, 59, 59, 999));
      return { start, end, trigger: m2[0] };
    }
  }
  // Bare year "2024"
  const yearOnly = /\b(20\d{2}|19\d{2})\b/.exec(query);
  if (yearOnly) {
    const year = parseInt(yearOnly[1], 10);
    const start = new Date(Date.UTC(year, 0, 1, 0, 0, 0, 0));
    const end = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));
    return { start, end, trigger: yearOnly[0] };
  }
  return null;
}

export function detectTemporalHint(query: string, now: Date = new Date()): TemporalHint {
  // 1. Explicit windows take priority (strongest signal)
  for (const { re, kind } of RELATIVE_WINDOW_MARKERS) {
    const m = re.exec(query);
    if (m) {
      const win = relativeWindow(kind, now, m[1]);
      if (win) return { kind: 'window', windowStart: win.start, windowEnd: win.end, trigger: m[0] };
    }
  }
  const explicit = explicitWindow(query, now);
  if (explicit) {
    return { kind: 'window', windowStart: explicit.start, windowEnd: explicit.end, trigger: explicit.trigger };
  }
  // 2. "Recent" / "oldest" adjectives without a specific window
  for (const re of RECENT_MARKERS) {
    const m = re.exec(query);
    if (m) return { kind: 'recent', trigger: m[0] };
  }
  for (const re of OLDEST_MARKERS) {
    const m = re.exec(query);
    if (m) return { kind: 'oldest', trigger: m[0] };
  }
  return { kind: 'none' };
}

// ─── Date parsing ────────────────────────────────────────────────────

/**
 * Parse document_date values that appear in the cognitive memory DB.
 * Formats seen in practice:
 *   - "2026-04-14T10:23:39.000Z"      (ISO)
 *   - "31 December 2024 10:26"
 *   - "Tuesday, April 14, 2026 10:32 AM"
 *   - "29 November 2024 15:26"
 * Returns null when unparseable.
 */
export function parseDocumentDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;

  // Try native parser first (handles ISO and many RFC-style dates)
  const native = new Date(trimmed);
  if (!isNaN(native.getTime())) return native;

  // "31 December 2024 10:26" — day + month name + year + HH:MM (treat as UTC)
  const dmy = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(trimmed);
  if (dmy) {
    const day = parseInt(dmy[1], 10);
    const monthIdx = MONTH_NAMES.findIndex(m => m.toLowerCase() === dmy[2].toLowerCase());
    const year = parseInt(dmy[3], 10);
    const hour = dmy[4] ? parseInt(dmy[4], 10) : 0;
    const min = dmy[5] ? parseInt(dmy[5], 10) : 0;
    if (monthIdx >= 0) {
      const d = new Date(Date.UTC(year, monthIdx, day, hour, min, 0));
      if (!isNaN(d.getTime())) return d;
    }
  }
  return null;
}

// ─── Boost computation ───────────────────────────────────────────────

/** Exponential decay giving newest docs the strongest boost. */
function recencyBoost(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
  // Steep curve: 0d -> 0.6, 30d -> ~0.33, 90d -> ~0.10, 180d -> ~0.03, 365d -> 0.006
  const b = 0.6 * Math.exp(-ageDays / 45);
  return Math.max(0, b);
}

/** Inverse decay — the older, the stronger (capped). */
function ancientBoost(ageDays: number, maxAgeDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
  if (maxAgeDays <= 0) return 0;
  const ratio = Math.min(1, ageDays / maxAgeDays);
  return 0.5 * ratio;
}

/** Modest default tilt — used when query has no temporal signal. */
function gentleTilt(ageDays: number): number {
  if (!Number.isFinite(ageDays) || ageDays < 0) return 0;
  if (ageDays <= 7) return 0.10;
  if (ageDays <= 30) return 0.05;
  if (ageDays <= 90) return 0.02;
  return 0;
}

export interface TemporalBoostResult {
  /** Score delta to add to the base/boosted score. Can be negative for window mismatches. */
  delta: number;
  /** Whether the document falls inside an explicit window (if hint.kind === 'window'). */
  insideWindow?: boolean;
}

/**
 * Compute the temporal boost for a single document.
 *
 * @param docDate   Parsed document date (pass null/undefined for "unknown" docs).
 * @param hint      Temporal hint from the query.
 * @param opts.maxAgeDaysForOldest  Used for 'oldest' boost scaling. Default 1000.
 * @param opts.now  Injection point for tests. Default: current time.
 */
export function computeTemporalBoost(
  docDate: Date | null | undefined,
  hint: TemporalHint,
  opts: { maxAgeDaysForOldest?: number; now?: Date } = {},
): TemporalBoostResult {
  if (!docDate) return { delta: 0 };
  const now = opts.now ?? new Date();
  const ageDays = (now.getTime() - docDate.getTime()) / (1000 * 60 * 60 * 24);

  switch (hint.kind) {
    case 'recent':
      return { delta: recencyBoost(ageDays) };
    case 'oldest':
      return { delta: ancientBoost(ageDays, opts.maxAgeDaysForOldest ?? 1000) };
    case 'window': {
      if (!hint.windowStart || !hint.windowEnd) return { delta: 0 };
      const inside = docDate >= hint.windowStart && docDate <= hint.windowEnd;
      if (inside) return { delta: 0.5, insideWindow: true };
      // Soft penalty for docs outside an explicit window — keeps them reachable
      // but lets in-window docs dominate.
      return { delta: -0.25, insideWindow: false };
    }
    case 'none':
    default:
      return { delta: gentleTilt(ageDays) };
  }
}

// ─── Public facade ───────────────────────────────────────────────────

export class TemporalRanker {
  /** Detect the query's temporal intent. */
  detect(query: string, now: Date = new Date()): TemporalHint {
    return detectTemporalHint(query, now);
  }

  /** Compute boost for a document (pass null docDate → 0 delta). */
  boost(
    docDate: Date | null | undefined,
    hint: TemporalHint,
    now: Date = new Date(),
  ): TemporalBoostResult {
    return computeTemporalBoost(docDate, hint, { now });
  }

  /** Convenience: parse a raw date string + compute boost. */
  boostFromString(
    docDateStr: string | null | undefined,
    hint: TemporalHint,
    now: Date = new Date(),
  ): TemporalBoostResult {
    return this.boost(parseDocumentDate(docDateStr), hint, now);
  }
}
