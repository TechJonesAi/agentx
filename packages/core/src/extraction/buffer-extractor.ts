/**
 * Buffer-based text extractor — the canonical extraction layer for AgentX.
 *
 * Why this exists rather than lifting silly-johnson's TextExtractor wholesale:
 *   silly's version takes a DocumentMetadata with a `file_path` field and
 *   calls readFileSync on it. Main's pipeline operates on Buffers (uploads,
 *   email bodies, email attachments). Coupling extraction to file paths
 *   would force every caller to write a temp file first.
 *
 *   This module preserves silly's algorithms (the pdf-parse / mammoth / msg /
 *   eml / html / json / xml / csv routing) but takes a Buffer + filename
 *   directly. Callers stay buffer-clean.
 *
 * Supported formats:
 *   - text/plain, text/markdown, text/csv, text/xml, application/json
 *   - application/pdf                  (via pdf-parse, lazy import)
 *   - application/vnd.openxml...wordprocessingml.document (DOCX, via mammoth)
 *   - text/html                        (regex strip — sufficient for
 *                                       email-body fallback; not full DOM)
 *   - message/rfc822 (EML)             (via mailparser, lazy import)
 *   - application/vnd.ms-outlook (MSG) (best-effort latin1 scan, copied
 *                                       from silly's lightweight CFB heuristic)
 *
 * NOT supported (clearly reported, never faked):
 *   - Scanned/image-only PDFs (would need tesseract.js OCR — not lifted)
 *   - PPTX, XLSX (silly uses xlsx lib; we omit until needed)
 *   - PST/OST email archives
 *   - Any binary format whose extraction returns empty text — status='partial'
 *     with a warning in the result, not status='success'.
 */

import { createLogger } from '../logger.js';

const log = createLogger('extraction:buffer');

export type ExtractionStatus = 'success' | 'partial' | 'failed' | 'unsupported';
export type ExtractionProvenance = 'native' | 'ocr' | 'unknown';

export interface BufferExtractionResult {
  text: string;
  fileType: string;       // 'pdf' | 'docx' | 'eml' | 'msg' | 'txt' | 'md' | 'html' | 'json' | 'csv' | 'xml' | 'bin'
  mimeType: string;
  contentType: string;    // 'document' | 'email' | 'note' (for the documents.content_type col)
  status: ExtractionStatus;
  provenance: ExtractionProvenance;
  pageCount: number;
  wordCount: number;
  warnings: string[];
  /** When EML/MSG: parsed email metadata (subject, from, etc.) */
  emailMetadata?: {
    from?: string;
    fromEmail?: string;
    to?: string;
    subject?: string;
    date?: Date;
  };
}

const TEXT_EXT = new Set(['txt', 'log']);
const MD_EXT = new Set(['md', 'markdown', 'mdx']);
const CSV_EXT = new Set(['csv', 'tsv']);
const JSON_EXT = new Set(['json']);
const XML_EXT = new Set(['xml']);
const HTML_EXT = new Set(['html', 'htm']);

function extOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot < 0 ? '' : filename.slice(dot + 1).toLowerCase();
}

function magicKind(buf: Buffer): string | null {
  if (buf.length >= 5 && buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d) return 'pdf'; // %PDF-
  // DOCX/XLSX/PPTX → ZIP magic 'PK\x03\x04'
  if (buf.length >= 4 && buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) return 'zip';
  // MSG → CFB magic 'D0 CF 11 E0 A1 B1 1A E1'
  if (buf.length >= 8 && buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0
      && buf[4] === 0xa1 && buf[5] === 0xb1 && buf[6] === 0x1a && buf[7] === 0xe1) return 'msg';
  return null;
}

function countWords(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Strip HTML to plain text. Removes <script>, <style>, and tags; collapses
 * whitespace. Sufficient for email-body HTML fallback. Not a full DOM parser.
 */
export function stripHtmlToText(html: string): string {
  return html
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractStringsFromJson(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const v of value) extractStringsFromJson(v, out);
  else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) extractStringsFromJson(v, out);
  }
  return out;
}

// ─── Per-format extractors (all take Buffer, return text) ──────────────────

async function extractPdf(buf: Buffer, warnings: string[]): Promise<{ text: string; pages: number; status: ExtractionStatus }> {
  try {
    // pdf-parse v2 exports a PDFParse class; instantiate then call getText()/getInfo().
    // (v1 exported a callable function — kept the v1 fallback path for back-compat
    // with older pinned versions.)
    const mod = await import('pdf-parse') as unknown as {
      PDFParse?: new (opts: { data: Buffer }) => {
        getText(): Promise<{ text?: string; pages?: Array<{ text?: string }> }>;
        getInfo(): Promise<{ numPages?: number; numpages?: number }>;
        destroy?(): void;
      };
      default?: (b: Buffer) => Promise<{ text: string; numpages: number }>;
    };

    if (mod.PDFParse) {
      // pdf-parse v2 wraps pdfjs which uses a worker with structured
      // cloning — concurrent method calls on the same instance throw
      // "Cannot transfer object of unsupported type". Call methods
      // sequentially against fresh instances.
      let text = '';
      let pages = 0;
      try {
        const parser = new mod.PDFParse({ data: buf });
        try {
          const r = await parser.getText();
          text = r.text ?? '';
          if (!text && Array.isArray(r.pages)) {
            text = r.pages.map((p) => p.text ?? '').join('\n\n');
          }
          pages = r.pages?.length ?? 0;
        } finally {
          try { parser.destroy?.(); } catch { /* ignore */ }
        }
      } catch (err) {
        warnings.push(`pdf-parse getText failed: ${err instanceof Error ? err.message : String(err)}`);
        return { text: '', pages: 0, status: 'failed' };
      }

      if (!text.trim()) {
        warnings.push(`PDF has ${pages || '?'} page(s) but no extractable text — likely scanned/image-only. OCR (tesseract.js) is not enabled.`);
        return { text: '', pages, status: 'partial' };
      }
      return { text, pages: pages || 1, status: 'success' };
    }

    // v1 fallback: callable default export
    if (typeof mod.default === 'function') {
      const parsed = await mod.default(buf);
      const text = parsed.text ?? '';
      const pages = parsed.numpages ?? 1;
      if (!text.trim()) {
        warnings.push(`PDF has ${pages} page(s) but no extractable text — likely scanned/image-only. OCR (tesseract.js) is not enabled.`);
        return { text: '', pages, status: 'partial' };
      }
      return { text, pages, status: 'success' };
    }

    warnings.push('pdf-parse module shape not recognised — neither PDFParse class nor callable default export present.');
    return { text: '', pages: 0, status: 'failed' };
  } catch (err) {
    warnings.push(`pdf-parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return { text: '', pages: 0, status: 'failed' };
  }
}

async function extractDocx(buf: Buffer, warnings: string[]): Promise<{ text: string; status: ExtractionStatus }> {
  try {
    const mod = (await import('mammoth')) as unknown as {
      extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }>;
    } & { default?: { extractRawText: (opts: { buffer: Buffer }) => Promise<{ value: string }> } };
    const mammoth = mod.default ?? mod;
    const result = await mammoth.extractRawText({ buffer: buf });
    const text = result.value || '';
    if (!text.trim()) {
      warnings.push('DOCX contains no extractable text');
      return { text: '', status: 'partial' };
    }
    return { text, status: 'success' };
  } catch (err) {
    warnings.push(`mammoth failed: ${err instanceof Error ? err.message : String(err)}`);
    return { text: '', status: 'failed' };
  }
}

/**
 * EML / message/rfc822 extraction via mailparser.
 * Returns body + parsed metadata. Handles HTML-only emails (falls back to
 * stripped html when text part is missing).
 */
async function extractEml(buf: Buffer, warnings: string[]): Promise<{
  text: string;
  status: ExtractionStatus;
  metadata: BufferExtractionResult['emailMetadata'];
}> {
  try {
    const mod = (await import('mailparser')) as unknown as {
      simpleParser: (src: Buffer) => Promise<{
        messageId?: string;
        from?: { value?: Array<{ name?: string; address?: string }>; text?: string };
        to?: { text?: string };
        subject?: string;
        date?: Date;
        text?: string;
        html?: string;
      }>;
    };
    const parsed = await mod.simpleParser(buf);
    const fromArr = parsed.from?.value?.[0];
    const metadata = {
      from: fromArr?.name ?? fromArr?.address ?? parsed.from?.text ?? undefined,
      fromEmail: fromArr?.address,
      to: parsed.to?.text,
      subject: parsed.subject,
      date: parsed.date,
    };
    let text = parsed.text ?? '';
    if (!text.trim() && parsed.html) {
      text = stripHtmlToText(parsed.html);
      warnings.push('EML had no text/plain part — body extracted from HTML fallback');
    }
    const headers: string[] = [];
    if (metadata.subject) headers.push(`Subject: ${metadata.subject}`);
    if (metadata.from) headers.push(`From: ${metadata.from}`);
    if (metadata.to) headers.push(`To: ${metadata.to}`);
    if (metadata.date) headers.push(`Date: ${metadata.date.toISOString()}`);
    const fullText = [headers.join('\n'), '', text.trim()].filter(Boolean).join('\n');
    return { text: fullText.trim(), status: fullText.trim() ? 'success' : 'partial', metadata };
  } catch (err) {
    warnings.push(`EML parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return { text: '', status: 'failed', metadata: undefined };
  }
}

/**
 * MSG (Outlook compound binary) — best-effort latin1 scan.
 * Copied from silly-johnson's lightweight heuristic. Not a full CFB parser;
 * pulls Subject/From/To/Date out of the binary plus the longest readable
 * segments as the body. Returns status='partial' when output is too short.
 */
function extractMsg(buf: Buffer, warnings: string[]): {
  text: string;
  status: ExtractionStatus;
  metadata: BufferExtractionResult['emailMetadata'];
} {
  try {
    const asciiText = buf
      .toString('latin1')
      .replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const subjectMatch = asciiText.match(/Subject:\s*(.{5,200})/i);
    const fromMatch = asciiText.match(/From:\s*(.{5,200})/i);
    const toMatch = asciiText.match(/To:\s*(.{5,200})/i);
    const dateMatch = asciiText.match(/Date:\s*(.{5,100})/i);

    const parts: string[] = [];
    const metadata: BufferExtractionResult['emailMetadata'] = {};
    if (subjectMatch) { parts.push(`Subject: ${subjectMatch[1].trim()}`); metadata.subject = subjectMatch[1].trim(); }
    if (fromMatch) { parts.push(`From: ${fromMatch[1].trim()}`); metadata.from = fromMatch[1].trim(); }
    if (toMatch) { parts.push(`To: ${toMatch[1].trim()}`); metadata.to = toMatch[1].trim(); }
    if (dateMatch) {
      parts.push(`Date: ${dateMatch[1].trim()}`);
      const parsedDate = new Date(dateMatch[1].trim());
      if (!isNaN(parsedDate.getTime())) metadata.date = parsedDate;
    }

    const segments = asciiText.split(/\s{5,}/).filter((s) => s.length > 50).sort((a, b) => b.length - a.length);
    if (segments.length > 0) {
      parts.push('');
      for (const seg of segments.slice(0, 3)) parts.push(seg.substring(0, 5000));
    }
    const text = parts.join('\n').trim();
    if (text.length < 20) {
      warnings.push('MSG file: insufficient readable text (CFB heuristic only — full Outlook parser not implemented)');
      return { text: '', status: 'partial', metadata };
    }
    return { text, status: 'success', metadata };
  } catch (err) {
    warnings.push(`MSG parse failed: ${err instanceof Error ? err.message : String(err)}`);
    return { text: '', status: 'failed', metadata: undefined };
  }
}

/**
 * Single entry point: classify + extract from a buffer.
 *
 * Magic-byte sniffing wins over filename extensions when both are available.
 * Returns a structured result with status, warnings, and (for emails)
 * parsed metadata that callers can use to populate document rows.
 */
export async function extractTextFromBuffer(
  buffer: Buffer,
  filename: string,
  mimeHint?: string,
): Promise<BufferExtractionResult> {
  const warnings: string[] = [];
  const ext = extOf(filename);
  const magic = magicKind(buffer);
  const lowerHint = (mimeHint ?? '').toLowerCase();

  // ── PDF
  if (magic === 'pdf' || ext === 'pdf' || lowerHint.includes('application/pdf')) {
    const r = await extractPdf(buffer, warnings);
    return {
      text: r.text, fileType: 'pdf', mimeType: 'application/pdf', contentType: 'document',
      status: r.status, provenance: 'native', pageCount: r.pages, wordCount: countWords(r.text), warnings,
    };
  }

  // ── DOCX (zip-magic + .docx ext or matching MIME)
  if ((magic === 'zip' && (ext === 'docx' || lowerHint.includes('wordprocessingml')))
      || (ext === 'docx')) {
    const r = await extractDocx(buffer, warnings);
    return {
      text: r.text, fileType: 'docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      contentType: 'document', status: r.status, provenance: 'native',
      pageCount: r.text ? 1 : 0, wordCount: countWords(r.text), warnings,
    };
  }

  // ── MSG (Outlook compound binary)
  if (magic === 'msg' || ext === 'msg' || lowerHint === 'application/vnd.ms-outlook') {
    const r = extractMsg(buffer, warnings);
    return {
      text: r.text, fileType: 'msg', mimeType: 'application/vnd.ms-outlook',
      contentType: 'email', status: r.status, provenance: 'native',
      pageCount: r.text ? 1 : 0, wordCount: countWords(r.text), warnings,
      emailMetadata: r.metadata,
    };
  }

  // ── EML
  if (ext === 'eml' || lowerHint === 'message/rfc822') {
    const r = await extractEml(buffer, warnings);
    return {
      text: r.text, fileType: 'eml', mimeType: 'message/rfc822',
      contentType: 'email', status: r.status, provenance: 'native',
      pageCount: r.text ? 1 : 0, wordCount: countWords(r.text), warnings,
      emailMetadata: r.metadata,
    };
  }

  // ── HTML
  if (HTML_EXT.has(ext) || lowerHint === 'text/html') {
    const text = stripHtmlToText(buffer.toString('utf8'));
    return {
      text, fileType: 'html', mimeType: 'text/html', contentType: 'document',
      status: text ? 'success' : 'partial', provenance: 'native',
      pageCount: text ? 1 : 0, wordCount: countWords(text), warnings,
    };
  }

  // ── JSON
  if (JSON_EXT.has(ext) || lowerHint === 'application/json') {
    try {
      const parsed = JSON.parse(buffer.toString('utf8')) as unknown;
      const text = extractStringsFromJson(parsed).join(' ');
      return {
        text, fileType: 'json', mimeType: 'application/json', contentType: 'document',
        status: 'success', provenance: 'native', pageCount: 1, wordCount: countWords(text), warnings,
      };
    } catch (err) {
      warnings.push(`JSON parse failed: ${err instanceof Error ? err.message : String(err)}`);
      // fall through to plain text
    }
  }

  // ── CSV / XML / TXT / MD — straight UTF-8
  if (CSV_EXT.has(ext) || lowerHint === 'text/csv') {
    const text = buffer.toString('utf8');
    return { text, fileType: ext, mimeType: 'text/csv', contentType: 'document',
      status: 'success', provenance: 'native', pageCount: 1, wordCount: countWords(text), warnings };
  }
  if (XML_EXT.has(ext) || lowerHint === 'application/xml' || lowerHint === 'text/xml') {
    const raw = buffer.toString('utf8');
    const text = raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { text, fileType: 'xml', mimeType: 'application/xml', contentType: 'document',
      status: 'success', provenance: 'native', pageCount: 1, wordCount: countWords(text), warnings };
  }
  if (MD_EXT.has(ext) || lowerHint === 'text/markdown') {
    const text = buffer.toString('utf8');
    return { text, fileType: 'md', mimeType: 'text/markdown', contentType: 'document',
      status: 'success', provenance: 'native', pageCount: 1, wordCount: countWords(text), warnings };
  }
  if (TEXT_EXT.has(ext) || lowerHint === 'text/plain') {
    const text = buffer.toString('utf8');
    return { text, fileType: ext || 'txt', mimeType: 'text/plain', contentType: 'document',
      status: 'success', provenance: 'native', pageCount: 1, wordCount: countWords(text), warnings };
  }

  // ── Unknown — best-effort UTF-8 (binary garbage detector)
  let asText = '';
  try {
    asText = buffer.toString('utf8');
    if (/[\x00-\x08\x0e-\x1f]/.test(asText.slice(0, 4096))) asText = '';
  } catch { /* ignore */ }
  warnings.push(`unsupported file kind for ${filename} (ext=${ext || '<none>'}, hint=${mimeHint ?? '<none>'}); ${asText ? 'best-effort UTF-8 fallback' : 'unreadable'}`);
  log.warn({ filename, ext, mimeHint }, 'unknown file kind');
  return {
    text: asText, fileType: 'bin', mimeType: 'application/octet-stream', contentType: 'document',
    status: asText ? 'partial' : 'unsupported', provenance: 'unknown',
    pageCount: asText ? 1 : 0, wordCount: countWords(asText), warnings,
  };
}
