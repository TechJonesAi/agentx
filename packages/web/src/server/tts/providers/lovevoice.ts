/**
 * Lovevoice TTS provider — enabled only when API token is configured.
 */

import type { TtsProvider, TtsVoice, TtsSynthesizeRequest, TtsSynthesizeResult, TtsHealthResult } from '../types.js';

const KNOWN_VOICES: TtsVoice[] = [
  { id: 'en-US-AvaNeural', name: 'Ava', language: 'en-US', gender: 'female', quality: 0.85 },
  { id: 'en-US-AndrewNeural', name: 'Andrew', language: 'en-US', gender: 'male', quality: 0.85 },
  { id: 'en-US-EmmaNeural', name: 'Emma', language: 'en-US', gender: 'female', quality: 0.8 },
  { id: 'en-US-BrianNeural', name: 'Brian', language: 'en-US', gender: 'male', quality: 0.8 },
  { id: 'en-GB-SoniaNeural', name: 'Sonia', language: 'en-GB', gender: 'female', quality: 0.8 },
];

export class LovevoiceProvider implements TtsProvider {
  readonly id = 'lovevoice';
  readonly qualityScore = 75;
  private token: string;
  private baseUrl: string;

  constructor() {
    this.token = process.env['LOVEVOICE_API_TOKEN'] ?? process.env['LUVVOICE_API_TOKEN'] ?? '';
    this.baseUrl = process.env['LOVEVOICE_BASE_URL'] ?? 'https://api.luvvoice.com';
  }

  isEnabled(): boolean {
    return this.token.length > 0;
  }

  async health(): Promise<TtsHealthResult> {
    if (!this.isEnabled()) return { ok: false, detail: 'No API token configured' };
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      try {
        const res = await fetch(`${this.baseUrl}/api/health`, {
          method: 'GET',
          headers: { 'Authorization': `Bearer ${this.token}` },
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
    // Return known high-quality voice allowlist
    return KNOWN_VOICES;
  }

  async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    if (!this.isEnabled()) throw new Error('Lovevoice not configured');

    const voiceId = req.voiceId ?? 'en-US-AvaNeural';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);

    try {
      const res = await fetch(`${this.baseUrl}/api/tts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.token}`,
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
        throw new Error(`Lovevoice synthesis failed: HTTP ${res.status} — ${errText}`);
      }

      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, contentType: 'audio/mpeg', providerId: 'lovevoice', voiceId };
    } finally {
      clearTimeout(timer);
    }
  }
}
