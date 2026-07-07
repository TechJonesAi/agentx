/**
 * TTS offline fallback — the local-privacy claim.
 *
 * The v1.2.0 brief promises that when the network is off, POST /api/tts
 * falls back to Piper (fully-local neural voice) instead of failing or
 * emitting network traffic. The cloud/edge providers (qwen3 = edge-tts)
 * have higher qualityScore, so they win when reachable — this proves the
 * router demotes them to Piper when they FAIL (offline), deterministically.
 */
import { describe, it, expect } from 'vitest';
import { TtsRouter } from '../../src/server/tts/router.js';
import type {
  TtsProvider, TtsVoice, TtsHealthResult, TtsSynthesizeRequest, TtsSynthesizeResult,
} from '../../src/server/tts/types.js';

function makeProvider(opts: {
  id: string; quality: number; enabled?: boolean;
  fail?: boolean; // synthesize throws (simulates offline/unreachable)
}): TtsProvider & { synthCalls: number } {
  const p = {
    id: opts.id,
    qualityScore: opts.quality,
    synthCalls: 0,
    isEnabled: () => opts.enabled ?? true,
    async health(): Promise<TtsHealthResult> { return { ok: !opts.fail }; },
    async listVoices(): Promise<TtsVoice[]> { return [{ id: `${opts.id}-v`, name: opts.id, language: 'en-GB' }]; },
    async synthesize(_req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
      p.synthCalls++;
      if (opts.fail) throw new Error(`${opts.id} unreachable (offline)`);
      return { bytes: Buffer.from(`audio-from-${opts.id}`), contentType: 'audio/wav', providerId: opts.id, voiceId: `${opts.id}-v` };
    },
  };
  return p;
}

const REQ: TtsSynthesizeRequest = { text: 'Verification pass.' };

describe('TTS offline fallback to Piper', () => {
  it('serves Piper when the higher-quality cloud voice (qwen3) is offline', async () => {
    const qwen3 = makeProvider({ id: 'qwen3', quality: 90, fail: true }); // network down
    const piper = makeProvider({ id: 'piper', quality: 70 });             // local, works
    const say = makeProvider({ id: 'macos-say', quality: 50 });
    const router = new TtsRouter([qwen3, piper, say]);

    const result = await router.synthesize(REQ);
    expect(result.providerId).toBe('piper');
    expect(qwen3.synthCalls).toBe(1); // tried first (highest quality)
    expect(piper.synthCalls).toBe(1); // then fell to piper
    expect(say.synthCalls).toBe(0);   // never needed macos-say
  });

  it('prefers qwen3 when it IS reachable (normal online ordering unchanged)', async () => {
    const qwen3 = makeProvider({ id: 'qwen3', quality: 90 });
    const piper = makeProvider({ id: 'piper', quality: 70 });
    const router = new TtsRouter([qwen3, piper]);

    const result = await router.synthesize(REQ);
    expect(result.providerId).toBe('qwen3');
    expect(piper.synthCalls).toBe(0);
  });

  it('skips a disabled Piper and still falls to the local OS voice offline', async () => {
    const qwen3 = makeProvider({ id: 'qwen3', quality: 90, fail: true });
    const piper = makeProvider({ id: 'piper', quality: 70, enabled: false }); // not installed
    const say = makeProvider({ id: 'macos-say', quality: 50 });
    const router = new TtsRouter([qwen3, piper, say]);

    const result = await router.synthesize(REQ);
    expect(result.providerId).toBe('macos-say');
    expect(piper.synthCalls).toBe(0);
  });

  it('Piper outranks the disabled cloud voices in fallback order', async () => {
    // lovevoice(75) sits above piper(70) by quality but is disabled (no key),
    // so piper must be the first LOCAL fallback when qwen3 is offline.
    const qwen3 = makeProvider({ id: 'qwen3', quality: 90, fail: true });
    const lovevoice = makeProvider({ id: 'lovevoice', quality: 75, enabled: false });
    const piper = makeProvider({ id: 'piper', quality: 70 });
    const router = new TtsRouter([qwen3, lovevoice, piper]);

    const result = await router.synthesize(REQ);
    expect(result.providerId).toBe('piper');
    expect(lovevoice.synthCalls).toBe(0);
  });
});
