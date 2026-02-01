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

// Re-export voice call support
export { VoiceCaller, createPhoneCallTool, type VoiceCallConfig, type CallResult } from './calls.js';
