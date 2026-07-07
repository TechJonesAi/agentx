/**
 * Local speech-to-text — mlx-whisper on Apple Silicon.
 *
 * POST /api/stt (multipart audio or raw body) → { text }
 * GET  /api/stt/health → availability (the Chat mic probes this and only
 * switches from browser SpeechRecognition — which ships audio to Google —
 * to the local recorder path when whisper is genuinely available).
 *
 * Implementation: spawn the venv's Python with mlx_whisper on a tmp file.
 * First call downloads the model (~150MB, whisper-turbo) into the HF
 * cache; subsequent calls are ~1-2s for short utterances.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { createLogger } from '@agentx/core';

const log = createLogger('web:stt');

const VENV_PY = path.join(os.homedir(), '.agentx', 'mlx-venv', 'bin', 'python3');
const MODEL = process.env['AGENTX_STT_MODEL'] ?? 'mlx-community/whisper-turbo';

export function sttAvailable(): boolean {
  if ((process.env['AGENTX_STT_DISABLED'] ?? '') === '1') return false;
  return fs.existsSync(VENV_PY);
}

export async function transcribe(audio: Buffer, filenameHint = 'audio.webm'): Promise<string> {
  if (!sttAvailable()) throw new Error('local STT not available (mlx venv missing)');
  const ext = path.extname(filenameHint) || '.webm';
  const tmp = path.join(os.tmpdir(), `agentx-stt-${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`);
  fs.writeFileSync(tmp, audio);
  try {
    const script = `
import sys, json
import mlx_whisper
r = mlx_whisper.transcribe(sys.argv[1], path_or_hf_repo=${JSON.stringify(MODEL)})
print(json.dumps({"text": r.get("text", "").strip()}))
`;
    const out = await new Promise<string>((resolve, reject) => {
      const child = spawn(VENV_PY, ['-c', script, tmp], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('whisper timed out after 120s'));
      }, 120_000);
      child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', (e) => { clearTimeout(timer); reject(e); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(stdout);
        else reject(new Error(`whisper exited ${code}: ${stderr.slice(-300)}`));
      });
    });
    const lastLine = out.trim().split('\n').pop() ?? '{}';
    const parsed = JSON.parse(lastLine) as { text?: string };
    log.info({ chars: parsed.text?.length ?? 0 }, 'Local transcription complete');
    return parsed.text ?? '';
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* gone */ }
  }
}
