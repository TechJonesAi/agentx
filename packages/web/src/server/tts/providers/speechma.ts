/**
 * SpeechMA TTS provider — disabled stub unless API key is configured.
 */

import type { TtsProvider, TtsVoice, TtsSynthesizeRequest, TtsSynthesizeResult, TtsHealthResult } from '../types.js';

export class SpeechMAProvider implements TtsProvider {
  readonly id = 'speechma';
  readonly qualityScore = 65;
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = process.env['SPEECHMA_API_KEY'] ?? '';
    this.baseUrl = process.env['SPEECHMA_BASE_URL'] ?? 'https://api.speechma.com';
  }

  isEnabled(): boolean {
    return this.apiKey.length > 0;
  }

  async health(): Promise<TtsHealthResult> {
    if (!this.isEnabled()) return { ok: false, detail: 'No API key configured' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${this.baseUrl}/v1/health`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.apiKey}` },
          signal: controller.signal,
        });
        return { ok: res.ok, detail: res.ok ? undefined : `HTTP ${res.status}` };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async listVoices(): Promise<TtsVoice[]> {
    if (!this.isEnabled()) return [];
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 10000);
      try {
        const res = await fetch(`${this.baseUrl}/v1/voices`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.apiKey}` },
          signal: controller.signal,
        });
        if (!res.ok) return [];
        const data = (await res.json()) as Array<{ id: string; name: string; language?: string; gender?: string }>;
        return data.map((v) => ({
          id: v.id,
          name: v.name,
          language: v.language,
          gender: v.gender,
          quality: 0.7,
        }));
      } finally {
        clearTimeout(timer);
      }
    } catch {
      return [];
    }
  }

  async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    if (!this.isEnabled()) throw new Error('SpeechMA not configured');

    const voiceId = req.voiceId ?? 'default';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(`${this.baseUrl}/v1/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          text: req.text,
          voice: voiceId,
          speed: req.speed ?? 1.0,
        }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`SpeechMA synthesis failed: HTTP ${res.status} — ${errText}`);
      }

      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, contentType: 'audio/mpeg', providerId: 'speechma', voiceId };
    } finally {
      clearTimeout(timer);
    }
  }
}
