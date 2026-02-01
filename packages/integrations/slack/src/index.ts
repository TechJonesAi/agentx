import { App, type SlackEventMiddlewareArgs, type AllMiddlewareArgs } from '@slack/bolt';
import { type Agent, type Integration, type InboundContext, createLogger } from '@agentx/core';

const log = createLogger('integration:slack');

type MessageEvent = SlackEventMiddlewareArgs<'message'> & AllMiddlewareArgs;
type AppMentionEvent = SlackEventMiddlewareArgs<'app_mention'> & AllMiddlewareArgs;

export class SlackIntegration implements Integration {
  readonly name = 'slack';
  private app: App;
  private agent: Agent;
  private sessionMap = new Map<string, string>(); // channelId:threadTs -> sessionId
  private botUserId: string | null = null;

  constructor(agent: Agent) {
    const token = process.env['SLACK_BOT_TOKEN'];
    const signingSecret = process.env['SLACK_SIGNING_SECRET'];
    const appToken = process.env['SLACK_APP_TOKEN'];

    if (!token) {
      throw new Error('SLACK_BOT_TOKEN environment variable is required');
    }
    if (!signingSecret) {
      throw new Error('SLACK_SIGNING_SECRET environment variable is required');
    }

    this.agent = agent;

    this.app = new App({
      token,
      signingSecret,
      ...(appToken ? { socketMode: true, appToken } : {}),
    });

    this.setupHandlers();
  }

  private setupHandlers(): void {
    // Respond to direct messages
    this.app.message(async (args) => {
      await this.handleMessage(args as MessageEvent);
    });

    // Respond to @mentions
    this.app.event('app_mention', async (args) => {
      await this.handleMention(args as AppMentionEvent);
    });
  }

  private getSessionKey(channel: string, threadTs?: string): string {
    return threadTs ? `${channel}:${threadTs}` : channel;
  }

  private async handleMessage(args: MessageEvent): Promise<void> {
    const { message, say } = args;
    const msg = message as { text?: string; user?: string; channel?: string; thread_ts?: string; bot_id?: string; subtype?: string };

    // Ignore bot messages and subtypes
    if (msg.bot_id || msg.subtype) return;
    if (!msg.text || !msg.user) return;

    const content = msg.text.trim();
    if (!content) return;

    const channel = msg.channel ?? '';
    const threadTs = msg.thread_ts;
    const userId = msg.user;

    log.info({ channel, userId, contentLength: content.length }, 'Received DM');

    const sessionKey = this.getSessionKey(channel, threadTs);
    let sessionId = this.sessionMap.get(sessionKey);
    if (!sessionId) {
      const session = this.agent.getSessionManager().create({
        userId,
        platform: 'slack',
        metadata: { channel, threadTs, userId },
      });
      sessionId = session.id;
      this.sessionMap.set(sessionKey, sessionId);
    }

    const dmInbound: InboundContext = {
      label: `Slack DM ${channel}`,
      provider: 'slack',
      from: userId,
      to: this.botUserId ?? '',
      chatType: threadTs ? 'thread' : 'dm',
      threadId: threadTs,
    };

    try {
      const response = await this.agent.chat(content, sessionId, dmInbound);
      await say({
        text: response,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error({ channel, error: errMsg }, 'Error processing message');
      await say({
        text: `Sorry, I encountered an error: ${errMsg}`,
        ...(threadTs ? { thread_ts: threadTs } : {}),
      });
    }
  }

  private async handleMention(args: AppMentionEvent): Promise<void> {
    const { event, say } = args;
    const { text, user, channel, thread_ts: threadTs } = event;

    // Strip bot mention
    let content = text;
    if (this.botUserId) {
      content = content.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
    }

    if (!content) return;

    log.info({ channel, user, contentLength: content.length }, 'Received mention');

    const sessionKey = this.getSessionKey(channel, threadTs);
    let sessionId = this.sessionMap.get(sessionKey);
    if (!sessionId) {
      const session = this.agent.getSessionManager().create({
        userId: user,
        platform: 'slack',
        metadata: { channel, threadTs, userId: user },
      });
      sessionId = session.id;
      this.sessionMap.set(sessionKey, sessionId);
    }

    const mentionInbound: InboundContext = {
      label: `Slack #${channel}`,
      provider: 'slack',
      from: user ?? '',
      to: this.botUserId ?? '',
      chatType: threadTs ? 'thread' : 'group',
      groupId: channel,
      threadId: threadTs,
    };

    try {
      const response = await this.agent.chat(content, sessionId, mentionInbound);
      await say({
        text: response,
        thread_ts: threadTs ?? event.ts,
      });
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error({ channel, error: errMsg }, 'Error processing mention');
      await say({
        text: `Sorry, I encountered an error: ${errMsg}`,
        thread_ts: threadTs ?? event.ts,
      });
    }
  }

  async sendMessage(channel: string, message: string, threadTs?: string): Promise<void> {
    const token = process.env['SLACK_BOT_TOKEN']!;
    await this.app.client.chat.postMessage({
      token,
      channel,
      text: message,
      ...(threadTs ? { thread_ts: threadTs } : {}),
    });
    log.info({ channel, messageLength: message.length }, 'Outbound message sent');
  }

  async start(): Promise<void> {
    const port = parseInt(process.env['SLACK_PORT'] ?? '3000', 10);
    log.info({ port }, 'Starting Slack bot');

    await this.app.start(port);

    // Get bot user ID
    try {
      const result = await this.app.client.auth.test();
      this.botUserId = result.user_id ?? null;
      log.info({ botUserId: this.botUserId }, 'Slack bot started');
    } catch (error) {
      log.warn('Could not fetch bot user ID');
    }
  }

  async stop(): Promise<void> {
    await this.app.stop();
    log.info('Slack bot stopped');
  }
}
