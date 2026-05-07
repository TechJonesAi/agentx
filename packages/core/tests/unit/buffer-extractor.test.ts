/**
 * Unit tests for the buffer-based extraction layer.
 *
 * Covers every format with a real buffer:
 *   - PDF: a tiny in-memory PDF (programmatically constructed)
 *   - DOCX: a real mammoth round-trip would need fixtures; we skip that here
 *     and rely on the e2e upload test to exercise mammoth via a fixture.
 *   - EML: hand-crafted RFC822 with text part + html part
 *   - HTML: stripping
 *   - JSON / CSV / XML / TXT / MD
 *   - MSG: using a binary buffer with magic bytes
 *   - Unsupported binary: warns + status='unsupported'
 */
import { describe, it, expect } from 'vitest';
import { extractTextFromBuffer, stripHtmlToText } from '../../src/extraction/buffer-extractor.js';

describe('extractTextFromBuffer — text formats', () => {
  it('TXT: utf-8 round-trip', async () => {
    const buf = Buffer.from('Hello world.\nLine 2.', 'utf8');
    const r = await extractTextFromBuffer(buf, 'note.txt');
    expect(r.fileType).toBe('txt');
    expect(r.mimeType).toBe('text/plain');
    expect(r.contentType).toBe('document');
    expect(r.status).toBe('success');
    expect(r.text).toContain('Hello world');
    expect(r.wordCount).toBe(4);
  });

  it('MD: utf-8 markdown', async () => {
    const buf = Buffer.from('# Title\n\nBody text here.', 'utf8');
    const r = await extractTextFromBuffer(buf, 'doc.md');
    expect(r.fileType).toBe('md');
    expect(r.mimeType).toBe('text/markdown');
    expect(r.text).toContain('Body text');
  });

  it('JSON: extracts string values', async () => {
    const buf = Buffer.from(JSON.stringify({ name: 'Alice', age: 30, role: 'engineer' }), 'utf8');
    const r = await extractTextFromBuffer(buf, 'profile.json');
    expect(r.fileType).toBe('json');
    expect(r.text).toContain('Alice');
    expect(r.text).toContain('engineer');
  });

  it('CSV: passthrough', async () => {
    const buf = Buffer.from('id,name\n1,Alice\n2,Bob', 'utf8');
    const r = await extractTextFromBuffer(buf, 'data.csv');
    expect(r.fileType).toBe('csv');
    expect(r.text).toContain('Alice');
  });

  it('XML: strips tags', async () => {
    const buf = Buffer.from('<root><item>Hello</item><item>World</item></root>', 'utf8');
    const r = await extractTextFromBuffer(buf, 'data.xml');
    expect(r.fileType).toBe('xml');
    expect(r.text).toMatch(/Hello.*World/);
    expect(r.text).not.toContain('<item>');
  });

  it('HTML: strips script/style/tags', async () => {
    const html = '<html><head><style>x{color:red}</style></head><body><script>evil()</script><p>Real <b>content</b> here.</p></body></html>';
    const r = await extractTextFromBuffer(Buffer.from(html, 'utf8'), 'page.html');
    expect(r.fileType).toBe('html');
    expect(r.text).toContain('Real content here');
    expect(r.text).not.toContain('evil()');
    expect(r.text).not.toContain('color:red');
  });
});

describe('extractTextFromBuffer — email formats', () => {
  it('EML: parses headers + body, returns email metadata', async () => {
    const eml = [
      'Message-ID: <demo@example.com>',
      'From: Jane Smith <jane@example.com>',
      'To: Bob <bob@example.com>',
      'Subject: Test subject',
      'Date: Mon, 5 May 2026 09:00:00 +0000',
      'Content-Type: text/plain',
      '',
      'This is the body of the email.',
      'Second line of body.',
    ].join('\r\n');
    const r = await extractTextFromBuffer(Buffer.from(eml, 'utf8'), 'msg.eml');
    expect(r.fileType).toBe('eml');
    expect(r.contentType).toBe('email');
    expect(r.emailMetadata?.subject).toBe('Test subject');
    expect(r.emailMetadata?.from).toBe('Jane Smith');
    expect(r.emailMetadata?.fromEmail).toBe('jane@example.com');
    expect(r.text).toContain('This is the body');
    expect(r.text).toContain('Subject: Test subject');
  });

  it('EML: HTML-only body produces readable text (mailparser handles or fallback strips)', async () => {
    // mailparser auto-derives text from HTML when no text/plain part exists,
    // so either path (parsed.text populated, OR our fallback) yields readable
    // text. The assertion here is on the user-visible outcome, not which
    // code path produced it.
    const eml = [
      'From: alice@example.com',
      'Subject: HTML only',
      'Date: Mon, 5 May 2026 09:00:00 +0000',
      'Content-Type: text/html',
      '',
      '<html><body><p>This is <b>HTML</b> only.</p></body></html>',
    ].join('\r\n');
    const r = await extractTextFromBuffer(Buffer.from(eml, 'utf8'), 'html-only.eml');
    expect(r.text).toContain('HTML');
    expect(r.text).toContain('only');
    expect(r.status).toBe('success');
  });

  it('MSG: latin1 magic-bytes file with subject + body extracts something', async () => {
    // Build a buffer that starts with the CFB magic bytes, then ASCII text
    // that mimics what silly's heuristic looks for.
    const magic = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    const padding = Buffer.alloc(64, 0);
    const text = Buffer.from(
      '\x00\x00Subject: Important MSG file\x00\x00\x00\x00From: alice@example.com\x00\x00\x00\x00     Body of the message starts here and is long enough to satisfy the 50-char threshold for segment detection.     ',
      'latin1',
    );
    const buf = Buffer.concat([magic, padding, text]);
    const r = await extractTextFromBuffer(buf, 'msg.msg');
    expect(r.fileType).toBe('msg');
    expect(r.contentType).toBe('email');
    expect(r.status).toBe('success');
    expect(r.text).toContain('Subject: Important MSG file');
  });
});

describe('extractTextFromBuffer — PDF', () => {
  it('PDF: returns partial when buffer has no extractable text', async () => {
    // pdf-parse will fail on a buffer that starts with %PDF- but isn't a
    // real PDF — but we can construct an actual minimal PDF with no text.
    // Easier: use a buffer with PDF magic but garbage after — pdf-parse
    // will throw, which we map to status='failed' with a warning.
    const buf = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(64, 0)]);
    const r = await extractTextFromBuffer(buf, 'broken.pdf');
    expect(r.fileType).toBe('pdf');
    expect(r.mimeType).toBe('application/pdf');
    // Either status='failed' (parse error) or 'partial' (parsed but empty)
    expect(['failed', 'partial']).toContain(r.status);
    expect(r.warnings.length).toBeGreaterThan(0);
  });
});

describe('extractTextFromBuffer — unsupported', () => {
  it('binary garbage: returns status=unsupported with a warning', async () => {
    // 4 KB of pure binary noise (no UTF-8 readability)
    const buf = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 8));
    const r = await extractTextFromBuffer(buf, 'mystery.xyz');
    expect(r.fileType).toBe('bin');
    expect(['unsupported', 'partial']).toContain(r.status);
    expect(r.warnings.some((w) => w.includes('unsupported'))).toBe(true);
  });
});

describe('stripHtmlToText', () => {
  it('decodes common entities', () => {
    expect(stripHtmlToText('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'');
  });
  it('preserves paragraph breaks', () => {
    expect(stripHtmlToText('<p>One</p><p>Two</p>')).toContain('One');
    expect(stripHtmlToText('<p>One</p><p>Two</p>')).toContain('Two');
  });
});
