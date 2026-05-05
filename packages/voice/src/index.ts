import * as fs from 'node:fs';
import * as path from 'node:path';
import OpenAI from 'openai';
import { createLogger } from '@agentx/core';

const log = createLogger('voice');

// ─── Text-to-Speech ──────────────────────────────────────────────────────────

export interface TTSOptions {
  text: string;
  outputPath?: string;
  voice?: string;
}

export class ElevenLabsTTS {
  private apiKey: string;
  private voiceId: string;

  constructor(apiKey?: string, voiceId?: string) {
    this.apiKey = apiKey ?? process.env['ELEVENLABS_API_KEY'] ?? '';
    this.voiceId = voiceId ?? process.env['ELEVENLABS_VOICE_ID'] ?? 'pNInz6obpgDQGcFmaJgB'; // default: Adam
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  async synthesize(options: TTSOptions): Promise<Buffer> {
    if (!this.apiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const response = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${this.voiceId}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': this.apiKey,
        },
        body: JSON.stringify({
          text: options.text,
          model_id: 'eleven_monolingual_v1',
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75,
          },
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status} ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (options.outputPath) {
      const dir = path.dirname(options.outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(options.outputPath, buffer);
      log.info({ path: options.outputPath, size: buffer.length }, 'Audio saved');
    }

    return buffer;
  }
}

// ─── Speech-to-Text ──────────────────────────────────────────────────────────

export interface STTOptions {
  audioPath: string;
  language?: string;
}

export class WhisperSTT {
  private client: OpenAI | null = null;

  isConfigured(): boolean {
    return !!process.env['OPENAI_API_KEY'];
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI();
    }
    return this.client;
  }

  async transcribe(options: STTOptions): Promise<string> {
    const client = this.getClient();

    log.info({ audioPath: options.audioPath }, 'Transcribing audio');

    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(options.audioPath),
      model: 'whisper-1',
      language: options.language,
    });

    log.info({ textLength: response.text.length }, 'Transcription complete');
    return response.text;
  }
}

// ─── Voice Manager ───────────────────────────────────────────────────────────

export class VoiceManager {
  private tts: ElevenLabsTTS;
  private stt: WhisperSTT;

  constructor() {
    this.tts = new ElevenLabsTTS();
    this.stt = new WhisperSTT();
  }

  getTTS(): ElevenLabsTTS {
    return this.tts;
  }

  async textToSpeech(text: string, outputPath?: string): Promise<Buffer> {
    return this.tts.synthesize({ text, outputPath });
  }

  async speechToText(audioPath: string, language?: string): Promise<string> {
    return this.stt.transcribe({ audioPath, language });
  }

  isTTSConfigured(): boolean {
    return this.tts.isConfigured();
  }

  isSTTConfigured(): boolean {
    return this.stt.isConfigured();
  }
}

// ─── Local Whisper STT (PCM buffer input for WebUI push-to-talk) ──────────────

export interface WhisperConfig {
  sampleRate?: number;
  language?: string;
  useGPU?: boolean;
}

export interface WhisperResult {
  success: boolean;
  text: string;
  error?: string;
  durationMs?: number;
}

/**
 * Local Whisper STT adapter for web UI push-to-talk.
 * Accepts PCM audio buffers directly (as opposed to WhisperSTT which takes file paths).
 * Falls back to the OpenAI Whisper API under the hood, writing the buffer to a temp file.
 */
export class Whisper {
  private config: WhisperConfig;
  private stt: WhisperSTT;

  constructor(config?: WhisperConfig) {
    this.config = config ?? {};
    this.stt = new WhisperSTT();
  }

  async transcribe(pcmBuffer: Buffer): Promise<WhisperResult> {
    const startMs = Date.now();

    if (!this.stt.isConfigured()) {
      return {
        success: false,
        text: '',
        error: 'OpenAI API key not configured for Whisper STT',
      };
    }

    // Write PCM to a temp WAV file for the OpenAI API
    const tmpDir = (await import('node:os')).tmpdir();
    const tmpPath = (await import('node:path')).join(tmpDir, `agentx-stt-${Date.now()}.wav`);

    try {
      // Create minimal WAV header for 16kHz 16-bit mono PCM
      const sampleRate = this.config.sampleRate ?? 16000;
      const bitsPerSample = 16;
      const numChannels = 1;
      const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);
      const dataSize = pcmBuffer.length;

      const header = Buffer.alloc(44);
      header.write('RIFF', 0);
      header.writeUInt32LE(36 + dataSize, 4);
      header.write('WAVE', 8);
      header.write('fmt ', 12);
      header.writeUInt32LE(16, 16);
      header.writeUInt16LE(1, 20);           // PCM format
      header.writeUInt16LE(numChannels, 22);
      header.writeUInt32LE(sampleRate, 24);
      header.writeUInt32LE(byteRate, 28);
      header.writeUInt16LE(blockAlign, 32);
      header.writeUInt16LE(bitsPerSample, 34);
      header.write('data', 36);
      header.writeUInt32LE(dataSize, 40);

      const wavBuffer = Buffer.concat([header, pcmBuffer]);
      (await import('node:fs')).writeFileSync(tmpPath, wavBuffer);

      const text = await this.stt.transcribe({
        audioPath: tmpPath,
        language: this.config.language,
      });

      const durationMs = Date.now() - startMs;
      return { success: true, text, durationMs };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, text: '', error: msg, durationMs: Date.now() - startMs };
    } finally {
      // Clean up temp file
      try {
        (await import('node:fs')).unlinkSync(tmpPath);
      } catch { /* ignore cleanup errors */ }
    }
  }
}

// Re-export voice call support
export { VoiceCaller, createPhoneCallTool, type VoiceCallConfig, type CallResult } from './calls.js';
