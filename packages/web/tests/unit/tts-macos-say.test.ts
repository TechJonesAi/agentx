/**
 * macOS `say` TTS provider — unit tests.
 *
 * On non-darwin hosts the provider auto-disables; we verify both shapes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MacOsSayProvider } from '../../src/server/tts/providers/macos-say.js';

const isDarwin = process.platform === 'darwin';

describe('MacOsSayProvider', () => {
  let prevDisabled: string | undefined;
  beforeEach(() => { prevDisabled = process.env['AGENTX_TTS_SAY_DISABLED']; delete process.env['AGENTX_TTS_SAY_DISABLED']; });
  afterEach(() => { if (prevDisabled === undefined) delete process.env['AGENTX_TTS_SAY_DISABLED']; else process.env['AGENTX_TTS_SAY_DISABLED'] = prevDisabled; });

  it('has stable id and a non-zero qualityScore', () => {
    const p = new MacOsSayProvider();
    expect(p.id).toBe('macos-say');
    expect(p.qualityScore).toBeGreaterThan(0);
  });

  it('honours AGENTX_TTS_SAY_DISABLED=1 (force disabled)', async () => {
    process.env['AGENTX_TTS_SAY_DISABLED'] = '1';
    const p = new MacOsSayProvider();
    expect(p.isEnabled()).toBe(false);
    const h = await p.health();
    expect(h.ok).toBe(false);
  });

  it.runIf(!isDarwin)('disables itself on non-darwin platforms', async () => {
    const p = new MacOsSayProvider();
    expect(p.isEnabled()).toBe(false);
    const h = await p.health();
    expect(h.ok).toBe(false);
    expect(h.detail).toMatch(new RegExp(process.platform));
    expect(await p.listVoices()).toEqual([]);
  });

  it.runIf(isDarwin)('is enabled and healthy on darwin', async () => {
    const p = new MacOsSayProvider();
    expect(p.isEnabled()).toBe(true);
    const h = await p.health();
    expect(h.ok).toBe(true);
    expect(h.detail).toMatch(/say/i);
  });

  it.runIf(isDarwin)('lists at least a few system voices', async () => {
    const p = new MacOsSayProvider();
    const voices = await p.listVoices();
    expect(voices.length).toBeGreaterThan(5);
    // Sanity-check shape
    expect(voices[0]).toMatchObject({ id: expect.any(String), name: expect.any(String) });
    // English voice should be present on any default macOS install
    expect(voices.some((v) => v.language?.startsWith('en'))).toBe(true);
  }, 10000);

  it.runIf(isDarwin)('synthesizes a short phrase to WAV bytes', async () => {
    const p = new MacOsSayProvider();
    const r = await p.synthesize({ text: 'hi', voiceId: 'Samantha' });
    expect(r.contentType).toBe('audio/wav');
    expect(r.providerId).toBe('macos-say');
    expect(r.bytes.length).toBeGreaterThan(100);
    // RIFF header check
    expect(r.bytes.slice(0, 4).toString('ascii')).toBe('RIFF');
  }, 15000);

  it.runIf(isDarwin)('rejects empty text', async () => {
    const p = new MacOsSayProvider();
    await expect(p.synthesize({ text: '   ' })).rejects.toThrow(/text is required/);
  });
});
