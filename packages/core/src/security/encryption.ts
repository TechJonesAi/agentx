import * as crypto from 'node:crypto';
import { createLogger } from '../logger.js';

const log = createLogger('security:encryption');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

// ─── Encryption utilities for data at rest ───────────────────────────────────

export class DataEncryption {
  private key: Buffer | null = null;
  private enabled = false;

  /**
   * Initialize encryption with a master password.
   * Derives a 256-bit key using PBKDF2.
   */
  initWithPassword(password: string, salt?: Buffer): Buffer {
    const useSalt = salt ?? crypto.randomBytes(SALT_LENGTH);
    this.key = crypto.pbkdf2Sync(password, useSalt, PBKDF2_ITERATIONS, 32, 'sha512');
    this.enabled = true;
    return useSalt;
  }

  /**
   * Initialize encryption with a raw key (e.g., from OS keychain).
   */
  initWithKey(key: Buffer): void {
    if (key.length !== 32) {
      throw new Error('Encryption key must be 32 bytes');
    }
    this.key = key;
    this.enabled = true;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Encrypt a string. Returns base64-encoded ciphertext.
   * Format: [iv (12 bytes)][auth tag (16 bytes)][ciphertext]
   */
  encrypt(plaintext: string): string {
    if (!this.key) throw new Error('Encryption not initialized');

    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);

    const encrypted = Buffer.concat([
      cipher.update(plaintext, 'utf-8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    const combined = Buffer.concat([iv, tag, encrypted]);
    return combined.toString('base64');
  }

  /**
   * Decrypt a base64-encoded ciphertext.
   */
  decrypt(ciphertext: string): string {
    if (!this.key) throw new Error('Encryption not initialized');

    const data = Buffer.from(ciphertext, 'base64');
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const encrypted = data.subarray(IV_LENGTH + TAG_LENGTH);

    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(tag);

    return Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]).toString('utf-8');
  }

  /**
   * Conditionally encrypt: returns plaintext if encryption is disabled.
   */
  maybeEncrypt(plaintext: string): string {
    return this.enabled ? this.encrypt(plaintext) : plaintext;
  }

  /**
   * Conditionally decrypt: returns input as-is if encryption is disabled.
   */
  maybeDecrypt(data: string): string {
    if (!this.enabled) return data;

    try {
      return this.decrypt(data);
    } catch {
      // If decryption fails, assume it's plaintext (migration from unencrypted)
      return data;
    }
  }

  /**
   * Securely wipe a string from memory (best effort in JS).
   * Overwrites the Buffer backing the string.
   */
  static secureWipe(buffer: Buffer): void {
    crypto.randomFillSync(buffer);
    buffer.fill(0);
  }

  /**
   * Generate a random encryption key.
   */
  static generateKey(): Buffer {
    return crypto.randomBytes(32);
  }

  /**
   * Hash content for integrity verification.
   */
  static hash(content: string): string {
    return crypto.createHash('sha256').update(content).digest('hex');
  }
}

// ─── Encrypted SQLite wrapper ────────────────────────────────────────────────

/**
 * Wraps database operations with transparent encryption/decryption
 * for sensitive columns. This is application-level encryption since
 * better-sqlite3 doesn't support SQLCipher.
 */
export class EncryptedColumnHelper {
  private encryption: DataEncryption;

  constructor(encryption: DataEncryption) {
    this.encryption = encryption;
  }

  encryptColumn(value: string): string {
    return this.encryption.maybeEncrypt(value);
  }

  decryptColumn(value: string): string {
    return this.encryption.maybeDecrypt(value);
  }

  isEnabled(): boolean {
    return this.encryption.isEnabled();
  }
}
