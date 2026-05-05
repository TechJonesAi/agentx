/**
 * Local copy of `TextExtractor.cleanEmailBody` from silly-johnson's
 * `extraction/text-extractor.ts`.
 *
 * Inlined here so the email subsystem can be lifted in Phase B1 without
 * pulling in the (much larger) extraction subsystem, which is reserved for
 * a later phase. When `extraction/` is lifted, this file should be removed
 * and the call site can switch back to `TextExtractor.cleanEmailBody`.
 *
 * Behavioural parity with silly-johnson:
 *   - strips [imageN.ext] markers
 *   - strips "[X Description automatically generated]" blocks
 *   - strips HTML link artifacts <https://...>
 *   - collapses 4+ newlines to 3
 *   - trims trailing whitespace per line
 *   - trims leading blank lines + outer whitespace
 */
export function cleanEmailBody(raw: string): string {
  let text = raw;

  text = text.replace(/\[image\d+\.\w+\]/g, '');
  text = text.replace(/\[[^\]]*Description automatically generated[^\]]*\]/gi, '');
  text = text.replace(/<https?:\/\/[^>]+>/g, '');
  text = text.replace(/(\r?\n){4,}/g, '\n\n\n');
  text = text
    .split('\n')
    .map((line) => line.trimEnd())
    .join('\n');
  text = text.replace(/^\s*\n+/, '');

  return text.trim();
}
