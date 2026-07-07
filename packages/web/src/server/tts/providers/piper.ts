/**
 * Piper TTS provider — fully-local neural voice (rhasspy/piper).
 *
 * Privacy: unlike the qwen3 sidecar (edge-tts → Microsoft cloud), Piper
 * runs entirely on this machine — no network, no throttling, works
 * offline. Quality sits between the neural cloud voice and macOS `say`,
 * so the router order becomes: qwen3 (when reachable) → piper → say.
 *
 * Resolution:
 *   binary: AGENTX_TTS_PIPER_BIN → ~/.agentx/mlx-venv/bin/piper → PATH
 *   voice:  AGENTX_TTS_PIPER_VOICE (path to .onnx) →
 *           ~/.agentx/voices/*.onnx (first match)
 *
 * Safety: fixed argv (no shell), text via stdin, per-call tmp output file
 * read once and deleted. Disable knob: AGENTX_TTS_PIPER_DISABLED=1.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import type {
  TtsProvider, TtsVoice, TtsSynthesizeRequest, TtsSynthesizeResult, TtsHealthResult,
} from '../types.js';

function resolvePiperBin(): string | null {
  const env = process.env['AGENTX_TTS_PIPER_BIN'];
  if (env && fs.existsSync(env)) return env;
  const venv = path.join(os.homedir(), '.agentx', 'mlx-venv', 'bin', 'piper');
  if (fs.existsSync(venv)) return venv;
  return null;
}

function resolveVoiceModel(): string | null {
  const env = process.env['AGENTX_TTS_PIPER_VOICE'];
  if (env && fs.existsSync(env)) return env;
  const dir = path.join(os.homedir(), '.agentx', 'voices');
  try {
    const onnx = fs.readdirSync(dir).find((f) => f.endsWith('.onnx'));
    return onnx ? path.join(dir, onnx) : null;
  } catch { return null; }
}

export class PiperProvider implements TtsProvider {
  readonly id = 'piper';
  // Above macos-say (50), below qwen3 neural — local-first without
  // sacrificing the best voice when it's available.
  readonly qualityScore = 70;
  private bin: string | null;
  private voice: string | null;

  constructor() {
    this.bin = resolvePiperBin();
    this.voice = resolveVoiceModel();
  }

  isEnabled(): boolean {
    if (process.env['AGENTX_TTS_PIPER_DISABLED'] === '1') return false;
    return !!(this.bin && this.voice);
  }

  async health(): Promise<TtsHealthResult> {
    if (process.env['AGENTX_TTS_PIPER_DISABLED'] === '1') return { ok: false, detail: 'disabled by env' };
    if (!this.bin) return { ok: false, detail: 'piper binary not found (pip install piper-tts)' };
    if (!this.voice) return { ok: false, detail: 'no voice model in ~/.agentx/voices (*.onnx)' };
    return { ok: true, detail: `piper @ ${this.bin} voice=${path.basename(this.voice)}` };
  }

  async listVoices(): Promise<TtsVoice[]> {
    if (!this.voice) return [];
    const name = path.basename(this.voice, '.onnx');
    return [{ id: name, name, language: name.split('-')[0]?.replace('_', '-') ?? 'en', quality: 0.75 }];
  }

  async synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult> {
    if (!this.bin || !this.voice) throw new Error('piper not installed');
    const text = (req.text ?? '').trim();
    if (!text) throw new Error('text is required');

    const outPath = path.join(
      os.tmpdir(),
      `agentx-piper-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.wav`,
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.bin!, ['-m', this.voice!, '-f', outPath], {
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          reject(new Error('piper timed out after 20s'));
        }, 20_000);
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', (e) => { clearTimeout(timer); reject(e); });
        child.on('close', (code) => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`piper exited ${code}: ${stderr.slice(0, 200)}`));
        });
        child.stdin.write(text);
        child.stdin.end();
      });
      const bytes = fs.readFileSync(outPath);
      if (bytes.length < 128) throw new Error('piper produced empty audio');
      return {
        bytes,
        contentType: 'audio/wav',
        providerId: this.id,
        voiceId: path.basename(this.voice, '.onnx'),
      };
    } finally {
      try { fs.unlinkSync(outPath); } catch { /* already gone */ }
    }
  }
}
