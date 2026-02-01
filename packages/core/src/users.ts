import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import { createLogger } from './logger.js';

const log = createLogger('users');

// ─── Types ──────────────────────────────────────────────────────────────────

export type UserStatus = 'active' | 'pending' | 'denied' | 'banned';

export interface UserProfile {
  id: string;
  name: string;
  /** Platform-specific identifiers, e.g. { telegram: '123456', discord: '789' } */
  platformIds: Record<string, string>;
  preferences: Record<string, unknown>;
  systemPrompt?: string;
  status: UserStatus;
  isOwner: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface PlatformIdentity {
  platform: string;
  platformUserId: string;
}

export interface MultiUserConfig {
  /** false = single owner only, true = allow others with approval */
  multiUserMode: boolean;
  /** Require owner to approve new users before they can chat */
  requireOwnerApproval: boolean;
  /** Owner identity, e.g. 'telegram:123456789' */
  ownerPlatformId: string;
}

type ApprovalRequestCallback = (user: UserProfile) => Promise<void>;

// ─── User Manager ───────────────────────────────────────────────────────────

export class UserManager {
  private db: Database.Database;
  private multiUserConfig: MultiUserConfig;
  private approvalCallback: ApprovalRequestCallback | null = null;

  constructor(db: Database.Database, config?: Partial<MultiUserConfig>) {
    this.db = db;
    this.multiUserConfig = {
      multiUserMode: config?.multiUserMode ?? false,
      requireOwnerApproval: config?.requireOwnerApproval ?? true,
      ownerPlatformId: config?.ownerPlatformId ?? '',
    };
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        platform_ids TEXT NOT NULL DEFAULT '{}',
        preferences TEXT NOT NULL DEFAULT '{}',
        system_prompt TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        is_owner INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_users_name ON users(name);
      CREATE INDEX IF NOT EXISTS idx_users_status ON users(status);
    `);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_platform_map (
        platform TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (platform, platform_user_id)
      );
    `);

    // Per-user memory isolation table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_memory (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_user_memory_user ON user_memory(user_id);
    `);
  }

  setApprovalCallback(cb: ApprovalRequestCallback): void {
    this.approvalCallback = cb;
  }

  getMultiUserConfig(): MultiUserConfig {
    return { ...this.multiUserConfig };
  }

  updateMultiUserConfig(updates: Partial<MultiUserConfig>): void {
    Object.assign(this.multiUserConfig, updates);
  }

  // ─── Owner management ───────────────────────────────────────────────────

  /**
   * Check if the given platform identity is the owner.
   */
  isOwnerIdentity(platform: string, platformUserId: string): boolean {
    return this.multiUserConfig.ownerPlatformId === `${platform}:${platformUserId}`;
  }

  isOwner(userId: string): boolean {
    const user = this.get(userId);
    return user?.isOwner ?? false;
  }

  /**
   * Set the owner by platform identity. Ensures only one owner exists.
   */
  setOwner(platform: string, platformUserId: string, name?: string): UserProfile {
    // Clear any existing owner
    this.db.prepare('UPDATE users SET is_owner = 0 WHERE is_owner = 1').run();

    const user = this.resolveFromPlatform(platform, platformUserId, name ?? 'Owner');

    this.db.prepare('UPDATE users SET is_owner = 1, status = ? WHERE id = ?')
      .run('active', user.id);

    this.multiUserConfig.ownerPlatformId = `${platform}:${platformUserId}`;

    user.isOwner = true;
    user.status = 'active';

    log.info({ userId: user.id, platform, platformUserId }, 'Owner set');
    return user;
  }

  // ─── Access control ─────────────────────────────────────────────────────

  /**
   * Check if a platform identity is allowed to chat.
   * In single-user mode, only the owner can chat.
   * In multi-user mode with approval, pending users are blocked.
   */
  canAccess(platform: string, platformUserId: string): { allowed: boolean; reason?: string; user?: UserProfile } {
    // Owner always has access
    if (this.isOwnerIdentity(platform, platformUserId)) {
      const user = this.resolveFromPlatform(platform, platformUserId, 'Owner');
      if (!user.isOwner) {
        this.db.prepare('UPDATE users SET is_owner = 1, status = ? WHERE id = ?')
          .run('active', user.id);
        user.isOwner = true;
        user.status = 'active';
      }
      return { allowed: true, user };
    }

    // Single-user mode: deny everyone except owner
    if (!this.multiUserConfig.multiUserMode) {
      return { allowed: false, reason: 'Agent is in single-user mode. Only the owner can interact.' };
    }

    // Multi-user mode: check if user exists and their status
    const mapping = this.db.prepare(
      'SELECT user_id FROM user_platform_map WHERE platform = ? AND platform_user_id = ?',
    ).get(platform, platformUserId) as { user_id: string } | undefined;

    if (mapping) {
      const user = this.get(mapping.user_id);
      if (user) {
        switch (user.status) {
          case 'active':
            return { allowed: true, user };
          case 'pending':
            return { allowed: false, reason: 'Your access request is pending owner approval.' };
          case 'denied':
            return { allowed: false, reason: 'Your access has been denied.' };
          case 'banned':
            return { allowed: false, reason: 'You have been banned from this agent.' };
        }
      }
    }

    // New user: handle based on approval setting
    if (this.multiUserConfig.requireOwnerApproval) {
      const user = this.createPending(platform, platformUserId);
      return { allowed: false, reason: 'Access requested. Waiting for owner approval.', user };
    }

    // No approval required: auto-approve
    const user = this.resolveFromPlatform(platform, platformUserId);
    return { allowed: true, user };
  }

  private createPending(platform: string, platformUserId: string): UserProfile {
    const name = `${platform}:${platformUserId}`;
    const user: UserProfile = {
      id: uuid(),
      name,
      platformIds: { [platform]: platformUserId },
      preferences: {},
      status: 'pending',
      isOwner: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.db.prepare(`
      INSERT INTO users (id, name, platform_ids, preferences, system_prompt, status, is_owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id, user.name, JSON.stringify(user.platformIds), JSON.stringify(user.preferences),
      null, user.status, 0, user.createdAt, user.updatedAt,
    );

    this.updatePlatformMappings(user.id, user.platformIds);

    log.info({ userId: user.id, platform, platformUserId }, 'Pending user created');

    // Notify owner
    if (this.approvalCallback) {
      this.approvalCallback(user).catch((err) => {
        log.error({ error: err }, 'Failed to send approval request');
      });
    }

    return user;
  }

  approveUser(userId: string): boolean {
    const result = this.db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run('active', Date.now(), userId, 'pending');
    if (result.changes > 0) {
      log.info({ userId }, 'User approved');
      return true;
    }
    return false;
  }

  denyUser(userId: string): boolean {
    const result = this.db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ? AND status = ?')
      .run('denied', Date.now(), userId, 'pending');
    if (result.changes > 0) {
      log.info({ userId }, 'User denied');
      return true;
    }
    return false;
  }

  banUser(userId: string): boolean {
    const user = this.get(userId);
    if (user?.isOwner) return false; // Can't ban the owner

    const result = this.db.prepare('UPDATE users SET status = ?, updated_at = ? WHERE id = ?')
      .run('banned', Date.now(), userId);
    if (result.changes > 0) {
      log.info({ userId }, 'User banned');
      return true;
    }
    return false;
  }

  getPendingApprovals(): UserProfile[] {
    const rows = this.db.prepare("SELECT * FROM users WHERE status = 'pending' ORDER BY created_at ASC")
      .all() as UserRow[];
    return rows.map((row) => this.rowToProfile(row));
  }

  // ─── Per-user memory isolation ──────────────────────────────────────────

  storeUserMemory(userId: string, content: string, tags: string[] = []): string {
    const id = uuid();
    this.db.prepare(`
      INSERT INTO user_memory (id, user_id, content, tags, created_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, userId, content, JSON.stringify(tags), Date.now(), Date.now());
    return id;
  }

  searchUserMemory(userId: string, query: string, limit = 10): Array<{ id: string; content: string; tags: string[] }> {
    const rows = this.db.prepare(`
      SELECT id, content, tags FROM user_memory
      WHERE user_id = ? AND content LIKE ?
      ORDER BY accessed_at DESC
      LIMIT ?
    `).all(userId, `%${query}%`, limit) as Array<{ id: string; content: string; tags: string }>;

    return rows.map((r) => ({
      id: r.id,
      content: r.content,
      tags: JSON.parse(r.tags) as string[],
    }));
  }

  searchUserMemoryByTags(userId: string, tags: string[]): Array<{ id: string; content: string; tags: string[] }> {
    // SQLite JSON matching: check if any of the requested tags appear
    const rows = this.db.prepare(`
      SELECT id, content, tags FROM user_memory
      WHERE user_id = ?
      ORDER BY accessed_at DESC
    `).all(userId) as Array<{ id: string; content: string; tags: string }>;

    return rows
      .filter((r) => {
        const rowTags = JSON.parse(r.tags) as string[];
        return tags.some((t) => rowTags.includes(t));
      })
      .map((r) => ({
        id: r.id,
        content: r.content,
        tags: JSON.parse(r.tags) as string[],
      }));
  }

  deleteUserMemory(userId: string): number {
    const result = this.db.prepare('DELETE FROM user_memory WHERE user_id = ?').run(userId);
    return result.changes;
  }

  // ─── Core CRUD ──────────────────────────────────────────────────────────

  create(name: string, platformIds?: Record<string, string>): UserProfile {
    const user: UserProfile = {
      id: uuid(),
      name,
      platformIds: platformIds ?? {},
      preferences: {},
      status: 'active',
      isOwner: false,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.db.prepare(`
      INSERT INTO users (id, name, platform_ids, preferences, system_prompt, status, is_owner, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.id, user.name, JSON.stringify(user.platformIds), JSON.stringify(user.preferences),
      null, user.status, 0, user.createdAt, user.updatedAt,
    );

    this.updatePlatformMappings(user.id, user.platformIds);

    log.info({ userId: user.id, name }, 'User created');
    return user;
  }

  get(userId: string): UserProfile | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId) as UserRow | undefined;
    return row ? this.rowToProfile(row) : undefined;
  }

  resolveFromPlatform(platform: string, platformUserId: string, fallbackName?: string): UserProfile {
    const mapping = this.db.prepare(
      'SELECT user_id FROM user_platform_map WHERE platform = ? AND platform_user_id = ?',
    ).get(platform, platformUserId) as { user_id: string } | undefined;

    if (mapping) {
      const user = this.get(mapping.user_id);
      if (user) return user;
    }

    const name = fallbackName ?? `${platform}:${platformUserId}`;
    const user = this.create(name, { [platform]: platformUserId });
    log.info({ userId: user.id, platform, platformUserId }, 'Auto-created user from platform identity');
    return user;
  }

  linkPlatform(userId: string, platform: string, platformUserId: string): void {
    const user = this.get(userId);
    if (!user) throw new Error(`User not found: ${userId}`);

    user.platformIds[platform] = platformUserId;
    user.updatedAt = Date.now();

    this.db.prepare('UPDATE users SET platform_ids = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(user.platformIds), user.updatedAt, userId);

    this.db.prepare(
      'INSERT OR REPLACE INTO user_platform_map (platform, platform_user_id, user_id) VALUES (?, ?, ?)',
    ).run(platform, platformUserId, userId);

    log.info({ userId, platform, platformUserId }, 'Platform linked to user');
  }

  mergeUsers(targetId: string, sourceId: string): UserProfile {
    const target = this.get(targetId);
    const source = this.get(sourceId);

    if (!target) throw new Error(`Target user not found: ${targetId}`);
    if (!source) throw new Error(`Source user not found: ${sourceId}`);

    for (const [platform, pid] of Object.entries(source.platformIds)) {
      if (!target.platformIds[platform]) {
        target.platformIds[platform] = pid;
      }
    }

    for (const [key, value] of Object.entries(source.preferences)) {
      if (!(key in target.preferences)) {
        target.preferences[key] = value;
      }
    }

    target.updatedAt = Date.now();

    this.db.prepare(
      'UPDATE users SET platform_ids = ?, preferences = ?, updated_at = ? WHERE id = ?',
    ).run(JSON.stringify(target.platformIds), JSON.stringify(target.preferences), target.updatedAt, targetId);

    this.db.prepare('UPDATE user_platform_map SET user_id = ? WHERE user_id = ?').run(targetId, sourceId);
    this.db.prepare('UPDATE sessions SET user_id = ? WHERE user_id = ?').run(targetId, sourceId);
    this.db.prepare('UPDATE user_memory SET user_id = ? WHERE user_id = ?').run(targetId, sourceId);
    this.db.prepare('DELETE FROM users WHERE id = ?').run(sourceId);

    log.info({ targetId, sourceId }, 'Users merged');
    return target;
  }

  update(userId: string, updates: Partial<Pick<UserProfile, 'name' | 'preferences' | 'systemPrompt'>>): UserProfile | undefined {
    const user = this.get(userId);
    if (!user) return undefined;

    if (updates.name !== undefined) user.name = updates.name;
    if (updates.preferences !== undefined) user.preferences = { ...user.preferences, ...updates.preferences };
    if (updates.systemPrompt !== undefined) user.systemPrompt = updates.systemPrompt;
    user.updatedAt = Date.now();

    this.db.prepare(
      'UPDATE users SET name = ?, preferences = ?, system_prompt = ?, updated_at = ? WHERE id = ?',
    ).run(user.name, JSON.stringify(user.preferences), user.systemPrompt ?? null, user.updatedAt, userId);

    log.info({ userId }, 'User updated');
    return user;
  }

  delete(userId: string): boolean {
    const result = this.db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    if (result.changes > 0) {
      log.info({ userId }, 'User deleted');
      return true;
    }
    return false;
  }

  list(): UserProfile[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY name').all() as UserRow[];
    return rows.map((row) => this.rowToProfile(row));
  }

  getUserSessions(userId: string): Array<{ id: string; platform: string | null; updatedAt: number }> {
    const rows = this.db.prepare(
      'SELECT id, platform, updated_at FROM sessions WHERE user_id = ? ORDER BY updated_at DESC',
    ).all(userId) as Array<{ id: string; platform: string | null; updated_at: number }>;

    return rows.map((r) => ({
      id: r.id,
      platform: r.platform,
      updatedAt: r.updated_at,
    }));
  }

  private updatePlatformMappings(userId: string, platformIds: Record<string, string>): void {
    const stmt = this.db.prepare(
      'INSERT OR REPLACE INTO user_platform_map (platform, platform_user_id, user_id) VALUES (?, ?, ?)',
    );
    for (const [platform, pid] of Object.entries(platformIds)) {
      stmt.run(platform, pid, userId);
    }
  }

  private rowToProfile(row: UserRow): UserProfile {
    return {
      id: row.id,
      name: row.name,
      platformIds: JSON.parse(row.platform_ids),
      preferences: JSON.parse(row.preferences),
      systemPrompt: row.system_prompt ?? undefined,
      status: row.status as UserStatus,
      isOwner: row.is_owner === 1,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}

interface UserRow {
  id: string;
  name: string;
  platform_ids: string;
  preferences: string;
  system_prompt: string | null;
  status: string;
  is_owner: number;
  created_at: number;
  updated_at: number;
}
