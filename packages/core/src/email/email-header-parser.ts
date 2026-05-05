/**
 * Email header parser — extracts canonical metadata (sender, send date, subject)
 * from plain-text email content as stored in AgentX cognitive memory.
 *
 * We see two formats in the wild:
 *
 * 1. Our own email-ingestion-service output (ingestEmailBody):
 *      Subject: Re: Dartford phones
 *      From: moyesr@arriva.co.uk
 *      Date: 2024-11-29T15:26:00.000Z
 *
 *      <body...>
 *
 * 2. Forwarded / uploaded evidence emails:
 *      From: Robert Moyes <moyesr@arriva.co.uk>
 *      Sent: 29 November 2024 15:26
 *      To: Darren Jones
 *      Subject: RE: Brixton - Storm phone issue resolved
 *
 *      <body...>
 *
 * Returns best-effort values — null when a field can't be extracted.
 * Never throws.
 */

import { parseDocumentDate } from './parse-date.js';

/** A single From/Sent block found anywhere in an email's content. */
export interface ForwardedChainEntry {
  sender: string | null;
  sentDate: Date | null;
  sentDateIso: string | null;
  /** Character offset in the content where the From: line starts. */
  offset: number;
}

export interface ParsedEmailHeaders {
  /** Actual send date (Date object) or null. */
  sentDate: Date | null;
  /** ISO string of sentDate, ready for DB write. */
  sentDateIso: string | null;
  /** From field — email address preferred, otherwise display name. */
  sender: string | null;
  /** Subject line, trimmed. */
  subject: string | null;
  /**
   * Full chain of From/Sent blocks found in the content, in document order.
   * chain[0] is the outer/most-recent (same as `sender`/`sentDate`).
   * chain[chain.length - 1] is the original/first email.
   * For non-forwarded emails this has a single entry.
   */
  chain: ForwardedChainEntry[];
  /**
   * The ORIGINAL (primary) sender of the email thread — the person who
   * started the conversation. This is the most useful for "latest email
   * from Rob" style queries where you want attribution to the actual
   * originator, not the forwarder.
   */
  originalSender: string | null;
  originalSentDate: Date | null;
  originalSentDateIso: string | null;
}

/** Try to pull an email address out of a "From:" string like "Robert Moyes <moyesr@arriva.co.uk>". */
function extractEmailAddress(s: string): string | null {
  if (!s) return null;
  const m = s.match(/<([^>@\s]+@[^>\s]+)>/);
  if (m) return m[1].trim();
  const m2 = s.match(/\b([A-Za-z0-9._+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
  if (m2) return m2[1].trim();
  return null;
}

/**
 * Extract the best "sender" identifier — combines display name AND email
 * address (lowercase) so substring lookups work for both nicknames and
 * address prefixes. Examples:
 *   "Robert Moyes <moyesr@arriva.co.uk>" → "robert moyes moyesr@arriva.co.uk"
 *   "moyesr@arriva.co.uk"                → "moyesr@arriva.co.uk"
 *   "Robert Moyes"                        → "robert moyes"
 *
 * This lets a query for "rob" match the display-name portion even when
 * the email prefix is unrelated (e.g. "moyesr" doesn't contain "rob").
 */
function parseSender(fromLine: string | undefined): string | null {
  if (!fromLine) return null;
  const trimmed = fromLine.trim();
  if (!trimmed) return null;

  const email = extractEmailAddress(trimmed);
  // Strip the email/angle-brackets from the line to isolate the display name
  const displayName = trimmed
    .replace(/<[^>]*>/g, '')                                    // remove <email@domain>
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '')                   // remove bare email
    .replace(/[,;]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  const parts: string[] = [];
  if (displayName) parts.push(displayName);
  if (email) parts.push(email.toLowerCase());

  if (parts.length === 0) return null;
  // Deduplicate — e.g. when trimmed === email
  const joined = parts.join(' ');
  return joined || null;
}

/**
 * Scan the entire content for every "From X" block.
 * Captures the inline-forwarded email chain typical of threaded messages.
 *
 * Supports two header styles:
 *   Style A (standard):  "From: <sender>" / "Sent: <date>" / "Date: <date>"
 *   Style B (Outlook PDF export): "From <sender>" / "Date <date>" / "To <recipients>"
 *     — no colons, printed from Outlook "Save as PDF"
 *
 * Returns entries in document order: first entry is the outermost/most-recent,
 * subsequent entries are quoted/forwarded content with older dates.
 */
function extractChain(content: string): ForwardedChainEntry[] {
  const chain: ForwardedChainEntry[] = [];
  // Match EITHER:
  //   "From:<space|tab>value"  (standard colon form)
  //   "From<space>value<EOL>" followed by a "Date "/"Sent " line (Outlook PDF form)
  // The second form only matches when the word after "From" starts with a
  // capital letter or quote (to avoid false positives on "from the" etc.)
  const fromRe = /^\s*From(?::[\s\t]+|\s+(?=[A-Z"']))([^\r\n]+)/gm;
  let m: RegExpExecArray | null;
  while ((m = fromRe.exec(content)) !== null) {
    const fromLine = m[1];
    const senderStr = parseSender(fromLine);
    const offset = m.index;
    // Look for Sent:/Date:/Sent /Date (either form) in the ~400 chars following
    const tail = content.slice(m.index, m.index + 400);
    const dateMatch = tail.match(/\b(?:Sent|Date)(?::[\s\t]+|\s+(?=[A-Z0-9]))([^\r\n]+)/i);
    let sentDate: Date | null = null;
    if (dateMatch) {
      sentDate = parseDocumentDate(dateMatch[1].trim());
    }
    chain.push({
      sender: senderStr,
      sentDate,
      sentDateIso: sentDate ? sentDate.toISOString() : null,
      offset,
    });
  }
  return chain;
}

/**
 * Extract Subject / From / Date/Sent from a document, plus the full
 * forwarded chain. Order-agnostic for the outer headers.
 */
export function parseEmailHeaders(content: string): ParsedEmailHeaders {
  const result: ParsedEmailHeaders = {
    sentDate: null,
    sentDateIso: null,
    sender: null,
    subject: null,
    chain: [],
    originalSender: null,
    originalSentDate: null,
    originalSentDateIso: null,
  };
  if (!content || typeof content !== 'string') return result;

  // Look at the first block — emails put headers at the top
  const head = content.slice(0, 1200);

  // ─── From: (or Outlook "From " without colon) ────────────────
  const fromMatch = head.match(/^\s*From(?::\s*|\s+(?=[A-Z"']))([^\r\n]+)/im);
  if (fromMatch) {
    result.sender = parseSender(fromMatch[1]);
  }

  // ─── Subject: ──────────────────────────────────────────────────
  const subjMatch = head.match(/^\s*Subject(?::\s*|\s+(?=[A-Z"']))([^\r\n]+)/im);
  if (subjMatch) {
    result.subject = subjMatch[1].trim() || null;
  }

  // ─── Date / Sent: ──────────────────────────────────────────────
  // Try "Date: <value>" first (our ingestion format uses ISO).
  // Also accept "Date <value>" (Outlook PDF export format).
  const dateMatch = head.match(/^\s*Date(?::\s*|\s+(?=[A-Z0-9]))([^\r\n]+)/im);
  if (dateMatch) {
    const parsed = parseDocumentDate(dateMatch[1].trim());
    if (parsed) {
      result.sentDate = parsed;
      result.sentDateIso = parsed.toISOString();
    }
  }
  // If Date missing or unparseable, try "Sent: <value>" (or "Sent <value>")
  if (!result.sentDate) {
    const sentMatch = head.match(/^\s*Sent(?::\s*|\s+(?=[A-Z0-9]))([^\r\n]+)/im);
    if (sentMatch) {
      const parsed = parseDocumentDate(sentMatch[1].trim());
      if (parsed) {
        result.sentDate = parsed;
        result.sentDateIso = parsed.toISOString();
      }
    }
  }

  // ─── Forwarded chain ───────────────────────────────────────────
  // Scan the entire content for all From/Sent blocks
  result.chain = extractChain(content);

  // The ORIGINAL sender is the deepest entry in the chain — the person
  // who wrote the earliest email still visible in the thread. Pick the
  // entry with the oldest parseable date, or the last entry if no dates.
  if (result.chain.length > 0) {
    const withDates = result.chain.filter(e => e.sentDate);
    if (withDates.length > 0) {
      withDates.sort((a, b) => a.sentDate!.getTime() - b.sentDate!.getTime());
      const oldest = withDates[0];
      result.originalSender = oldest.sender;
      result.originalSentDate = oldest.sentDate;
      result.originalSentDateIso = oldest.sentDateIso;
    } else {
      // No parseable dates — fall back to last chain entry (typically deepest)
      const last = result.chain[result.chain.length - 1];
      result.originalSender = last.sender;
    }
  }

  return result;
}

/**
 * Detect whether a document's content looks like an email.
 * Used by the ingest endpoint to decide whether to run the header parser.
 */
export function looksLikeEmail(content: string, fileName?: string): boolean {
  if (fileName) {
    if (/^email[-_]/i.test(fileName)) return true;
    if (/\.(eml|msg)$/i.test(fileName)) return true;
  }
  if (!content) return false;
  const head = content.slice(0, 500);
  // Accept BOTH standard "From: X" and Outlook PDF form "From X" (no colon).
  const hasFrom = /^\s*From(?::\s+|\s+(?=[A-Z"']))[^\r\n]+/im.test(head);
  if (!hasFrom) return false;
  return /^\s*(Subject|Sent|Date)(?::\s+|\s+(?=[A-Z0-9]))[^\r\n]+/im.test(head);
}
