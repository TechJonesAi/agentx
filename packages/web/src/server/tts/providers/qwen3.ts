/**
 * Qwen3 TTS provider — wraps the local qwen3-tts-server.
 */

import type { TtsProvider, TtsVoice, TtsSynthesizeRequest, TtsSynthesizeResult, TtsHealthResult } from '../types.js';

export class Qwen3Provider implements TtsProvider {
  readonly id = 'qwen3';
  readonly qualityScore = 90;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(baseUrl?: string, timeoutMs?: number) {
    this.baseUrl = baseUrl ?? process.env['AGENTX_TTS_BASE_URL'] ?? 'http://127.0.0.1:9880';
    this.timeoutMs = timeoutMs ?? parseInt(process.env['AGENTX_TTS_TIMEOUT_MS'] ?? '60000', 10);
  }

  isEnabled(): boolean {
    return true; // Local server — always "enabled", may be down
  }

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

  async health(): Promise<TtsHealthResult> {
    try {
      const res = await this.fetchWithTimeout('/health', { method: 'GET' }, 5000);
      if (!res.ok) return { ok: false, detail: `HTTP ${res.status}` };
      return { ok: true };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
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
    return { bytes, contentType, providerId: 'qwen3', voiceId };
  }
}
