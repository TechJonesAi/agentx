/**
 * P13-B1 — Minimal Ollama embedding client.
 *
 * Wraps POST /api/embed (nomic-embed-text by default). Used by the
 * P12-3 PlaybookStore and P12-2 ContinuousContextStore for semantic
 * matching. Deliberately tiny and fail-open: any error / timeout
 * returns null and the callers fall back to keyword matching.
 *
 * Localhost-only by construction — the base URL comes from the agent's
 * ollama provider config which is already constrained to localhost in
 * localOnly mode.
 */
import { createLogger } from '../logger.js';

const log = createLogger('llm:embedder');

export interface EmbedOptions {
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
}

export type EmbedFn = (texts: string[]) => Promise<number[][] | null>;

/**
 * Build an embed function bound to an Ollama endpoint. Returns vectors
 * in input order, or null on ANY failure (callers must fall back).
 */
export function buildOllamaEmbedder(opts: EmbedOptions = {}): EmbedFn {
  const baseUrl = (opts.baseUrl ?? 'http://localhost:11434').replace(/\/+$/, '');
  const model = opts.model ?? 'nomic-embed-text:latest';
  const timeoutMs = opts.timeoutMs ?? 3_000;

  return async (texts: string[]): Promise<number[][] | null> => {
    if (!texts || texts.length === 0) return [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      const res = await fetch(`${baseUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, input: texts }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        log.warn({ status: res.status }, 'embed request failed');
        return null;
      }
      const json = (await res.json()) as { embeddings?: number[][] };
      if (!Array.isArray(json.embeddings) || json.embeddings.length !== texts.length) {
        return null;
      }
      return json.embeddings;
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'embed unavailable — semantic matching falls back to keywords',
      );
      return null;
    }
  };
}

/** Cosine similarity between two vectors (0 when shapes mismatch). */
export function cosineSim(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (!a || !b || a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Serialise a vector for BLOB storage (float32, little-endian). */
export function vecToBuffer(v: ReadonlyArray<number>): Buffer {
  return Buffer.from(new Float32Array(v).buffer);
}

/** Deserialise a BLOB back to a vector. */
export function bufferToVec(b: Buffer): number[] {
  return Array.from(new Float32Array(b.buffer, b.byteOffset, Math.floor(b.byteLength / 4)));
}
