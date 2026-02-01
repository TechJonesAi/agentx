import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { SessionEntry } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('sessions:store');

export interface SessionFilter {
  provider?: string;
  chatType?: 'dm' | 'group' | 'thread';
  keyPrefix?: string;
}

export class SessionStore {
  private storePath: string;
  private sessions = new Map<string, SessionEntry>();
  private dirty = false;

  constructor(agentId: string, storePath?: string) {
    if (storePath) {
      this.storePath = storePath.replace(/\{agentId\}/g, agentId).replace(/^~/, os.homedir());
    } else {
      this.storePath = path.join(os.homedir(), '.agentx', 'agents', agentId, 'sessions', 'sessions.json');
    }

    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.storePath)) {
        const raw = fs.readFileSync(this.storePath, 'utf-8');
        const data = JSON.parse(raw) as Record<string, SessionEntry>;
        for (const [key, entry] of Object.entries(data)) {
          this.sessions.set(key, entry);
        }
        log.info({ count: this.sessions.size, path: this.storePath }, 'Session store loaded');
      }
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to load session store');
    }
  }

  private persist(): void {
    try {
      const dir = path.dirname(this.storePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const data: Record<string, SessionEntry> = {};
      for (const [key, entry] of this.sessions) {
        data[key] = entry;
      }

      fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), 'utf-8');
      this.dirty = false;
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to persist session store');
    }
  }

  get(sessionKey: string): SessionEntry | null {
    return this.sessions.get(sessionKey) ?? null;
  }

  set(sessionKey: string, entry: SessionEntry): void {
    this.sessions.set(sessionKey, entry);
    this.dirty = true;
    this.persist();
  }

  delete(sessionKey: string): boolean {
    const existed = this.sessions.delete(sessionKey);
    if (existed) {
      this.dirty = true;
      this.persist();
    }
    return existed;
  }

  list(filter?: SessionFilter): SessionEntry[] {
    let entries = Array.from(this.sessions.values());

    if (filter?.provider) {
      entries = entries.filter((e) => e.origin.provider === filter.provider);
    }
    if (filter?.chatType) {
      const chatType = filter.chatType;
      entries = entries.filter((e) => {
        if (chatType === 'thread') return !!e.origin.threadId;
        if (chatType === 'group') return !!e.room || !!e.space;
        return !e.room && !e.space && !e.origin.threadId;
      });
    }
    if (filter?.keyPrefix) {
      const prefix = filter.keyPrefix;
      entries = entries.filter((e) => e.sessionKey.startsWith(prefix));
    }

    return entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getActive(withinMinutes: number): SessionEntry[] {
    const cutoff = new Date(Date.now() - withinMinutes * 60 * 1000).toISOString();
    return this.list().filter((e) => e.updatedAt >= cutoff);
  }

  getStorePath(): string {
    return this.storePath;
  }

  size(): number {
    return this.sessions.size;
  }

  updateTokens(sessionKey: string, input: number, output: number, context: number): void {
    const entry = this.sessions.get(sessionKey);
    if (!entry) return;

    entry.inputTokens += input;
    entry.outputTokens += output;
    entry.totalTokens = entry.inputTokens + entry.outputTokens;
    entry.contextTokens = context;
    entry.updatedAt = new Date().toISOString();

    this.dirty = true;
    this.persist();
  }
}
