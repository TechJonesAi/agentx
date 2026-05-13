/**
 * macOS `say` TTS provider — fallback local provider for the audit.
 *
 * Uses the system `say` binary that ships with macOS. Available out-of-
 * the-box on darwin only. Outputs WAV via the `--data-format` flag so we
 * don't need a second tool to transcode. Voices are enumerated by
 * parsing `say -v "?"`. Quality is rated below the Qwen3 neural
 * provider but above the cloud fallbacks when those have no token.
 *
 * Safety properties:
 *   - Only enabled when process.platform === 'darwin' AND /usr/bin/say
 *     exists. On Linux/Windows it disables itself silently — health
 *     reports `not available on <platform>`.
 *   - Synthesis spawns `say` with a fixed argv (no shell), text is
 *     written to stdin (no escaping concerns for arbitrary user input).
 *   - Output written to an os.tmpdir() file under a per-call random
 *     name, read once, then deleted. No persistent state.
 *   - Disable knob: AGENTX_TTS_SAY_DISABLED=1 forces isEnabled()=false.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  TtsProvider, TtsVoice, TtsSynthesizeRequest, TtsSynthesizeResult, TtsHealthResult,
} from '../types.js';

const SAY_BIN = '/usr/bin/say';

function isDarwinSayAvailable(): boolean {
  if (process.platform !== 'darwin') return false;
  try { return fs.statSync(SAY_BIN).isFile(); } catch { return false; }
}

/** Parse one line of `say -v "?"` output:
 *  "Alex                en_US    # Most people recognize me by my voice."
 *  → { id: 'Alex', name: 'Alex', language: 'en-US' }
 */
function parseVoiceLine(line: string): TtsVoice | null {
  // Voice name may contain spaces (e.g. "Bad News"); locale is BCP-47ish.
  const m = line.match(/^(.{1,40}?)\s{2,}([a-z]{2,3}[_-][A-Z]{2})\s*#/);
  if (!m) return null;
  const name = (m[1] ?? '').trim();
  const lang = (m[2] ?? '').replace('_', '-');
  if (!name) return null;
  return { id: name, name, language: lang, quality: 0.6 };
}

export class MacOsSayProvider implements TtsProvider {
  readonly id = 'macos-say';
  readonly qualityScore = 50;
  private readonly available: boolean;
  private cachedVoices: TtsVoice[] | null = null;

  constructor() {
    this.available = isDarwinSayAvailable();
  }

  isEnabled(): boolean {
    if (process.env['AGENTX_TTS_SAY_DISABLED'] === '1') return false;
    return this.available;
  }

  async health(): Promise<TtsHealthResult> {
    if (!this.available) return { ok: false, detail: `not available on ${process.platform}` };
    if (process.env['AGENTX_TTS_SAY_DISABLED'] === '1') return { ok: false, detail: 'disabled by env' };
    return { ok: true, detail: 'macOS /usr/bin/say' };
  }

  async listVoices(): Promise<TtsVoice[]> {
    if (!this.available) return [];
    if (this.cachedVoices) return this.cachedVoices;
    const out = await this.runSay(['-v', '?'], null, 5000, /* captureStdout */ true);
    const voices: TtsVoice[] = [];
    for (const line of out.split(/\r?\n/)) {
      const v = parseVoiceLine(line);
      if (v) voices.push(v);
    }
    this.cachedVoices = voices;
    return voices;
  }

  async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    if (!this.available) throw new Error('macOS say not available on this platform');
    const text = (req.text ?? '').trim();
    if (!text) throw new Error('text is required');
    const voiceId = (req.voiceId ?? 'Samantha').trim() || 'Samantha';
    const speed = req.speed && req.speed > 0 ? req.speed : 1.0;
    // `say` rate is words-per-minute. 175 wpm is the default; scale by speed.
    const wpm = Math.max(50, Math.min(500, Math.round(175 * speed)));

    const tmpPath = path.join(
      os.tmpdir(),
      `agentx-say-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`,
    );

    try {
      await this.runSay(
        ['-v', voiceId, '-r', String(wpm), '--data-format=LEI16@22050', '-o', tmpPath],
        text,
        15000,
        false,
      );
      const bytes = fs.readFileSync(tmpPath);
      return { bytes, contentType: 'audio/wav', providerId: this.id, voiceId };
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* */ }
    }
  }

  /**
   * Spawn `say` safely. Text (when present) is written to stdin so it
   * never appears in the argv — safe for arbitrary user input.
   */
  private runSay(
    args: string[],
    stdinText: string | null,
    timeoutMs: number,
    captureStdout: boolean,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      const child = spawn(SAY_BIN, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL'); } catch { /* */ } }, timeoutMs);
      if (captureStdout) child.stdout.on('data', (b) => { stdout += b.toString('utf8'); });
      child.stderr.on('data', (b) => { stderr += b.toString('utf8'); });
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) return reject(new Error(`say timed out after ${timeoutMs}ms`));
        if (code !== 0) return reject(new Error(`say exited ${code}: ${stderr.slice(0, 200)}`));
        resolve(stdout);
      });
      if (stdinText !== null) {
        child.stdin.end(stdinText);
      } else {
        child.stdin.end();
      }
    });
  }
}
