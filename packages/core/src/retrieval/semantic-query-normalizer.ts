/**
 * R12 — Semantic query normalizer.
 *
 * Strips a small list of English stop words from a natural-language query
 * before it's passed to FTS5 MATCH, so questions like
 *   "What documents are about HR escalation and payroll issues?"
 * normalize to
 *   `hr escalation payroll`
 * and survive FTS5's default AND-of-tokens semantics.
 *
 * Rules:
 *   - case-insensitive stop-word match (output is lowercase)
 *   - quoted phrases preserved verbatim (re-emitted with double quotes
 *     so FTS5 treats them as phrase tokens)
 *   - punctuation other than quotes is stripped
 *   - empty result → caller falls back to the raw query
 *
 * Used ONLY in handleSemanticSearch. COUNT, EXACT_SEARCH, FILTERED_SEARCH,
 * and ANALYTICAL paths are unchanged.
 */

const STOP_WORDS: ReadonlySet<string> = new Set([
  // Articles / determiners
  'a', 'an', 'the', 'this', 'these', 'those', 'that', 'those',
  // Pronouns
  'i', 'me', 'my', 'mine', 'we', 'us', 'our', 'ours',
  'you', 'your', 'yours', 'he', 'him', 'his', 'she', 'her', 'hers',
  'it', 'its', 'they', 'them', 'their', 'theirs',
  // Linking verbs / aux
  'is', 'am', 'are', 'was', 'were', 'be', 'been', 'being',
  'do', 'does', 'did', 'doing', 'done',
  'have', 'has', 'had', 'having',
  'will', 'would', 'shall', 'should', 'can', 'could', 'may', 'might', 'must',
  // Conjunctions
  'and', 'or', 'but', 'nor', 'so', 'yet', 'as', 'if', 'than',
  // Prepositions
  'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'to', 'into', 'onto',
  'about', 'against', 'between', 'through', 'during', 'before', 'after',
  'above', 'below', 'over', 'under',
  // Wh-words
  'what', 'which', 'who', 'whom', 'when', 'where', 'why', 'how',
  // Common conversational verbs
  'tell', 'show', 'give', 'find', 'search', 'list', 'see',
  // Politeness / fillers
  'please', 'kindly', 'just', 'really', 'maybe',
  // Generic doc/file references
  'document', 'documents', 'doc', 'docs', 'file', 'files',
  'information', 'info', 'data',
  'thing', 'things', 'stuff',
  // Quantifiers
  'some', 'any', 'all', 'every', 'each', 'many', 'much', 'few', 'several',
  'more', 'most', 'less', 'least',
  // Negations / misc
  'not', 'no',
  // Question-end nouns we don't want to require
  'issue', 'issues', 'question', 'questions', 'matter', 'matters',
  // Other very common
  'there', 'here', 'now', 'then', 'so', 'too', 'very',
]);

const QUOTE_PLACEHOLDER_RE = /^__qph(\d+)__$/;

export function normalizeSemanticQuery(query: string | null | undefined): string {
  if (!query || typeof query !== 'string') return '';
  const trimmed = query.trim();
  if (trimmed.length === 0) return '';

  // Step 1: extract quoted phrases — preserved verbatim later
  const quoted: string[] = [];
  let placeholderIdx = 0;
  const withPlaceholders = trimmed.replace(/"([^"]+)"|'([^']+)'/g, (_match, dq: string | undefined, sq: string | undefined) => {
    const inner = (dq ?? sq ?? '').trim();
    if (inner.length === 0) return '';
    quoted.push(inner);
    const ph = `__qph${placeholderIdx++}__`;
    return ` ${ph} `;
  });

  // Step 2: lowercase, strip non-word characters (preserve underscores for placeholders)
  const cleaned = withPlaceholders.toLowerCase().replace(/[^\w\s]/g, ' ');

  // Step 3: tokenize and filter stop words (placeholders pass through)
  const tokens = cleaned.split(/\s+/).filter((t) => {
    if (t.length === 0) return false;
    if (QUOTE_PLACEHOLDER_RE.test(t)) return true;
    return !STOP_WORDS.has(t);
  });

  // Step 4: re-substitute quoted phrases with FTS5 phrase syntax (double quotes)
  const out: string[] = [];
  for (const t of tokens) {
    const m = t.match(QUOTE_PLACEHOLDER_RE);
    if (m) {
      const idx = Number(m[1]);
      const phrase = quoted[idx];
      if (phrase) out.push(`"${phrase.replace(/"/g, '""')}"`);
    } else {
      out.push(t);
    }
  }

  return out.join(' ').trim();
}
