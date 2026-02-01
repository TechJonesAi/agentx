import { Client as WAClient, LocalAuth, type Message as WAMessage } from 'whatsapp-web.js';
import { type Agent, type Integration, type InboundContext, createLogger } from '@agentx/core';

const log = createLogger('integration:whatsapp');

export class WhatsAppIntegration implements Integration {
  readonly name = 'whatsapp';
  private client: WAClient;
  private agent: Agent;
  private sessionMap = new Map<string, string>(); // chatId -> sessionId
  private ready = false;

  constructor(agent: Agent) {
    this.agent = agent;

    this.client = new WAClient({
      authStrategy: new LocalAuth({ dataPath: '.whatsapp-session' }),
      puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox'],
      },
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.client.on('qr', (qr: string) => {
      log.info('QR code received. Scan with WhatsApp to authenticate.');
      // In a real app, display this QR code to the user
      console.log('\nWhatsApp QR Code (scan with your phone):');
      console.log('Install qrcode-terminal to display: npm i -g qrcode-terminal');
      console.log(`QR data: ${qr.substring(0, 50)}...\n`);
    });

    this.client.on('ready', () => {
      this.ready = true;
      log.info('WhatsApp client ready');
    });

    this.client.on('authenticated', () => {
      log.info('WhatsApp authenticated');
    });

    this.client.on('auth_failure', (message: string) => {
      log.error({ message }, 'WhatsApp authentication failure');
    });

    this.client.on('disconnected', (reason: string) => {
      this.ready = false;
      log.warn({ reason }, 'WhatsApp disconnected');
    });

    this.client.on('message', async (message: WAMessage) => {
      await this.handleMessage(message);
    });
  }

  private async handleMessage(message: WAMessage): Promise<void> {
    // Skip status messages and non-text
    if (message.isStatus) return;
    if (message.type !== 'chat') {
      if (message.type === 'image' || message.type === 'video' || message.type === 'document') {
        await message.reply('I received your media. Media processing is not yet supported.');
      }
      return;
    }

    const chatId = message.from;
    const contact = await message.getContact();
    const chat = await message.getChat();
    const isGroup = chat.isGroup;

    // In groups, only respond when mentioned or name is used
    if (isGroup) {
      const mentions = await message.getMentions();
      const botContact = await this.client.getContactById(
        (this.client as unknown as { info: { wid: { _serialized: string } } }).info.wid._serialized,
      );
      const isMentioned = mentions.some((m) => m.id._serialized === botContact.id._serialized);
      const nameInMessage = message.body.toLowerCase().includes('agentx');

      if (!isMentioned && !nameInMessage) return;
    }

    const content = message.body.trim();
    if (!content) return;

    log.info({
      chatId,
      contact: contact.pushname ?? contact.number,
      isGroup,
      contentLength: content.length,
    }, 'Received message');

    let sessionId = this.sessionMap.get(chatId);
    if (!sessionId) {
      const session = this.agent.getSessionManager().create({
        userId: contact.id._serialized,
        platform: 'whatsapp',
        metadata: {
          chatId,
          contactName: contact.pushname,
          contactNumber: contact.number,
          isGroup,
          groupName: isGroup ? chat.name : undefined,
        },
      });
      sessionId = session.id;
      this.sessionMap.set(chatId, sessionId);
    }

    const inbound: InboundContext = {
      label: isGroup ? `WhatsApp ${chat.name}` : `WhatsApp ${contact.pushname ?? contact.number}`,
      provider: 'whatsapp',
      from: contact.id._serialized,
      to: (this.client as unknown as { info: { wid: { _serialized: string } } }).info.wid._serialized,
      chatType: isGroup ? 'group' : 'dm',
      groupId: isGroup ? chatId : undefined,
    };

    try {
      // Show typing indicator
      const chatObj = await message.getChat();
      await chatObj.sendStateTyping();

      const response = await this.agent.chat(content, sessionId, inbound);

      // WhatsApp doesn't have a strict limit but very long messages are unwieldy
      if (response.length <= 4096) {
        await message.reply(response);
      } else {
        const chunks = this.splitMessage(response, 4096);
        for (const chunk of chunks) {
          await chatObj.sendMessage(chunk);
        }
      }

      await chatObj.clearState();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ chatId, error: msg }, 'Error processing message');
      await message.reply(`Sorry, I encountered an error: ${msg}`).catch(() => {});
    }
  }

  private splitMessage(text: string, maxLength: number): string[] {
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > 0) {
      if (remaining.length <= maxLength) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt === -1 || splitAt < maxLength / 2) {
        splitAt = remaining.lastIndexOf(' ', maxLength);
      }
      if (splitAt === -1 || splitAt < maxLength / 2) {
        splitAt = maxLength;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }

  async sendMessage(chatId: string, message: string): Promise<void> {
    if (message.length <= 4096) {
      await this.client.sendMessage(chatId, message);
    } else {
      const chunks = this.splitMessage(message, 4096);
      for (const chunk of chunks) {
        await this.client.sendMessage(chatId, chunk);
      }
    }
    log.info({ chatId, messageLength: message.length }, 'Outbound message sent');
  }

  async start(): Promise<void> {
    log.info('Starting WhatsApp client (QR code auth may be required)');
    await this.client.initialize();
    log.info('WhatsApp client initialized');
  }

  async stop(): Promise<void> {
    await this.client.destroy();
    this.ready = false;
    log.info('WhatsApp client stopped');
  }
}
