import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createLogger } from '../logger.js';

const log = createLogger('sessions:identity');

export interface IdentityConfig {
  /** Canonical name → list of "platform:id" strings */
  links: Record<string, string[]>;
}

export class IdentityResolver {
  private links: Record<string, string[]>;
  private reverseLookup = new Map<string, string>();
  private configPath: string | null;

  constructor(config: IdentityConfig, configPath?: string) {
    this.links = { ...config.links };
    this.configPath = configPath ?? null;
    this.buildReverseLookup();
  }

  private buildReverseLookup(): void {
    this.reverseLookup.clear();
    for (const [canonical, ids] of Object.entries(this.links)) {
      for (const id of ids) {
        this.reverseLookup.set(id, canonical);
      }
    }
  }

  /**
   * Resolve a platform ID to a canonical identity.
   * @param platformId - Format: "platform:userId" (e.g., "telegram:123456789")
   */
  resolve(platformId: string): string {
    return this.reverseLookup.get(platformId) ?? platformId;
  }

  /**
   * Resolve from separate provider + userId.
   */
  resolveFrom(provider: string, userId: string): string {
    return this.resolve(`${provider}:${userId}`);
  }

  /**
   * Get all platform IDs for a canonical identity.
   */
  getPlatformIds(canonical: string): string[] {
    return this.links[canonical] ?? [];
  }

  /**
   * Link a new platform ID to a canonical identity.
   */
  link(canonical: string, platformId: string): void {
    if (!this.links[canonical]) {
      this.links[canonical] = [];
    }

    // Remove from any existing mapping
    this.unlink(platformId);

    this.links[canonical].push(platformId);
    this.reverseLookup.set(platformId, canonical);

    log.info({ canonical, platformId }, 'Identity linked');
    this.save();
  }

  /**
   * Remove a platform ID from its canonical mapping.
   */
  unlink(platformId: string): void {
    const existing = this.reverseLookup.get(platformId);
    if (existing && this.links[existing]) {
      this.links[existing] = this.links[existing].filter((id) => id !== platformId);
      if (this.links[existing].length === 0) {
        delete this.links[existing];
      }
      this.reverseLookup.delete(platformId);
      log.info({ platformId, wasCanonical: existing }, 'Identity unlinked');
      this.save();
    }
  }

  /**
   * List all identity mappings.
   */
  listAll(): Record<string, string[]> {
    return { ...this.links };
  }

  getConfig(): IdentityConfig {
    return { links: { ...this.links } };
  }

  private save(): void {
    if (!this.configPath) return;

    try {
      const dir = path.dirname(this.configPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.configPath, JSON.stringify({ links: this.links }, null, 2), 'utf-8');
    } catch (error) {
      log.error({ error: error instanceof Error ? error.message : String(error) }, 'Failed to save identity config');
    }
  }
}
