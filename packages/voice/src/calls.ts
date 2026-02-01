import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '@agentx/core';
import type { ElevenLabsTTS } from './index.js';

const log = createLogger('voice:calls');

export interface VoiceCallConfig {
  twilioAccountSid: string;
  twilioAuthToken: string;
  twilioPhoneNumber: string;
  webhookBaseUrl: string;
}

export interface CallResult {
  callSid: string;
  status: string;
}

interface TwilioClient {
  calls: {
    create(params: Record<string, unknown>): Promise<{ sid: string; status: string }>;
  };
}

/**
 * Voice call manager using Twilio for outbound calls
 * and ElevenLabs TTS for speech synthesis.
 */
export class VoiceCaller {
  private twilio: TwilioClient | null = null;
  private config: VoiceCallConfig;
  private tts: ElevenLabsTTS;
  private activeCalls = new Map<string, { phoneNumber: string; status: string }>();
  private audioDir: string;

  constructor(config: VoiceCallConfig, tts: ElevenLabsTTS) {
    this.config = config;
    this.tts = tts;
    this.audioDir = path.join(os.homedir(), '.agentx', 'voice', 'audio');

    if (!fs.existsSync(this.audioDir)) {
      fs.mkdirSync(this.audioDir, { recursive: true });
    }
  }

  isConfigured(): boolean {
    return !!(this.config.twilioAccountSid && this.config.twilioAuthToken && this.config.twilioPhoneNumber);
  }

  private async getClient(): Promise<TwilioClient> {
    if (!this.twilio) {
      // Dynamic import to avoid requiring twilio when not used.
      // Use Function constructor to bypass TypeScript module resolution.
      const importDynamic = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{ default?: unknown }>;
      const twilio = await importDynamic('twilio');
      const createClient = twilio.default ?? twilio;
      this.twilio = (createClient as (sid: string, token: string) => TwilioClient)(
        this.config.twilioAccountSid,
        this.config.twilioAuthToken,
      );
    }
    return this.twilio;
  }

  /**
   * Make a one-way call: speak a message and hang up.
   */
  async call(phoneNumber: string, message: string): Promise<CallResult> {
    if (!this.isConfigured()) {
      throw new Error('Twilio is not configured. Set twilioAccountSid, twilioAuthToken, and twilioPhoneNumber.');
    }

    log.info({ phoneNumber, messageLength: message.length }, 'Initiating voice call');

    // Generate TTS audio
    const audioFilename = `call-${Date.now()}.mp3`;
    const audioPath = path.join(this.audioDir, audioFilename);

    if (this.tts.isConfigured()) {
      await this.tts.synthesize({ text: message, outputPath: audioPath });
    }

    const client = await this.getClient();

    // Build TwiML for the call
    const twiml = this.tts.isConfigured()
      ? `<Response><Play>${this.config.webhookBaseUrl}/voice/audio/${audioFilename}</Play></Response>`
      : `<Response><Say voice="alice">${this.escapeXml(message)}</Say></Response>`;

    const callParams: Record<string, unknown> = {
      to: phoneNumber,
      from: this.config.twilioPhoneNumber,
      twiml,
      statusCallback: `${this.config.webhookBaseUrl}/voice/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    };

    const result = await client.calls.create(callParams);

    this.activeCalls.set(result.sid, { phoneNumber, status: result.status });
    log.info({ callSid: result.sid, status: result.status }, 'Call initiated');

    return { callSid: result.sid, status: result.status };
  }

  /**
   * Make an interactive call: two-way conversation with the agent.
   * Uses Twilio's <Gather> with speech input for transcription.
   */
  async callInteractive(phoneNumber: string, greeting: string): Promise<CallResult> {
    if (!this.isConfigured()) {
      throw new Error('Twilio is not configured');
    }

    log.info({ phoneNumber }, 'Initiating interactive voice call');

    const client = await this.getClient();

    // Initial greeting + gather for speech input
    const twiml = [
      '<Response>',
      `  <Say voice="alice">${this.escapeXml(greeting)}</Say>`,
      `  <Gather input="speech" action="${this.config.webhookBaseUrl}/voice/gather" `,
      '    speechTimeout="auto" language="en-US">',
      '    <Say voice="alice">I\'m listening.</Say>',
      '  </Gather>',
      '  <Say voice="alice">I didn\'t hear anything. Goodbye.</Say>',
      '</Response>',
    ].join('\n');

    const result = await client.calls.create({
      to: phoneNumber,
      from: this.config.twilioPhoneNumber,
      twiml,
      statusCallback: `${this.config.webhookBaseUrl}/voice/status`,
      statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
    });

    this.activeCalls.set(result.sid, { phoneNumber, status: 'interactive' });
    log.info({ callSid: result.sid }, 'Interactive call initiated');

    return { callSid: result.sid, status: result.status };
  }

  /**
   * Build TwiML response for a gathered speech input.
   * Called from the webhook handler after Twilio transcribes user speech.
   */
  buildGatherResponse(agentReply: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `  <Say voice="alice">${this.escapeXml(agentReply)}</Say>`,
      `  <Gather input="speech" action="${this.config.webhookBaseUrl}/voice/gather" `,
      '    speechTimeout="auto" language="en-US">',
      '    <Say voice="alice">Go ahead.</Say>',
      '  </Gather>',
      '  <Say voice="alice">I didn\'t hear anything. Goodbye.</Say>',
      '</Response>',
    ].join('\n');
  }

  /**
   * Build TwiML for the initial answer webhook.
   */
  buildAnswerTwiml(greeting: string): string {
    return [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<Response>',
      `  <Say voice="alice">${this.escapeXml(greeting)}</Say>`,
      `  <Gather input="speech" action="${this.config.webhookBaseUrl}/voice/gather" `,
      '    speechTimeout="auto" language="en-US">',
      '  </Gather>',
      '</Response>',
    ].join('\n');
  }

  updateCallStatus(callSid: string, status: string): void {
    const call = this.activeCalls.get(callSid);
    if (call) {
      call.status = status;
      if (status === 'completed' || status === 'failed' || status === 'busy' || status === 'no-answer') {
        this.activeCalls.delete(callSid);
      }
    }
    log.info({ callSid, status }, 'Call status updated');
  }

  getActiveCalls(): Map<string, { phoneNumber: string; status: string }> {
    return new Map(this.activeCalls);
  }

  getAudioDir(): string {
    return this.audioDir;
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}

/**
 * Create the make_phone_call tool definition for the agent.
 */
export function createPhoneCallTool(caller: VoiceCaller): {
  definition: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
  execute: (args: Record<string, unknown>) => Promise<string>;
} {
  return {
    definition: {
      name: 'make_phone_call',
      description: 'Call a phone number and speak a message or start an interactive conversation',
      parameters: {
        type: 'object',
        properties: {
          phoneNumber: {
            type: 'string',
            description: 'Phone number in E.164 format (e.g. +1234567890)',
          },
          message: {
            type: 'string',
            description: 'Message to speak to the recipient',
          },
          interactive: {
            type: 'boolean',
            description: 'If true, start a two-way conversation instead of one-way message',
          },
        },
        required: ['phoneNumber', 'message'],
      },
    },
    async execute(args) {
      const phoneNumber = args['phoneNumber'] as string;
      const message = args['message'] as string;
      const interactive = args['interactive'] as boolean | undefined;

      if (!caller.isConfigured()) {
        return 'Voice calling is not configured. Please set Twilio credentials.';
      }

      try {
        const result = interactive
          ? await caller.callInteractive(phoneNumber, message)
          : await caller.call(phoneNumber, message);

        return JSON.stringify({
          success: true,
          callSid: result.callSid,
          status: result.status,
          mode: interactive ? 'interactive' : 'one-way',
        });
      } catch (error) {
        return `Call failed: ${error instanceof Error ? error.message : String(error)}`;
      }
    },
  };
}
