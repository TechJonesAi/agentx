import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { type Agent, type Integration, type InboundContext, createLogger } from '@agentx/core';

const execFileAsync = promisify(execFile);
const log = createLogger('integration:signal');

interface SignalMessage {
  envelope: {
    source: string;
    sourceNumber?: string;
    sourceName?: string;
    timestamp: number;
    dataMessage?: {
      message: string;
      groupInfo?: {
        groupId: string;
        type?: string;
      };
      attachments?: Array<{
        contentType: string;
        filename: string;
        size: number;
      }>;
    };
  };
}

export class SignalIntegration implements Integration {
  readonly name = 'signal';
  private agent: Agent;
  private sessionMap = new Map<string, string>(); // sender -> sessionId
  private signalCliBin: string;
  private account: string;
  private daemon: ChildProcess | null = null;
  private running = false;

  constructor(agent: Agent) {
    this.agent = agent;

    this.signalCliBin = process.env['SIGNAL_CLI_PATH'] ?? 'signal-cli';
    this.account = process.env['SIGNAL_ACCOUNT'] ?? '';

    if (!this.account) {
      throw new Error(
        'SIGNAL_ACCOUNT environment variable is required (your phone number, e.g. +1234567890)',
      );
    }
  }

  private getBaseArgs(): string[] {
    return ['-a', this.account, '--output=json'];
  }

  async sendMessage(recipient: string, message: string): Promise<void> {
    const args = [...this.getBaseArgs(), 'send', '-m', message, recipient];

    try {
      await execFileAsync(this.signalCliBin, args, { timeout: 30_000 });
      log.info({ recipient, messageLength: message.length }, 'Message sent');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ recipient, error: msg }, 'Failed to send message');
      throw error;
    }
  }

  async sendGroupMessage(groupId: string, message: string): Promise<void> {
    const args = [...this.getBaseArgs(), 'send', '-m', message, '-g', groupId];

    try {
      await execFileAsync(this.signalCliBin, args, { timeout: 30_000 });
      log.info({ groupId, messageLength: message.length }, 'Group message sent');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ groupId, error: msg }, 'Failed to send group message');
      throw error;
    }
  }

  async sendAttachment(recipient: string, message: string, attachmentPath: string): Promise<void> {
    const args = [
      ...this.getBaseArgs(),
      'send',
      '-m', message,
      '-a', attachmentPath,
      recipient,
    ];

    try {
      await execFileAsync(this.signalCliBin, args, { timeout: 60_000 });
      log.info({ recipient, attachmentPath }, 'Attachment sent');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ recipient, error: msg }, 'Failed to send attachment');
      throw error;
    }
  }

  private async handleMessage(parsed: SignalMessage): Promise<void> {
    const envelope = parsed.envelope;
    const dataMessage = envelope.dataMessage;

    if (!dataMessage?.message) return;

    const sender = envelope.source ?? envelope.sourceNumber ?? '';
    const senderName = envelope.sourceName ?? sender;
    const content = dataMessage.message.trim();
    const isGroup = !!dataMessage.groupInfo;
    const groupId = dataMessage.groupInfo?.groupId;

    if (!content) return;

    // In groups, only respond when the bot name is mentioned
    if (isGroup && !content.toLowerCase().includes('agentx')) {
      return;
    }

    log.info({
      sender: senderName,
      isGroup,
      groupId,
      contentLength: content.length,
    }, 'Received Signal message');

    const sessionKey = isGroup ? `group:${groupId}` : sender;
    let sessionId = this.sessionMap.get(sessionKey);
    if (!sessionId) {
      const session = this.agent.getSessionManager().create({
        userId: sender,
        platform: 'signal',
        metadata: {
          senderNumber: sender,
          senderName,
          isGroup,
          groupId,
        },
      });
      sessionId = session.id;
      this.sessionMap.set(sessionKey, sessionId);
    }

    const inbound: InboundContext = {
      label: isGroup ? `Signal group ${groupId}` : `Signal ${senderName}`,
      provider: 'signal',
      from: sender,
      to: this.account,
      chatType: isGroup ? 'group' : 'dm',
      groupId: isGroup ? groupId : undefined,
    };

    try {
      const response = await this.agent.chat(content, sessionId, inbound);

      if (isGroup && groupId) {
        await this.sendGroupMessage(groupId, response);
      } else {
        await this.sendMessage(sender, response);
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error({ sender, error: errMsg }, 'Error processing Signal message');

      const errorReply = `Sorry, I encountered an error: ${errMsg}`;
      try {
        if (isGroup && groupId) {
          await this.sendGroupMessage(groupId, errorReply);
        } else {
          await this.sendMessage(sender, errorReply);
        }
      } catch {
        // Best effort error reply
      }
    }
  }

  async start(): Promise<void> {
    log.info({ account: this.account }, 'Starting Signal integration (signal-cli daemon)');

    // Verify signal-cli is available
    try {
      await execFileAsync(this.signalCliBin, ['--version'], { timeout: 10_000 });
    } catch {
      throw new Error(
        `signal-cli not found at '${this.signalCliBin}'. ` +
        'Install it: https://github.com/AsamK/signal-cli or set SIGNAL_CLI_PATH.',
      );
    }

    // Start the JSON-RPC daemon for receiving messages
    const args = [...this.getBaseArgs(), 'jsonRpc'];
    this.daemon = spawn(this.signalCliBin, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.running = true;

    let buffer = '';

    this.daemon.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();

      // signal-cli jsonRpc outputs one JSON object per line
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed) as SignalMessage;
          if (parsed.envelope?.dataMessage) {
            this.handleMessage(parsed).catch((err) => {
              log.error({ error: err }, 'Error in message handler');
            });
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    this.daemon.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        log.warn({ stderr: text }, 'signal-cli stderr');
      }
    });

    this.daemon.on('close', (code) => {
      log.info({ code }, 'signal-cli daemon exited');
      this.running = false;
      this.daemon = null;
    });

    this.daemon.on('error', (error) => {
      log.error({ error: error.message }, 'signal-cli daemon error');
      this.running = false;
    });

    log.info('Signal integration started (listening for messages)');
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.daemon) {
      this.daemon.kill('SIGTERM');

      // Give it a moment to clean up
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.daemon) {
            this.daemon.kill('SIGKILL');
          }
          resolve();
        }, 5000);

        this.daemon?.on('close', () => {
          clearTimeout(timeout);
          resolve();
        });
      });

      this.daemon = null;
    }

    log.info('Signal integration stopped');
  }

  isRunning(): boolean {
    return this.running;
  }
}
