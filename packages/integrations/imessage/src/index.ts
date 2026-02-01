/**
 * iMessage Integration for AgentX
 *
 * macOS only. Requires Full Disk Access permission in
 * System Settings > Privacy & Security > Full Disk Access
 * to read ~/Library/Messages/chat.db.
 *
 * Sends messages via AppleScript (osascript).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as path from 'node:path';
import * as os from 'node:os';
import Database from 'better-sqlite3';
import { type Agent, type Integration, type InboundContext, createLogger } from '@agentx/core';

const execFileAsync = promisify(execFile);
const log = createLogger('integration:imessage');

interface ChatRow {
  rowid: number;
  guid: string;
  chat_identifier: string;
  display_name: string | null;
}

interface MessageRow {
  rowid: number;
  guid: string;
  text: string | null;
  is_from_me: number;
  date: number;
  handle_id: number;
  cache_roomnames: string | null;
}

export class IMessageIntegration implements Integration {
  readonly name = 'imessage';
  private agent: Agent;
  private sessionMap = new Map<string, string>(); // chatIdentifier -> sessionId
  private db: Database.Database | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastProcessedRowId = 0;
  private pollIntervalMs: number;
  private running = false;

  constructor(agent: Agent) {
    if (process.platform !== 'darwin') {
      throw new Error('iMessage integration is only available on macOS');
    }

    this.agent = agent;
    this.pollIntervalMs = parseInt(process.env['IMESSAGE_POLL_INTERVAL'] ?? '3000', 10);
  }

  private getMessagesDbPath(): string {
    return path.join(os.homedir(), 'Library', 'Messages', 'chat.db');
  }

  async sendMessage(recipient: string, message: string): Promise<void> {
    // Escape for AppleScript
    const escapedMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedRecipient = recipient.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
      tell application "Messages"
        set targetService to 1st account whose service type = iMessage
        set targetBuddy to participant "${escapedRecipient}" of targetService
        send "${escapedMessage}" to targetBuddy
      end tell
    `;

    try {
      await execFileAsync('osascript', ['-e', script], { timeout: 15_000 });
      log.info({ recipient, messageLength: message.length }, 'iMessage sent');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ recipient, error: msg }, 'Failed to send iMessage');
      throw error;
    }
  }

  async sendToChat(chatId: string, message: string): Promise<void> {
    const escapedMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const escapedChatId = chatId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

    const script = `
      tell application "Messages"
        set targetChat to chat id "${escapedChatId}"
        send "${escapedMessage}" to targetChat
      end tell
    `;

    try {
      await execFileAsync('osascript', ['-e', script], { timeout: 15_000 });
      log.info({ chatId, messageLength: message.length }, 'iMessage sent to chat');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ chatId, error: msg }, 'Failed to send iMessage to chat');
      throw error;
    }
  }

  private openDb(): Database.Database {
    const dbPath = this.getMessagesDbPath();
    try {
      return new Database(dbPath, { readonly: true, fileMustExist: true });
    } catch (error) {
      throw new Error(
        `Cannot open Messages database at ${dbPath}. ` +
        'Ensure Full Disk Access is granted in System Settings > Privacy & Security. ' +
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private getLatestRowId(): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT MAX(ROWID) as max_id FROM message').get() as
      | { max_id: number | null }
      | undefined;
    return row?.max_id ?? 0;
  }

  private getNewMessages(): MessageRow[] {
    if (!this.db) return [];

    const stmt = this.db.prepare(`
      SELECT
        m.ROWID as rowid,
        m.guid,
        m.text,
        m.is_from_me,
        m.date,
        m.handle_id,
        m.cache_roomnames
      FROM message m
      WHERE m.ROWID > ? AND m.is_from_me = 0 AND m.text IS NOT NULL AND m.text != ''
      ORDER BY m.ROWID ASC
      LIMIT 50
    `);

    return stmt.all(this.lastProcessedRowId) as MessageRow[];
  }

  private getSenderForMessage(handleId: number): string {
    if (!this.db) return 'unknown';

    const row = this.db.prepare('SELECT id FROM handle WHERE ROWID = ?').get(handleId) as
      | { id: string }
      | undefined;
    return row?.id ?? 'unknown';
  }

  private getChatForMessage(messageRowId: number): ChatRow | undefined {
    if (!this.db) return undefined;

    const row = this.db.prepare(`
      SELECT c.ROWID as rowid, c.guid, c.chat_identifier, c.display_name
      FROM chat c
      JOIN chat_message_join cmj ON cmj.chat_id = c.ROWID
      WHERE cmj.message_id = ?
      LIMIT 1
    `).get(messageRowId) as ChatRow | undefined;

    return row;
  }

  private async pollNewMessages(): Promise<void> {
    if (!this.running) return;

    try {
      const messages = this.getNewMessages();

      for (const msg of messages) {
        this.lastProcessedRowId = msg.rowid;

        const sender = this.getSenderForMessage(msg.handle_id);
        const chat = this.getChatForMessage(msg.rowid);
        const content = (msg.text ?? '').trim();
        const isGroup = !!msg.cache_roomnames;
        const chatIdentifier = chat?.chat_identifier ?? sender;

        if (!content) continue;

        // In groups, only respond when mentioned by name
        if (isGroup && !content.toLowerCase().includes('agentx')) {
          continue;
        }

        log.info({
          sender,
          chatIdentifier,
          isGroup,
          contentLength: content.length,
        }, 'Received iMessage');

        let sessionId = this.sessionMap.get(chatIdentifier);
        if (!sessionId) {
          const session = this.agent.getSessionManager().create({
            userId: sender,
            platform: 'imessage',
            metadata: {
              sender,
              chatIdentifier,
              isGroup,
              chatName: chat?.display_name,
            },
          });
          sessionId = session.id;
          this.sessionMap.set(chatIdentifier, sessionId);
        }

        const inbound: InboundContext = {
          label: isGroup ? `iMessage ${chat?.display_name ?? chatIdentifier}` : `iMessage ${sender}`,
          provider: 'imessage',
          from: sender,
          to: 'self',
          chatType: isGroup ? 'group' : 'dm',
          groupId: isGroup ? chatIdentifier : undefined,
        };

        try {
          const response = await this.agent.chat(content, sessionId, inbound);

          if (chat?.guid) {
            await this.sendToChat(chat.guid, response);
          } else {
            await this.sendMessage(sender, response);
          }
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          log.error({ sender, error: errMsg }, 'Error processing iMessage');
        }
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      log.error({ error: errMsg }, 'Error polling messages');
    }
  }

  async start(): Promise<void> {
    if (process.platform !== 'darwin') {
      throw new Error('iMessage integration is only available on macOS');
    }

    log.info('Starting iMessage integration');

    this.db = this.openDb();
    this.lastProcessedRowId = this.getLatestRowId();
    this.running = true;

    log.info(
      { lastRowId: this.lastProcessedRowId, pollInterval: this.pollIntervalMs },
      'iMessage integration started (polling for new messages)',
    );

    this.pollTimer = setInterval(() => {
      this.pollNewMessages().catch((err) => {
        log.error({ error: err }, 'Poll cycle error');
      });
    }, this.pollIntervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    if (this.db) {
      this.db.close();
      this.db = null;
    }

    log.info('iMessage integration stopped');
  }

  isRunning(): boolean {
    return this.running;
  }
}
