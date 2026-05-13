/**
 * Qwen3 TTS provider — wraps the local qwen3-tts-server sidecar.
 *
 * Diagnostics surface a specific failure category so the user can tell
 * apart "sidecar not installed" from "wrong URL" from "timeout" — each
 * needs a different fix.
 */

import type { TtsProvider, TtsVoice, TtsSynthesizeRequest, TtsSynthesizeResult, TtsHealthResult } from '../types.js';

/** Categorized failure mode for the health endpoint. */
export type Qwen3FailureCategory =
  | 'unreachable'        // ECONNREFUSED, EAI_AGAIN, getaddrinfo, no route
  | 'timeout'            // AbortError within timeout window
  | 'bad_status'         // HTTP reachable but non-2xx
  | 'invalid_response'   // Reachable + 2xx but body shape unexpected
  | 'misconfigured';     // Bad baseUrl shape

export interface Qwen3HealthExtras extends TtsHealthResult {
  category?: Qwen3FailureCategory;
  endpointUrl?: string;
  latencyMs?: number;
  lastSuccessAt?: number | null;
}

export class Qwen3Provider implements TtsProvider {
  readonly id = 'qwen3';
  readonly qualityScore = 90;
  private baseUrl: string;
  private timeoutMs: number;
  private healthTimeoutMs: number;
  private lastSuccessAt: number | null = null;

  constructor(baseUrl?: string, timeoutMs?: number) {
    this.baseUrl = baseUrl ?? process.env['AGENTX_TTS_BASE_URL'] ?? 'http://127.0.0.1:9880';
    this.timeoutMs = timeoutMs ?? parseInt(process.env['AGENTX_TTS_TIMEOUT_MS'] ?? '60000', 10);
    this.healthTimeoutMs = parseInt(process.env['AGENTX_TTS_HEALTH_TIMEOUT_MS'] ?? '2500', 10);
  }

  isEnabled(): boolean {
    // Local-by-default; honour an explicit disable knob so users on a box
    // without the sidecar can silence the provider entirely.
    return process.env['AGENTX_TTS_QWEN3_DISABLED'] !== '1';
  }

  /** Public — for diagnostics. */
  getEndpointUrl(): string { return this.baseUrl; }
  getLastSuccessAt(): number | null { return this.lastSuccessAt; }

  private async fetchWithTimeout(
    urlPath: string,
    init: RequestInit,
    ms: number = this.timeoutMs,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      return await fetch(`${this.baseUrl}${urlPath}`, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async health(): Promise<Qwen3HealthExtras> {
    // Validate baseUrl shape first — catch typos before opening a socket.
    if (!/^https?:\/\/[^/]+/.test(this.baseUrl)) {
      return {
        ok: false,
        category: 'misconfigured',
        detail: `AGENTX_TTS_BASE_URL must be http(s)://host[:port] — got "${this.baseUrl}"`,
        endpointUrl: this.baseUrl,
      };
    }
    const t0 = Date.now();
    try {
      const res = await this.fetchWithTimeout('/health', { method: 'GET' }, this.healthTimeoutMs);
      const latencyMs = Date.now() - t0;
      if (!res.ok) {
        return {
          ok: false,
          category: 'bad_status',
          detail: `HTTP ${res.status} from ${this.baseUrl}/health`,
          endpointUrl: this.baseUrl,
          latencyMs,
          lastSuccessAt: this.lastSuccessAt,
        };
      }
      // Don't insist on a particular body shape — many sidecars just 200.
      // We do require it to NOT 5xx and to respond within the budget.
      return {
        ok: true,
        detail: `OK from ${this.baseUrl}/health (${latencyMs}ms)`,
        endpointUrl: this.baseUrl,
        latencyMs,
        lastSuccessAt: this.lastSuccessAt,
      };
    } catch (e) {
      const latencyMs = Date.now() - t0;
      const msg = e instanceof Error ? e.message : String(e);
      const lower = msg.toLowerCase();
      let category: Qwen3FailureCategory = 'unreachable';
      if (lower.includes('abort') || lower.includes('timed out') || lower.includes('timeout')) {
        category = 'timeout';
      } else if (lower.includes('econnrefused') || lower.includes('fetch failed') ||
                 lower.includes('eai_again') || lower.includes('getaddrinfo') ||
                 lower.includes('enotfound') || lower.includes('ehostunreach')) {
        category = 'unreachable';
      }
      // Build a human-actionable hint per category. Honest — no fakery.
      const hint =
        category === 'timeout'
          ? `No response within ${this.healthTimeoutMs}ms — sidecar may be starting up or overloaded.`
          : category === 'unreachable'
            ? `No service listening at ${this.baseUrl}. Start the qwen3 sidecar (see README) or set AGENTX_TTS_BASE_URL / AGENTX_TTS_QWEN3_DISABLED=1.`
            : msg;
      return {
        ok: false,
        category,
        detail: hint,
        endpointUrl: this.baseUrl,
        latencyMs,
        lastSuccessAt: this.lastSuccessAt,
      };
    }
  }

  async listVoices(): Promise<TtsVoice[]> {
    const res = await this.fetchWithTimeout('/voices', { method: 'GET' });
    if (!res.ok) throw new Error(`Qwen3 voices failed: HTTP ${res.status}`);
    const voices = (await res.json()) as Array<{ id: string; name: string; description?: string; builtin?: boolean }>;
    return voices.map((v) => ({
      id: v.id,
      name: v.name,
      quality: 0.9,
    }));
  }

  async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    const voiceId = req.voiceId ?? 'Chelsie';
    const debug = process.env['AGENTX_DEBUG_TTS'] === '1';
    if (debug) console.log(`[tts:qwen3] POST ${this.baseUrl}/tts voice=${voiceId} text=${req.text.length}chars timeout=${this.timeoutMs}ms`);

    const res = await this.fetchWithTimeout('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: req.text, voice_id: voiceId, speed: req.speed ?? 1.0 }),
    });

    if (!res.ok) {
      const errText = await res.text();
      if (debug) console.log(`[tts:qwen3] upstream error: HTTP ${res.status} — ${errText.slice(0, 200)}`);
      throw new Error(`Qwen3 synthesis failed: HTTP ${res.status} — ${errText}`);
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    const upstreamType = res.headers.get('content-type');
    const contentType = upstreamType?.startsWith('audio/') ? upstreamType.split(';')[0] as 'audio/wav' | 'audio/mpeg' : 'audio/mpeg';
    this.lastSuccessAt = Date.now();
    return { bytes, contentType, providerId: 'qwen3', voiceId };
  }
}
