/**
 * Shared TTS types for the multi-provider fallback system.
 */

export type TtsAudioFormat = 'audio/wav' | 'audio/mpeg';

export interface TtsVoice {
  id: string;
  name: string;
  language?: string;
  gender?: string;
  quality?: number;
  providerId?: string;
}

export interface TtsSynthesizeRequest {
  text: string;
  voiceId?: string;
  speed?: number;
}

export interface TtsSynthesizeResult {
  bytes: Buffer;
  contentType: TtsAudioFormat;
  providerId: string;
  voiceId: string;
}

export interface TtsHealthResult {
  ok: boolean;
  detail?: string;
}

export interface TtsProvider {
  readonly id: string;
  readonly qualityScore: number;
  isEnabled(): boolean;
  health(): Promise<TtsHealthResult>;
  listVoices(): Promise<TtsVoice[]>;
  synthesize(req: TtsSynthesizeRequest): Promise<TtsSynthesizeResult>;
}
