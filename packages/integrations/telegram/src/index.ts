import { Telegraf, type Context } from 'telegraf';
import type { Message as TelegramMessage } from 'telegraf/types';
import { type Agent, type Integration, type InboundContext, createLogger } from '@agentx/core';

const log = createLogger('integration:telegram');

export class TelegramIntegration implements Integration {
  readonly name = 'telegram';
  private bot: Telegraf;
  private agent: Agent;
  private sessionMap = new Map<number, string>(); // chatId -> sessionId

  constructor(agent: Agent) {
    const token = process.env['TELEGRAM_BOT_TOKEN'];
    if (!token) {
      throw new Error('TELEGRAM_BOT_TOKEN environment variable is required');
    }

    this.agent = agent;
    this.bot = new Telegraf(token);
    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.bot.command('start', (ctx) => {
      ctx.reply('Hello! I\'m AgentX. Send me a message and I\'ll respond.');
    });

    this.bot.command('reset', (ctx) => {
      const chatId = ctx.chat.id;
      this.sessionMap.delete(chatId);
      ctx.reply('Session reset. Starting fresh!');
    });

    this.bot.command('status', (ctx) => {
      const chatId = ctx.chat.id;
      const sessionId = this.sessionMap.get(chatId);
      if (sessionId) {
        ctx.reply(`Active session: ${sessionId.slice(0, 8)}...`);
      } else {
        ctx.reply('No active session.');
      }
    });

    this.bot.on('text', async (ctx) => {
      await this.handleTextMessage(ctx);
    });

    this.bot.on('photo', async (ctx) => {
      await ctx.reply('I received your photo. Image analysis is not yet supported.');
    });

    this.bot.on('voice', async (ctx) => {
      await ctx.reply('I received your voice message. Voice processing is not yet supported.');
    });

    this.bot.on('document', async (ctx) => {
      await ctx.reply('I received your document. File processing is not yet supported.');
    });
  }

  private async handleTextMessage(ctx: Context): Promise<void> {
    const message = ctx.message as TelegramMessage.TextMessage;
    if (!message?.text) return;

    const chatId = ctx.chat!.id;
    const text = message.text;
    const isGroup = ctx.chat!.type === 'group' || ctx.chat!.type === 'supergroup';
    const username = (ctx.from as { username?: string; first_name?: string })?.username;
    const firstName = (ctx.from as { first_name?: string })?.first_name;

    log.info({ chatId, textLength: text.length }, 'Received message');

    let sessionId = this.sessionMap.get(chatId);
    if (!sessionId) {
      const session = this.agent.getSessionManager().create({
        userId: String(chatId),
        platform: 'telegram',
        metadata: {
          chatId,
          username,
        },
      });
      sessionId = session.id;
      this.sessionMap.set(chatId, sessionId);
    }

    const inbound: InboundContext = {
      label: isGroup ? `Telegram group ${chatId}` : `Telegram DM ${username ?? chatId}`,
      provider: 'telegram',
      from: String(ctx.from?.id ?? chatId),
      to: String(ctx.botInfo?.id ?? ''),
      chatType: isGroup ? 'group' : 'dm',
      groupId: isGroup ? String(chatId) : undefined,
    };

    try {
      // Send typing indicator
      await ctx.sendChatAction('typing');

      const response = await this.agent.chat(text, sessionId, inbound);

      // Telegram has a 4096 char limit per message
      if (response.length <= 4096) {
        await ctx.reply(response);
      } else {
        // Split into chunks
        for (let i = 0; i < response.length; i += 4096) {
          await ctx.reply(response.slice(i, i + 4096));
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ chatId, error: msg }, 'Error processing message');
      await ctx.reply(`Sorry, I encountered an error: ${msg}`);
    }
  }

  async sendMessage(chatId: string | number, message: string): Promise<void> {
    const id = typeof chatId === 'string' ? parseInt(chatId, 10) : chatId;
    if (message.length <= 4096) {
      await this.bot.telegram.sendMessage(id, message);
    } else {
      for (let i = 0; i < message.length; i += 4096) {
        await this.bot.telegram.sendMessage(id, message.slice(i, i + 4096));
      }
    }
    log.info({ chatId: id, messageLength: message.length }, 'Outbound message sent');
  }

  async start(): Promise<void> {
    log.info('Starting Telegram bot');
    await this.bot.launch();
    log.info('Telegram bot started');
  }

  async stop(): Promise<void> {
    this.bot.stop('shutdown');
    log.info('Telegram bot stopped');
  }
}
