/**
 * Minimal multipart/form-data parser.
 *
 * Why custom rather than busboy: keeps @agentx/web's dependency surface
 * tiny. We only need file uploads with optional text fields — not the full
 * spec (encodings, nested parts, etc.). This handles:
 *   - boundary detection from Content-Type
 *   - multiple parts (file + text fields mixed)
 *   - filename / Content-Type per file part
 *   - returns Buffer for files (preserves binary fidelity for PDFs, etc.)
 *
 * Throws on malformed input. Caller is responsible for size limits — use
 * a request-size cap before calling parseMultipartBody (we cap at 25 MB
 * inside the route handler by default).
 */

import type { IncomingMessage } from 'node:http';

export interface MultipartFilePart {
  fieldName: string;
  filename: string;
  contentType: string;
  data: Buffer;
}

export interface MultipartFieldPart {
  fieldName: string;
  value: string;
}

export interface ParsedMultipart {
  files: MultipartFilePart[];
  fields: Record<string, string>;
}

export class MultipartError extends Error {
  constructor(message: string, public status: number = 400) {
    super(message);
    this.name = 'MultipartError';
  }
}

function parseHeaders(headerBlock: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of headerBlock.split('\r\n')) {
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const k = line.slice(0, colon).trim().toLowerCase();
    const v = line.slice(colon + 1).trim();
    headers[k] = v;
  }
  return headers;
}

function parseContentDisposition(value: string): { name?: string; filename?: string } {
  const out: { name?: string; filename?: string } = {};
  // Naive parse — handles `form-data; name="x"; filename="y"`
  const re = /(\w+)\s*=\s*"([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m[1] === 'name') out.name = m[2];
    if (m[1] === 'filename') out.filename = m[2];
  }
  return out;
}

function readBodyBuffer(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        req.destroy();
        reject(new MultipartError(`upload too large: ${total} > ${maxBytes} bytes`, 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/**
 * Parse a multipart/form-data body. Returns files (with Buffer data) and
 * any text fields. Throws MultipartError on malformed input.
 */
export async function parseMultipartBody(
  req: IncomingMessage,
  options: { maxBytes?: number } = {},
): Promise<ParsedMultipart> {
  const maxBytes = options.maxBytes ?? 25 * 1024 * 1024; // 25 MB default
  const ctype = req.headers['content-type'] ?? '';
  if (!/multipart\/form-data/i.test(ctype)) {
    throw new MultipartError('content-type must be multipart/form-data');
  }
  const boundaryMatch = /boundary=([^;]+)/i.exec(ctype);
  if (!boundaryMatch) throw new MultipartError('missing boundary in content-type');
  const boundary = boundaryMatch[1].trim().replace(/^"(.*)"$/, '$1');

  const body = await readBodyBuffer(req, maxBytes);
  const delimiter = Buffer.from(`--${boundary}`);
  const closeDelim = Buffer.from(`--${boundary}--`);

  const files: MultipartFilePart[] = [];
  const fields: Record<string, string> = {};

  // Find each part's start: positions of `--boundary` in body
  const parts: { start: number; end: number }[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    const idx = body.indexOf(delimiter, cursor);
    if (idx < 0) break;
    // Found a delimiter — content of the previous part (if any) ends here
    if (parts.length > 0) {
      parts[parts.length - 1].end = idx - 2; // strip trailing \r\n
    }
    // Check for close delimiter
    if (body.slice(idx, idx + closeDelim.length).equals(closeDelim)) {
      break;
    }
    // Skip to start of next part: `--boundary\r\n`
    const partStart = idx + delimiter.length + 2; // +2 for \r\n after boundary
    parts.push({ start: partStart, end: body.length });
    cursor = partStart;
  }

  for (const p of parts) {
    if (p.start >= p.end) continue;
    const partBuf = body.slice(p.start, p.end);
    // Headers end at \r\n\r\n
    const headerEnd = partBuf.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd < 0) continue;
    const headerBlock = partBuf.slice(0, headerEnd).toString('utf8');
    const data = partBuf.slice(headerEnd + 4);
    const headers = parseHeaders(headerBlock);
    const cd = parseContentDisposition(headers['content-disposition'] ?? '');
    if (!cd.name) continue;
    if (cd.filename !== undefined) {
      files.push({
        fieldName: cd.name,
        filename: cd.filename,
        contentType: headers['content-type'] ?? 'application/octet-stream',
        data,
      });
    } else {
      fields[cd.name] = data.toString('utf8');
    }
  }

  return { files, fields };
}
