/**
 * Local date parser for email headers.
 *
 * Extracted from `retrieval/temporal-ranker.ts` (which lives only on
 * claude/silly-johnson) so that lifting the email subsystem does not
 * require lifting the retrieval module — keeping R1–R12 retrieval
 * untouched per the Phase B1 scope.
 *
 * Equivalent to silly-johnson's `parseDocumentDate`:
 *  - tries native Date parsing first (covers ISO, RFC2822, etc.)
 *  - falls back to "DD MonthName YYYY [HH:MM]" treated as UTC
 *  - returns null for unparseable / empty input
 */

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export function parseDocumentDate(s: string | null | undefined): Date | null {
  if (!s) return null;
  const trimmed = s.trim();
  if (!trimmed) return null;

  const native = new Date(trimmed);
  if (!isNaN(native.getTime())) return native;

  const dmy = /^(\d{1,2})\s+([A-Za-z]+)\s+(\d{4})(?:\s+(\d{1,2}):(\d{2}))?/.exec(trimmed);
  if (dmy) {
    const day = parseInt(dmy[1], 10);
    const monthIdx = MONTH_NAMES.findIndex((m) => m.toLowerCase() === dmy[2].toLowerCase());
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
