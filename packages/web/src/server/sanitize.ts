/**
 * Text sanitizers for assistant output.
 * Shared between the embedded UI (template literal) and server-side tripwire.
 * The embedded HTML duplicates these regexes inline; this module is the testable source of truth.
 */

/** Remove tool-call markup from assistant text. */
export function stripToolMarkup(text: string): string {
  // <TAG>{...name...arguments...}</TAG>
  text = text.replace(/<\w+>\s*\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\}\s*<\/\w+>/g, '');
  // [Tool Call] {...} or [Tool_Call] {...} — consume trailing } from nested JSON
  text = text.replace(/\[Tool[\s_]?Call\]\s*\{[\s\S]*?"name"[\s\S]*?\}(?:\s*\})*/gi, '');
  // [Tool Result]: ... (rest of line)
  text = text.replace(/\[Tool[\s_]?Result\]:?[^\n]*/gi, '');
  // code blocks containing tool-call JSON
  text = text.replace(/```(?:json)?\s*\{[\s\S]*?"name"[\s\S]*?"arguments"[\s\S]*?\}\s*```/g, '');
  // Stray closing fragments: }</TOOL_CALL>, }</TAG>
  text = text.replace(/\}\s*<\/\w+>/g, '');
  // Orphan opening/closing XML-style tool tags
  text = text.replace(/<\/?(?:TOOL_CALL|TOOL_RESULT|tool_call|tool_result)>/g, '');
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

const STAGE_CUES =
  /(?:tone|voice|paus|chuckl|laugh|sigh|whisper|murmur|soft|quiet|warm|earnest|lower|raise|resolute|somber|gentle|calm|emphas|spoken|tender|breath|clear|serious|excited|slow|trail)/i;

/** Remove stage-direction parentheticals from assistant text. */
export function stripStageDirections(text: string): string {
  // Standalone lines
  text = text.replace(/^\s*\([^)]{1,60}\)\s*$/gm, '');
  // Inline cue-word parentheticals
  text = text.replace(/\(([^)]{1,60})\)/g, (_m, inner: string) => {
    const s = inner.toLowerCase().trim();
    if (/[0-9/:@=]|http/.test(s)) return _m;
    if (STAGE_CUES.test(s)) return '';
    return _m;
  });
  return text.replace(/ {2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/** Full sanitization pipeline for speech output. */
export function sanitizeForSpeech(text: string): string {
  let s = stripToolMarkup(text);
  s = stripStageDirections(s);
  s = s.replace(/<\/?(?:TOOL_|tool_)[^>]*>/g, '');
  return s.trim();
}

/** Check whether text contains likely stage directions. Returns matched fragments. */
export function detectStageDirections(text: string): string[] {
  const hits: string[] = [];
  // Standalone lines
  const standalone = text.match(/^\s*\([^)]{1,60}\)\s*$/gm);
  if (standalone) hits.push(...standalone.map((s) => s.trim()));
  // Inline cue-word matches
  const inline = text.matchAll(/\(([^)]{1,60})\)/g);
  for (const m of inline) {
    const s = m[1].toLowerCase().trim();
    if (/[0-9/:@=]|http/.test(s)) continue;
    if (STAGE_CUES.test(s)) hits.push(m[0]);
  }
  return hits;
}
