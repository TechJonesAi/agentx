import { describe, it, expect, beforeEach } from 'vitest';
import { DataEncryption, EncryptedColumnHelper } from '../../src/security/encryption.js';

describe('DataEncryption', () => {
  let enc: DataEncryption;

  describe('initWithPassword', () => {
    it('enables encryption', () => {
      enc = new DataEncryption();
      expect(enc.isEnabled()).toBe(false);
      enc.initWithPassword('my-secret-password');
      expect(enc.isEnabled()).toBe(true);
    });

    it('returns salt', () => {
      enc = new DataEncryption();
      const salt = enc.initWithPassword('password');
      expect(salt).toBeInstanceOf(Buffer);
      expect(salt.length).toBe(32);
    });

    it('produces same key with same password and salt', () => {
      const enc1 = new DataEncryption();
      const salt = enc1.initWithPassword('password');

      const enc2 = new DataEncryption();
      enc2.initWithPassword('password', salt);

      const plaintext = 'Hello, World!';
      const encrypted = enc1.encrypt(plaintext);
      // Different IVs mean different ciphertext, but decryption with same key works
      expect(enc2.decrypt(encrypted)).toBe(plaintext);
    });
  });

  describe('initWithKey', () => {
    it('accepts 32-byte key', () => {
      enc = new DataEncryption();
      const key = DataEncryption.generateKey();
      enc.initWithKey(key);
      expect(enc.isEnabled()).toBe(true);
    });

    it('rejects invalid key length', () => {
      enc = new DataEncryption();
      expect(() => enc.initWithKey(Buffer.from('too-short'))).toThrow('32 bytes');
    });
  });

  describe('encrypt/decrypt round-trip', () => {
    beforeEach(() => {
      enc = new DataEncryption();
      enc.initWithKey(DataEncryption.generateKey());
    });

    it('handles simple strings', () => {
      const plaintext = 'Hello, World!';
      const encrypted = enc.encrypt(plaintext);
      expect(encrypted).not.toBe(plaintext);
      expect(enc.decrypt(encrypted)).toBe(plaintext);
    });

    it('handles empty string', () => {
      const encrypted = enc.encrypt('');
      expect(enc.decrypt(encrypted)).toBe('');
    });

    it('handles unicode', () => {
      const plaintext = 'Hello 🌍 こんにちは مرحبا';
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('handles large content', () => {
      const plaintext = 'a'.repeat(100_000);
      expect(enc.decrypt(enc.encrypt(plaintext))).toBe(plaintext);
    });

    it('produces different ciphertext each time (random IV)', () => {
      const plaintext = 'same text';
      const enc1 = enc.encrypt(plaintext);
      const enc2 = enc.encrypt(plaintext);
      expect(enc1).not.toBe(enc2);
    });

    it('fails to decrypt with wrong key', () => {
      const encrypted = enc.encrypt('secret');

      const wrongEnc = new DataEncryption();
      wrongEnc.initWithKey(DataEncryption.generateKey());

      expect(() => wrongEnc.decrypt(encrypted)).toThrow();
    });
  });

  describe('maybeEncrypt/maybeDecrypt', () => {
    it('passes through when encryption is disabled', () => {
      enc = new DataEncryption();
      expect(enc.maybeEncrypt('hello')).toBe('hello');
      expect(enc.maybeDecrypt('hello')).toBe('hello');
    });

    it('encrypts when enabled', () => {
      enc = new DataEncryption();
      enc.initWithKey(DataEncryption.generateKey());
      const result = enc.maybeEncrypt('hello');
      expect(result).not.toBe('hello');
      expect(enc.maybeDecrypt(result)).toBe('hello');
    });

    it('handles plaintext fallback in maybeDecrypt', () => {
      enc = new DataEncryption();
      enc.initWithKey(DataEncryption.generateKey());
      // maybeDecrypt should return plaintext if decryption fails (migration path)
      expect(enc.maybeDecrypt('not-encrypted-plaintext')).toBe('not-encrypted-plaintext');
    });
  });

  describe('static methods', () => {
    it('generateKey produces 32-byte Buffer', () => {
      const key = DataEncryption.generateKey();
      expect(key.length).toBe(32);
    });

    it('hash produces consistent SHA-256 hex', () => {
      const hash1 = DataEncryption.hash('hello');
      const hash2 = DataEncryption.hash('hello');
      expect(hash1).toBe(hash2);
      expect(hash1.length).toBe(64); // 256-bit = 64 hex chars
    });

    it('hash produces different output for different input', () => {
      expect(DataEncryption.hash('hello')).not.toBe(DataEncryption.hash('world'));
    });

    it('secureWipe zeros out buffer', () => {
      const buf = Buffer.from('secret data');
      DataEncryption.secureWipe(buf);
      expect(buf.every((b) => b === 0)).toBe(true);
    });
  });
});

describe('EncryptedColumnHelper', () => {
  it('encrypts and decrypts columns when enabled', () => {
    const enc = new DataEncryption();
    enc.initWithKey(DataEncryption.generateKey());
    const helper = new EncryptedColumnHelper(enc);

    expect(helper.isEnabled()).toBe(true);
    const encrypted = helper.encryptColumn('sensitive data');
    expect(encrypted).not.toBe('sensitive data');
    expect(helper.decryptColumn(encrypted)).toBe('sensitive data');
  });

  it('passes through when disabled', () => {
    const enc = new DataEncryption();
    const helper = new EncryptedColumnHelper(enc);

    expect(helper.isEnabled()).toBe(false);
    expect(helper.encryptColumn('data')).toBe('data');
    expect(helper.decryptColumn('data')).toBe('data');
  });
});
