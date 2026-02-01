import {
  Client,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type TextChannel,
  type DMChannel,
} from 'discord.js';
import { type Agent, type Integration, type InboundContext, createLogger } from '@agentx/core';

const log = createLogger('integration:discord');

export class DiscordIntegration implements Integration {
  readonly name = 'discord';
  private client: Client;
  private agent: Agent;
  private sessionMap = new Map<string, string>(); // channelId -> sessionId
  private botUserId: string | null = null;

  constructor(agent: Agent) {
    const token = process.env['DISCORD_BOT_TOKEN'];
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN environment variable is required');
    }

    this.agent = agent;

    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    this.client.once('ready', () => {
      this.botUserId = this.client.user?.id ?? null;
      log.info({ username: this.client.user?.tag }, 'Discord bot connected');
    });

    this.client.on('messageCreate', async (message) => {
      await this.handleMessage(message);
    });

    this.client.on('error', (error) => {
      log.error({ error: error.message }, 'Discord client error');
    });
  }

  private async handleMessage(message: DiscordMessage): Promise<void> {
    // Ignore messages from bots (including self)
    if (message.author.bot) return;

    const isDM = !message.guild;
    const isMentioned = message.mentions.has(this.client.user!);

    // In servers, only respond when mentioned. In DMs, always respond.
    if (!isDM && !isMentioned) return;

    // Strip the bot mention from the message
    let content = message.content;
    if (this.botUserId) {
      content = content.replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '').trim();
    }

    if (!content) return;

    const channelId = message.channel.id;
    const userId = message.author.id;

    log.info({ channelId, userId, isDM, contentLength: content.length }, 'Received message');

    let sessionId = this.sessionMap.get(channelId);
    if (!sessionId) {
      const session = this.agent.getSessionManager().create({
        userId,
        platform: 'discord',
        metadata: {
          channelId,
          guildId: message.guild?.id,
          username: message.author.username,
          isDM,
        },
      });
      sessionId = session.id;
      this.sessionMap.set(channelId, sessionId);
    }

    const inbound: InboundContext = {
      label: isDM ? `Discord DM ${message.author.username}` : `Discord #${(message.channel as TextChannel).name ?? channelId}`,
      provider: 'discord',
      from: userId,
      to: this.botUserId ?? '',
      chatType: isDM ? 'dm' : 'group',
      groupId: isDM ? undefined : message.guild?.id,
      threadId: message.channel.isThread() ? message.channel.id : undefined,
    };

    try {
      // Show typing indicator
      const channel = message.channel as TextChannel | DMChannel;
      await channel.sendTyping();

      const response = await this.agent.chat(content, sessionId, inbound);

      // Discord has a 2000 char limit per message
      if (response.length <= 2000) {
        await message.reply(response);
      } else {
        // Split into chunks
        const chunks = this.splitMessage(response, 2000);
        for (let i = 0; i < chunks.length; i++) {
          if (i === 0) {
            await message.reply(chunks[i]!);
          } else {
            await channel.send(chunks[i]!);
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ channelId, error: msg }, 'Error processing message');
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

      // Try to split at a newline
      let splitAt = remaining.lastIndexOf('\n', maxLength);
      if (splitAt === -1 || splitAt < maxLength / 2) {
        // Try to split at a space
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

  async sendMessage(userId: string, message: string): Promise<void> {
    const user = await this.client.users.fetch(userId);
    const chunks = this.splitMessage(message, 2000);
    for (const chunk of chunks) {
      await user.send(chunk);
    }
    log.info({ userId, messageLength: message.length }, 'Outbound DM sent');
  }

  async sendToChannel(channelId: string, message: string): Promise<void> {
    const channel = await this.client.channels.fetch(channelId) as TextChannel;
    const chunks = this.splitMessage(message, 2000);
    for (const chunk of chunks) {
      await channel.send(chunk);
    }
    log.info({ channelId, messageLength: message.length }, 'Outbound channel message sent');
  }

  async start(): Promise<void> {
    const token = process.env['DISCORD_BOT_TOKEN'];
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN environment variable is required');
    }

    log.info('Starting Discord bot');
    await this.client.login(token);
    log.info('Discord bot started');
  }

  async stop(): Promise<void> {
    await this.client.destroy();
    log.info('Discord bot stopped');
  }
}
