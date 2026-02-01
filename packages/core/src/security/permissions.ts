import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SkillManifest } from '../types.js';
import { createLogger } from '../logger.js';
import { DataEncryption } from './encryption.js';

const log = createLogger('security:permissions');

// ─── Permission Definitions ──────────────────────────────────────────────────

export type PermissionType =
  | 'network'          // Make outbound network requests
  | 'filesystem.read'  // Read files
  | 'filesystem.write' // Write files
  | 'shell'            // Execute shell commands
  | 'memory.read'      // Read long-term memory
  | 'memory.write'     // Write long-term memory
  | 'browser'          // Control browser
  | 'integrations'     // Access chat integrations
  | 'scheduler'        // Create scheduled tasks
  | 'credentials';     // Access credential store

export interface PermissionGrant {
  skillName: string;
  permissions: PermissionType[];
  grantedAt: number;
  grantedBy: string; // 'user' or 'system'
}

// ─── Permission Manager ──────────────────────────────────────────────────────

export class PermissionManager {
  private grants = new Map<string, PermissionGrant>();
  private grantsFile: string;

  constructor(dataDir: string) {
    this.grantsFile = path.join(dataDir, 'permission-grants.json');
    this.loadGrants();
  }

  private loadGrants(): void {
    if (!fs.existsSync(this.grantsFile)) return;

    try {
      const raw = fs.readFileSync(this.grantsFile, 'utf-8');
      const grants = JSON.parse(raw) as PermissionGrant[];
      for (const grant of grants) {
        this.grants.set(grant.skillName, grant);
      }
    } catch (error) {
      log.error({ error }, 'Failed to load permission grants');
    }
  }

  private saveGrants(): void {
    const grants = Array.from(this.grants.values());
    const dir = path.dirname(this.grantsFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.grantsFile, JSON.stringify(grants, null, 2));
  }

  /**
   * Check if a skill has been granted a specific permission.
   */
  hasPermission(skillName: string, permission: PermissionType): boolean {
    const grant = this.grants.get(skillName);
    if (!grant) return false;
    return grant.permissions.includes(permission);
  }

  /**
   * Check if a skill has all required permissions.
   */
  hasAllPermissions(skillName: string, permissions: PermissionType[]): boolean {
    return permissions.every((p) => this.hasPermission(skillName, p));
  }

  /**
   * Get the list of permissions that a skill requests but hasn't been granted.
   */
  getMissingPermissions(manifest: SkillManifest): PermissionType[] {
    const grant = this.grants.get(manifest.name);
    if (!grant) return manifest.permissions as PermissionType[];

    return (manifest.permissions as PermissionType[]).filter(
      (p) => !grant.permissions.includes(p),
    );
  }

  /**
   * Grant permissions to a skill (after user approval).
   */
  grantPermissions(skillName: string, permissions: PermissionType[]): void {
    const existing = this.grants.get(skillName);
    const allPerms = existing
      ? [...new Set([...existing.permissions, ...permissions])]
      : permissions;

    this.grants.set(skillName, {
      skillName,
      permissions: allPerms,
      grantedAt: Date.now(),
      grantedBy: 'user',
    });
    this.saveGrants();
    log.info({ skillName, permissions: allPerms }, 'Permissions granted');
  }

  /**
   * Revoke all permissions for a skill.
   */
  revokePermissions(skillName: string): void {
    this.grants.delete(skillName);
    this.saveGrants();
    log.info({ skillName }, 'Permissions revoked');
  }

  /**
   * Revoke a specific permission from a skill.
   */
  revokePermission(skillName: string, permission: PermissionType): void {
    const grant = this.grants.get(skillName);
    if (!grant) return;

    grant.permissions = grant.permissions.filter((p) => p !== permission);
    if (grant.permissions.length === 0) {
      this.grants.delete(skillName);
    }
    this.saveGrants();
  }

  /**
   * Get all grants.
   */
  listGrants(): PermissionGrant[] {
    return Array.from(this.grants.values());
  }

  /**
   * Validate a skill manifest's requested permissions.
   */
  validateManifest(manifest: SkillManifest): ManifestValidation {
    const requestedPerms = manifest.permissions as string[];
    const validPerms: PermissionType[] = [
      'network', 'filesystem.read', 'filesystem.write', 'shell',
      'memory.read', 'memory.write', 'browser', 'integrations',
      'scheduler', 'credentials',
    ];

    const invalid = requestedPerms.filter((p) => !validPerms.includes(p as PermissionType));
    const dangerous = requestedPerms.filter((p) =>
      ['shell', 'credentials', 'filesystem.write'].includes(p),
    );

    return {
      valid: invalid.length === 0,
      invalidPermissions: invalid,
      dangerousPermissions: dangerous,
      requiresApproval: dangerous.length > 0 || requestedPerms.length > 0,
    };
  }

  /**
   * Verify skill integrity using SHA-256 checksum.
   */
  async verifySkillChecksum(skillPath: string, expectedChecksum?: string): Promise<boolean> {
    if (!expectedChecksum) return true; // No checksum to verify

    const manifestPath = path.join(skillPath, 'manifest.json');
    const indexPath = path.join(skillPath, 'index.js');

    const files = [manifestPath, indexPath].filter((f) => fs.existsSync(f));
    const contents = files.map((f) => fs.readFileSync(f, 'utf-8')).join('');
    const actual = DataEncryption.hash(contents);

    return actual === expectedChecksum;
  }
}

interface ManifestValidation {
  valid: boolean;
  invalidPermissions: string[];
  dangerousPermissions: string[];
  requiresApproval: boolean;
}
