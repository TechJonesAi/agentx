import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CredentialManager, redactSecrets } from '../../src/security/keychain.js';

describe('CredentialManager', () => {
  let tmpDir: string;
  let cm: CredentialManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-cred-test-'));
    cm = new CredentialManager(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('before initialization', () => {
    it('getCredential returns null when not initialized', async () => {
      const result = await cm.getCredential('ANTHROPIC_API_KEY');
      expect(result).toBeNull();
    });

    it('setCredential throws when not initialized', async () => {
      await expect(cm.setCredential('ANTHROPIC_API_KEY', 'sk-test')).rejects.toThrow('not initialized');
    });
  });

  describe('with env var fallback', () => {
    const originalEnv = process.env['TEST_CRED_KEY'];

    afterEach(() => {
      if (originalEnv !== undefined) {
        process.env['TEST_CRED_KEY'] = originalEnv;
      } else {
        delete process.env['TEST_CRED_KEY'];
      }
    });

    it('reads from env var first', async () => {
      process.env['TEST_CRED_KEY'] = 'env-value';
      const result = await cm.getCredential('TEST_CRED_KEY');
      expect(result).toBe('env-value');
    });
  });

  describe('encrypted file backend', () => {
    it('initializes with master password', async () => {
      // keytar will likely not be available in test env, so it falls back to file backend
      await cm.initialize('test-master-password');
      // Should not throw and should be operational
    });

    it('stores and retrieves credentials after initialization', async () => {
      await cm.initialize('test-password');

      await cm.setCredential('MY_KEY', 'my-secret-value');
      const result = await cm.getCredential('MY_KEY');
      expect(result).toBe('my-secret-value');
    });

    it('deletes credentials', async () => {
      await cm.initialize('test-password');

      await cm.setCredential('MY_KEY', 'value');
      const deleted = await cm.deleteCredential('MY_KEY');
      expect(deleted).toBe(true);

      const result = await cm.getCredential('MY_KEY');
      expect(result).toBeNull();
    });
  });
});

describe('redactSecrets', () => {
  it('redacts OpenAI keys', () => {
    const text = 'My key is sk-1234567890abcdefghijklmnop';
    expect(redactSecrets(text)).toContain('[REDACTED]');
    expect(redactSecrets(text)).not.toContain('sk-1234567890');
  });

  it('redacts Anthropic keys', () => {
    const text = 'Key: sk-ant-abcdefghij1234567890-extra';
    expect(redactSecrets(text)).toContain('[REDACTED]');
    expect(redactSecrets(text)).not.toContain('sk-ant-');
  });

  it('redacts Slack tokens', () => {
    const text = 'Token: xoxb-fake-token-for-testing';
    expect(redactSecrets(text)).toContain('[REDACTED]');
  });

  it('leaves normal text unchanged', () => {
    const text = 'Hello, this is a normal message with no secrets.';
    expect(redactSecrets(text)).toBe(text);
  });
});
