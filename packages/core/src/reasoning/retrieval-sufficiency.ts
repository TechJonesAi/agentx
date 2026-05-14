/**
 * Universal retrieval-sufficiency heuristic.
 *
 * Decides whether the documents AgentX surfaced for a user query are
 * "sufficient" to answer it without external (web/search) tool use. This
 * is the runtime enforcement layer behind the private-memory-first
 * policy validated by the Batch A1 harness.
 *
 * Inputs are ONLY:
 *   - the user query string
 *   - the metadata produced by AgentX retrieval (match count + per-doc
 *     snippet/title/file_name/sender)
 *
 * No DB access, no LLM call, no embeddings. Purely deterministic so the
 * decision can be asserted in unit tests and replayed from a trace.
 *
 * Heuristic v1 (kept honest — semantic scoring is a follow-up):
 *   - matchCount must be > 0
 *   - extract content-bearing terms from the query (≥ 4 chars, no
 *     stopwords, lowercased)
 *   - for each retrieved doc, check whether its snippet / title /
 *     file_name / sender contains ≥ 1 of those terms
 *   - if at least one doc has a hit → sufficient=true with the matched
 *     terms and matched doc IDs surfaced; otherwise sufficient=false
 *   - When uncertain (e.g. degenerate query), prefer sufficient=false —
 *     never fake sufficiency.
 *
 * Returns a structured decision so callers can:
 *   - block network-class tools (Batch A2 policy)
 *   - log it (private-memory-events)
 *   - surface it in the UI / decision-trace endpoint
 *
 * Tests live at packages/core/tests/unit/retrieval-sufficiency.test.ts.
 */

export interface RetrievalDocLite {
  document_id: string;
  file_name?: string;
  title?: string;
  sender?: string | null;
  snippet?: string;
}

export interface RetrievalSufficiencyInput {
  query: string;
  retrievalMatchCount: number;
  retrievalDocuments: RetrievalDocLite[];
}

export interface RetrievalSufficiencyDecision {
  sufficient: boolean;
  reason:
    | 'no_match'
    | 'no_meaningful_terms'
    | 'no_term_overlap'
    | 'snippet_overlap'
    | 'title_or_filename_overlap';
  matchedDocumentIds: string[];
  matchedTerms: string[];
  /** 0..1 — fraction of retrieved docs that had at least one matching term. */
  score: number;
}

/**
 * Common stopwords (English-leaning, kept short on purpose). Anything ≤ 3
 * characters is also filtered, which removes most punctuation tokens and
 * short particles ("is", "of", "the") without an exhaustive list.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'what', 'when', 'where', 'which', 'who', 'whom', 'whose', 'why', 'how',
  'about', 'after', 'again', 'against', 'all', 'also', 'and', 'any',
  'are', 'because', 'been', 'before', 'being', 'below', 'between',
  'both', 'but', 'can', 'did', 'does', 'doing', 'down', 'during',
  'each', 'for', 'from', 'further', 'had', 'has', 'have', 'having',
  'her', 'here', 'hers', 'herself', 'him', 'himself', 'his', 'into',
  'just', 'more', 'most', 'myself', 'nor', 'not', 'now', 'off', 'once',
  'only', 'other', 'our', 'ours', 'ourselves', 'out', 'over', 'own',
  'same', 'she', 'should', 'some', 'such', 'than', 'that', 'the',
  'their', 'theirs', 'them', 'themselves', 'then', 'there', 'these',
  'they', 'this', 'those', 'through', 'too', 'under', 'until', 'very',
  'was', 'were', 'will', 'with', 'would', 'you', 'your', 'yours',
  'yourself', 'yourselves',
]);

/** Tokenize: lower-case, strip non-letter/digit, drop short/stopwords. */
export function extractQueryTerms(query: string): string[] {
  const raw = query
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    if (t.length < 4) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function tokensIn(text: string | null | undefined): Set<string> {
  if (!text) return new Set<string>();
  const s = new Set<string>();
  for (const t of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length >= 4) s.add(t);
  }
  return s;
}

export function assessRetrievalSufficiency(
  input: RetrievalSufficiencyInput,
): RetrievalSufficiencyDecision {
  if (input.retrievalMatchCount <= 0 || input.retrievalDocuments.length === 0) {
    return { sufficient: false, reason: 'no_match', matchedDocumentIds: [], matchedTerms: [], score: 0 };
  }

  const queryTerms = extractQueryTerms(input.query);
  if (queryTerms.length === 0) {
    return { sufficient: false, reason: 'no_meaningful_terms', matchedDocumentIds: [], matchedTerms: [], score: 0 };
  }
  const querySet = new Set(queryTerms);

  const matchedDocs: string[] = [];
  const allMatchedTerms = new Set<string>();
  let snippetOverlapSeen = false;

  for (const d of input.retrievalDocuments) {
    const snipTokens = tokensIn(d.snippet);
    const titleTokens = tokensIn(d.title);
    const fileTokens = tokensIn(d.file_name);
    const senderTokens = tokensIn(d.sender ?? null);

    const hitsHere: string[] = [];
    for (const t of querySet) {
      if (snipTokens.has(t)) { hitsHere.push(t); snippetOverlapSeen = true; }
      else if (titleTokens.has(t) || fileTokens.has(t) || senderTokens.has(t)) {
        hitsHere.push(t);
      }
    }
    if (hitsHere.length > 0) {
      matchedDocs.push(d.document_id);
      for (const t of hitsHere) allMatchedTerms.add(t);
    }
  }

  if (matchedDocs.length === 0) {
    return { sufficient: false, reason: 'no_term_overlap', matchedDocumentIds: [], matchedTerms: [], score: 0 };
  }

  const score = matchedDocs.length / Math.max(1, input.retrievalDocuments.length);
  return {
    sufficient: true,
    reason: snippetOverlapSeen ? 'snippet_overlap' : 'title_or_filename_overlap',
    matchedDocumentIds: matchedDocs,
    matchedTerms: [...allMatchedTerms],
    score,
  };
}
