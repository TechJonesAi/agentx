/**
 * Email-focus query detector.
 *
 * Phase B3 lift: silly-johnson's `isEmailFocusedQuery` lives inside its
 * (heavily-modified) reasoning/decision-engine.ts. To avoid a three-way
 * merge of decision-engine in this phase, the regex constants and the
 * detection function are inlined here as a small helper, and
 * memory/knowledge-augmenter.ts imports from here instead.
 *
 * When the decision-engine three-way merge happens later, this file should
 * be removed and knowledge-augmenter should import from decision-engine.
 *
 * Behavioural parity with silly's version is byte-for-byte (regexes copied
 * verbatim from claude/silly-johnson:packages/core/src/reasoning/decision-engine.ts).
 */

/** Email-object words — the clearest signal */
const EMAIL_OBJECT_RE = /\b(emails?|e-mails?|inbox)\b/i;
/** Attachment words — strong signal when combined with retrieval/recency */
const ATTACHMENT_OBJECT_RE = /\b(attachments?|attached\s+files?)\b/i;
/** Message words — weaker than "email", needs support from other signals */
const MESSAGE_OBJECT_RE = /\b(messages?)\b/i;

/** Sender cues — "from <person>", email addresses */
const SENDER_CUE_RE = /\b(from\s+\w+|sent\s+by\s+\w+)\b|\w+@\w+\.\w+/i;
/** Recency cues — time-bounded queries */
const RECENCY_CUE_RE =
  /\b(today'?s?|yesterday'?s?|latest|recently?|this\s+(?:week|morning|month)|last\s+(?:week|night|month)|new|tonight|came\s+in)\b/i;
/** Retrieval verbs — user wants to see/summarise/query content */
const RETRIEVAL_VERB_RE =
  /\b(summarise|summarize|summary|show\s+me|(?:what\s+)?did\s+I\s+(?:get|got|receive|received)|what\s+(?:came|arrived)|what\s+(?:do|does|did)\s+(?:they|it|my)\s+say|what\s+evidence|what\s+(?:was|were)\s+(?:sent|received)|I\s+(?:received|got|sent))\b/i;
/** Advice framing — user is reasoning over email content */
const ADVICE_FRAME_RE =
  /\b(based\s+on\s+(?:my\s+|the\s+)?(?:emails?|messages?|inbox)|how\s+can\s+I\s+use\s+(?:them|this|the\s+emails?)|what\s+are\s+your\s+thoughts\s+on\s+(?:them|this|the\s+emails?))\b/i;

/**
 * Detect whether a query is explicitly focused on emails/email content.
 *
 * Conservative signal-based approach:
 *   - EMAIL_OBJECT alone → true  (the word "email" is unambiguous)
 *   - ATTACHMENT_OBJECT + (RECENCY | RETRIEVAL | SENDER) → true
 *   - MESSAGE_OBJECT + (RECENCY | SENDER) + RETRIEVAL → true (3-signal)
 *   - ADVICE_FRAME → true (already contains "email" reference in its patterns)
 *   - Anything else → false
 */
export function isEmailFocusedQuery(query: string): boolean {
  if (EMAIL_OBJECT_RE.test(query)) return true;
  if (ADVICE_FRAME_RE.test(query)) return true;

  if (ATTACHMENT_OBJECT_RE.test(query)) {
    if (
      RECENCY_CUE_RE.test(query) ||
      RETRIEVAL_VERB_RE.test(query) ||
      SENDER_CUE_RE.test(query)
    ) {
      return true;
    }
  }

  if (MESSAGE_OBJECT_RE.test(query)) {
    let supportCount = 0;
    if (RECENCY_CUE_RE.test(query)) supportCount++;
    if (SENDER_CUE_RE.test(query)) supportCount++;
    if (RETRIEVAL_VERB_RE.test(query)) supportCount++;
    if (supportCount >= 2) return true;
  }

  return false;
}
