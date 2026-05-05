/**
 * R9 — bounded excerpt extractor.
 *
 * Returns a window of `content` around the first occurrence of `phrase`
 * (case-insensitive). When the phrase isn't present, returns the first
 * `maxChars` of the content.
 *
 * Output is hard-capped — UI consumers must still escape on render.
 */

export interface SnippetResult {
  snippet: string;
  matchedPhrase?: string;
}

const ELLIPSIS = '…';

export function extractSnippet(
  content: string | null | undefined,
  phrase: string | null | undefined,
  maxChars = 240,
): SnippetResult {
  if (!content || typeof content !== 'string' || content.trim().length === 0) {
    return { snippet: '' };
  }
  // Normalise whitespace so snippets read cleanly in chips.
  const normalised = content.replace(/\s+/g, ' ').trim();

  // Phrase missing → return a leading slice
  if (!phrase || typeof phrase !== 'string' || phrase.trim().length === 0) {
    if (normalised.length <= maxChars) return { snippet: normalised };
    return { snippet: normalised.slice(0, maxChars) + ELLIPSIS };
  }

  const phraseTrim = phrase.trim();
  const phraseLower = phraseTrim.toLowerCase();
  const contentLower = normalised.toLowerCase();
  const idx = contentLower.indexOf(phraseLower);

  if (idx === -1) {
    if (normalised.length <= maxChars) return { snippet: normalised };
    return { snippet: normalised.slice(0, maxChars) + ELLIPSIS };
  }

  // Build a window around the match. Reserve ~half the budget on each side.
  const phraseLen = phraseTrim.length;
  const margin = Math.max(0, Math.floor((maxChars - phraseLen) / 2));
  const start = Math.max(0, idx - margin);
  const end = Math.min(normalised.length, idx + phraseLen + margin);

  let body = normalised.slice(start, end);
  if (start > 0) body = ELLIPSIS + body;
  if (end < normalised.length) body = body + ELLIPSIS;

  // Hard cap (allow up to maxChars + 2 for the leading/trailing ellipses)
  if (body.length > maxChars + 2) {
    body = body.slice(0, maxChars + 2);
  }

  // Preserve the original casing for the matched phrase
  const matchedPhrase = normalised.slice(idx, idx + phraseLen);

  return { snippet: body, matchedPhrase };
}
