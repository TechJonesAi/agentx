import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PermissionManager } from '../../src/security/permissions.js';
import type { SkillManifest } from '../../src/types.js';

function makeManifest(name: string, permissions: string[]): SkillManifest {
  return {
    name,
    version: '1.0.0',
    description: `Test skill ${name}`,
    permissions,
    tools: [],
  } as unknown as SkillManifest;
}

describe('PermissionManager', () => {
  let tmpDir: string;
  let pm: PermissionManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-perm-test-'));
    pm = new PermissionManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('hasPermission', () => {
    it('returns false for unganted skill', () => {
      expect(pm.hasPermission('unknown-skill', 'network')).toBe(false);
    });

    it('returns true after granting', () => {
      pm.grantPermissions('my-skill', ['network', 'filesystem.read']);
      expect(pm.hasPermission('my-skill', 'network')).toBe(true);
      expect(pm.hasPermission('my-skill', 'filesystem.read')).toBe(true);
      expect(pm.hasPermission('my-skill', 'shell')).toBe(false);
    });
  });

  describe('hasAllPermissions', () => {
    it('returns true when all are granted', () => {
      pm.grantPermissions('my-skill', ['network', 'browser']);
      expect(pm.hasAllPermissions('my-skill', ['network', 'browser'])).toBe(true);
    });

    it('returns false when some are missing', () => {
      pm.grantPermissions('my-skill', ['network']);
      expect(pm.hasAllPermissions('my-skill', ['network', 'browser'])).toBe(false);
    });
  });

  describe('getMissingPermissions', () => {
    it('returns all permissions when none granted', () => {
      const manifest = makeManifest('my-skill', ['network', 'shell']);
      const missing = pm.getMissingPermissions(manifest);
      expect(missing).toContain('network');
      expect(missing).toContain('shell');
    });

    it('returns only missing permissions', () => {
      pm.grantPermissions('my-skill', ['network']);
      const manifest = makeManifest('my-skill', ['network', 'shell']);
      const missing = pm.getMissingPermissions(manifest);
      expect(missing).toEqual(['shell']);
    });

    it('returns empty array when all granted', () => {
      pm.grantPermissions('my-skill', ['network', 'shell']);
      const manifest = makeManifest('my-skill', ['network', 'shell']);
      expect(pm.getMissingPermissions(manifest)).toEqual([]);
    });
  });

  describe('grantPermissions', () => {
    it('merges with existing permissions', () => {
      pm.grantPermissions('my-skill', ['network']);
      pm.grantPermissions('my-skill', ['shell']);
      expect(pm.hasPermission('my-skill', 'network')).toBe(true);
      expect(pm.hasPermission('my-skill', 'shell')).toBe(true);
    });

    it('persists to disk', () => {
      pm.grantPermissions('my-skill', ['network']);

      const pm2 = new PermissionManager(tmpDir);
      expect(pm2.hasPermission('my-skill', 'network')).toBe(true);
    });
  });

  describe('revokePermissions', () => {
    it('revokes all permissions for a skill', () => {
      pm.grantPermissions('my-skill', ['network', 'shell']);
      pm.revokePermissions('my-skill');
      expect(pm.hasPermission('my-skill', 'network')).toBe(false);
      expect(pm.hasPermission('my-skill', 'shell')).toBe(false);
    });
  });

  describe('revokePermission', () => {
    it('revokes a single permission', () => {
      pm.grantPermissions('my-skill', ['network', 'shell']);
      pm.revokePermission('my-skill', 'shell');
      expect(pm.hasPermission('my-skill', 'network')).toBe(true);
      expect(pm.hasPermission('my-skill', 'shell')).toBe(false);
    });

    it('removes grant entirely when last permission revoked', () => {
      pm.grantPermissions('my-skill', ['network']);
      pm.revokePermission('my-skill', 'network');
      expect(pm.listGrants().find((g) => g.skillName === 'my-skill')).toBeUndefined();
    });
  });

  describe('listGrants', () => {
    it('returns all grants', () => {
      pm.grantPermissions('skill-a', ['network']);
      pm.grantPermissions('skill-b', ['shell', 'browser']);

      const grants = pm.listGrants();
      expect(grants).toHaveLength(2);
      expect(grants.map((g) => g.skillName)).toContain('skill-a');
      expect(grants.map((g) => g.skillName)).toContain('skill-b');
    });
  });

  describe('validateManifest', () => {
    it('validates correct permissions', () => {
      const manifest = makeManifest('my-skill', ['network', 'browser']);
      const result = pm.validateManifest(manifest);
      expect(result.valid).toBe(true);
      expect(result.invalidPermissions).toEqual([]);
    });

    it('identifies invalid permissions', () => {
      const manifest = makeManifest('my-skill', ['network', 'teleport']);
      const result = pm.validateManifest(manifest);
      expect(result.valid).toBe(false);
      expect(result.invalidPermissions).toContain('teleport');
    });

    it('identifies dangerous permissions', () => {
      const manifest = makeManifest('my-skill', ['shell', 'credentials', 'filesystem.write']);
      const result = pm.validateManifest(manifest);
      expect(result.dangerousPermissions).toHaveLength(3);
      expect(result.requiresApproval).toBe(true);
    });

    it('marks approval required when any permissions requested', () => {
      const manifest = makeManifest('my-skill', ['network']);
      expect(pm.validateManifest(manifest).requiresApproval).toBe(true);
    });
  });

  describe('verifySkillChecksum', () => {
    it('returns true when no expected checksum', async () => {
      expect(await pm.verifySkillChecksum('/nonexistent')).toBe(true);
    });
  });
});
