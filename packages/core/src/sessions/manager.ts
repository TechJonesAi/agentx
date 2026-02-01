import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { Session, Message, InboundContext, SessionEntry, SessionConfig } from '../types.js';
import { createLogger } from '../logger.js';
import { SessionStore } from './store.js';
import { TranscriptManager } from './transcript.js';
import { generateSessionKey, parseSessionKey } from './keys.js';
import { IdentityResolver } from './identity.js';
import { SessionResetManager } from './reset.js';

const log = createLogger('sessions:manager');

export class SessionManager {
  private db: Database.Database;
  private sessions = new Map<string, Session>();
  private ttlMs: number;

  // New session subsystems
  private sessionStore: SessionStore | null = null;
  private transcriptManager: TranscriptManager | null = null;
  private identityResolver: IdentityResolver | null = null;
  private resetManager: SessionResetManager | null = null;
  private sessionConfig: Partial<SessionConfig> | null = null;
  private agentId: string;

  // Map session keys to session IDs
  private keyToId = new Map<string, string>();

  constructor(db: Database.Database, ttlMinutes = 1440, agentId?: string) {
    this.db = db;
    this.ttlMs = ttlMinutes * 60 * 1000;
    this.agentId = agentId ?? 'default';
  }

  /**
   * Initialize the enhanced session subsystems.
   * Call this after construction if you want the new features.
   */
  initEnhanced(config: Partial<SessionConfig>): void {
    this.sessionConfig = config;

    this.sessionStore = new SessionStore(this.agentId, config.store);
    this.transcriptManager = new TranscriptManager(this.agentId);

    if (config.identityLinks) {
      this.identityResolver = new IdentityResolver(
        { links: config.identityLinks },
      );
    }

    if (config.reset) {
      this.resetManager = new SessionResetManager({
        reset: config.reset,
        resetByType: config.resetByType,
        resetByChannel: config.resetByChannel,
        resetTriggers: config.resetTriggers ?? ['/new', '/reset'],
      });
    }

    // Rebuild keyToId mapping from persisted store
    this.rebuildKeyToIdFromStore();

    log.info({ agentId: this.agentId }, 'Enhanced session management initialized');
  }

  /**
   * Rebuild the keyToId mapping from the persisted session store.
   * Called on startup to restore key→sessionId associations.
   */
  private rebuildKeyToIdFromStore(): void {
    if (!this.sessionStore) return;

    const entries = this.sessionStore.list();
    let restored = 0;

    for (const entry of entries) {
      // Verify the session still exists in the DB
      const session = this.loadSession(entry.sessionId);
      if (session) {
        this.keyToId.set(entry.sessionKey, entry.sessionId);
        this.sessions.set(entry.sessionId, session);
        restored++;
      }
    }

    if (restored > 0) {
      log.info({ restored }, 'Restored session key mappings from store');
    }
  }

  // ─── Original API (backward-compatible) ────────────────────────────────────

  create(options?: { userId?: string; platform?: string; metadata?: Record<string, unknown> }): Session {
    const session: Session = {
      id: uuid(),
      userId: options?.userId,
      platform: options?.platform,
      messages: [],
      metadata: options?.metadata ?? {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(session.id, session);
    this.persistSession(session);

    log.info({ sessionId: session.id, platform: session.platform }, 'Session created');
    return session;
  }

  get(sessionId: string): Session | undefined {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = this.loadSession(sessionId);
      if (session) {
        this.sessions.set(sessionId, session);
      }
    }
    return session;
  }

  getOrCreate(sessionId?: string, options?: { userId?: string; platform?: string }): Session {
    if (sessionId) {
      const existing = this.get(sessionId);
      if (existing) return existing;
    }
    return this.create(options);
  }

  update(sessionId: string, messages: Message[]): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.messages = messages;
    session.updatedAt = Date.now();
    this.persistSession(session);
  }

  end(sessionId: string): void {
    this.sessions.delete(sessionId);
    log.info({ sessionId }, 'Session ended');
  }

  listActive(): Session[] {
    return Array.from(this.sessions.values());
  }

  cleanExpired(): number {
    const cutoff = Date.now() - this.ttlMs;
    let cleaned = 0;

    for (const [id, session] of this.sessions) {
      if (session.updatedAt < cutoff) {
        this.sessions.delete(id);
        cleaned++;
      }
    }

    if (cleaned > 0) {
      log.info({ cleaned }, 'Cleaned expired sessions');
    }
    return cleaned;
  }

  // ─── Enhanced API (new session management) ─────────────────────────────────

  /**
   * Resolve or create a session using inbound context (provider, from, chatType, etc.).
   * This is the primary entry point for integration-driven sessions.
   */
  resolveSession(context: InboundContext): { session: Session; sessionKey: string; isNew: boolean; wasReset: boolean } {
    const config = this.sessionConfig ?? { dmScope: 'main' as const, mainKey: 'main', identityLinks: {} };
    const sessionKey = generateSessionKey(
      this.agentId,
      context,
      {
        dmScope: config.dmScope ?? 'main',
        mainKey: config.mainKey ?? 'main',
        identityLinks: config.identityLinks ?? {},
      },
    );

    // Check if we have an existing session for this key
    const existingId = this.keyToId.get(sessionKey);
    let wasReset = false;

    if (existingId) {
      const session = this.get(existingId);
      if (session) {
        // Check reset policy
        if (this.resetManager && this.sessionStore) {
          const entry = this.sessionStore.get(sessionKey);
          if (entry) {
            const parsed = parseSessionKey(sessionKey);
            const chatType = context.chatType === 'thread' ? 'thread' : (context.chatType === 'group' ? 'group' : 'dm');
            if (this.resetManager.shouldReset(entry, chatType, context.provider)) {
              log.info({ sessionKey, reason: 'policy' }, 'Session auto-reset');
              this.end(existingId);
              this.keyToId.delete(sessionKey);
              wasReset = true;
              // Fall through to create new
            } else {
              // Update the store entry timestamp
              this.sessionStore.set(sessionKey, {
                ...entry,
                updatedAt: new Date().toISOString(),
              });
              return { session, sessionKey, isNew: false, wasReset: false };
            }
          } else {
            return { session, sessionKey, isNew: false, wasReset: false };
          }
        } else {
          return { session, sessionKey, isNew: false, wasReset: false };
        }
      }
    }

    // Create new session
    const session = this.create({
      userId: context.from,
      platform: context.provider,
      metadata: { sessionKey, chatType: context.chatType, groupId: context.groupId },
    });

    this.keyToId.set(sessionKey, session.id);

    // Create store entry
    if (this.sessionStore) {
      const entry: SessionEntry = {
        sessionId: session.id,
        sessionKey,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        contextTokens: 0,
        origin: {
          label: context.label,
          provider: context.provider,
          from: context.from,
          to: context.to,
          accountId: context.accountId,
          threadId: context.threadId,
        },
        channel: context.provider,
        room: context.groupId,
      };
      this.sessionStore.set(sessionKey, entry);
    }

    return { session, sessionKey, isNew: true, wasReset };
  }

  /**
   * Reset a session by key (e.g., from /new or /reset command).
   */
  resetSession(sessionKey: string): Session | null {
    const existingId = this.keyToId.get(sessionKey);
    if (existingId) {
      this.end(existingId);
    }
    this.keyToId.delete(sessionKey);

    if (this.sessionStore) {
      this.sessionStore.delete(sessionKey);
    }

    log.info({ sessionKey }, 'Session reset by command');
    return null;
  }

  getSessionStore(): SessionStore | null {
    return this.sessionStore;
  }

  getTranscriptManager(): TranscriptManager | null {
    return this.transcriptManager;
  }

  getIdentityResolver(): IdentityResolver | null {
    return this.identityResolver;
  }

  getResetManager(): SessionResetManager | null {
    return this.resetManager;
  }

  getSessionKeyForId(sessionId: string): string | null {
    for (const [key, id] of this.keyToId) {
      if (id === sessionId) return key;
    }
    return null;
  }

  // ─── Persistence ────────────────────────────────────────────────────────────

  private persistSession(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO sessions (id, user_id, platform, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.id,
      session.userId ?? null,
      session.platform ?? null,
      JSON.stringify(session.metadata),
      session.createdAt,
      session.updatedAt,
    );
  }

  private loadSession(sessionId: string): Session | undefined {
    const stmt = this.db.prepare('SELECT * FROM sessions WHERE id = ?');
    const row = stmt.get(sessionId) as {
      id: string;
      user_id: string | null;
      platform: string | null;
      metadata: string;
      created_at: number;
      updated_at: number;
    } | undefined;

    if (!row) return undefined;

    return {
      id: row.id,
      userId: row.user_id ?? undefined,
      platform: row.platform ?? undefined,
      messages: [],
      metadata: JSON.parse(row.metadata),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
