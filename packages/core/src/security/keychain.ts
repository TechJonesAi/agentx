import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('security:keychain');

const SERVICE_NAME = 'agentx';
const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32;
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SALT_LENGTH = 32;
const PBKDF2_ITERATIONS = 100000;

// ─── OS Keychain Backend ─────────────────────────────────────────────────────

interface KeychainBackend {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

class KeytarBackend implements KeychainBackend {
  private keytar: typeof import('keytar') | null = null;
  private loadError: string | null = null;

  private async getKeytar() {
    if (this.keytar) return this.keytar;
    if (this.loadError) return null;

    try {
      this.keytar = await import('keytar');
      return this.keytar;
    } catch (error) {
      this.loadError = error instanceof Error ? error.message : String(error);
      log.warn({ error: this.loadError }, 'keytar not available, falling back to encrypted file storage');
      return null;
    }
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    const kt = await this.getKeytar();
    if (!kt) return null;
    return kt.getPassword(service, account);
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    const kt = await this.getKeytar();
    if (!kt) throw new Error('OS keychain not available');
    await kt.setPassword(service, account, password);
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const kt = await this.getKeytar();
    if (!kt) return false;
    return kt.deletePassword(service, account);
  }
}

// ─── Encrypted File Backend (fallback when keychain unavailable) ─────────────

class EncryptedFileBackend implements KeychainBackend {
  private filePath: string;
  private masterKey: Buffer | null = null;

  constructor(dataDir: string) {
    this.filePath = path.join(dataDir, '.credentials.enc');
  }

  setMasterKey(key: Buffer): void {
    this.masterKey = key;
  }

  deriveMasterKey(password: string, salt?: Buffer): { key: Buffer; salt: Buffer } {
    const useSalt = salt ?? crypto.randomBytes(SALT_LENGTH);
    const key = crypto.pbkdf2Sync(password, useSalt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha512');
    return { key, salt: useSalt };
  }

  private encrypt(plaintext: string, key: Buffer): Buffer {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf-8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    // Format: [salt_len(1)][salt][iv][tag][ciphertext]
    return Buffer.concat([iv, tag, encrypted]);
  }

  private decrypt(data: Buffer, key: Buffer): string {
    const iv = data.subarray(0, IV_LENGTH);
    const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
    const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf-8');
  }

  private readStore(): Record<string, Record<string, string>> {
    if (!this.masterKey || !fs.existsSync(this.filePath)) {
      return {};
    }

    try {
      const raw = fs.readFileSync(this.filePath);
      // First 32 bytes are salt, rest is encrypted
      const salt = raw.subarray(0, SALT_LENGTH);
      const encrypted = raw.subarray(SALT_LENGTH);
      const decrypted = this.decrypt(encrypted, this.masterKey);
      return JSON.parse(decrypted);
    } catch (error) {
      log.error({ error }, 'Failed to decrypt credential store');
      return {};
    }
  }

  private writeStore(store: Record<string, Record<string, string>>): void {
    if (!this.masterKey) throw new Error('Master key not set');

    const plaintext = JSON.stringify(store);
    const encrypted = this.encrypt(plaintext, this.masterKey);
    const salt = crypto.randomBytes(SALT_LENGTH);
    const output = Buffer.concat([salt, encrypted]);

    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.filePath, output, { mode: 0o600 });
  }

  async getPassword(service: string, account: string): Promise<string | null> {
    const store = this.readStore();
    return store[service]?.[account] ?? null;
  }

  async setPassword(service: string, account: string, password: string): Promise<void> {
    const store = this.readStore();
    if (!store[service]) store[service] = {};
    store[service]![account] = password;
    this.writeStore(store);
  }

  async deletePassword(service: string, account: string): Promise<boolean> {
    const store = this.readStore();
    if (!store[service]?.[account]) return false;
    delete store[service]![account];
    this.writeStore(store);
    return true;
  }
}

// ─── Credential Manager ──────────────────────────────────────────────────────

export type CredentialKey =
  | 'ANTHROPIC_API_KEY'
  | 'OPENAI_API_KEY'
  | 'TELEGRAM_BOT_TOKEN'
  | 'DISCORD_BOT_TOKEN'
  | 'SLACK_BOT_TOKEN'
  | 'SLACK_SIGNING_SECRET'
  | 'ELEVENLABS_API_KEY'
  | string;

export class CredentialManager {
  private keytarBackend: KeytarBackend;
  private fileBackend: EncryptedFileBackend;
  private useKeychain = true;
  private initialized = false;

  constructor(dataDir: string) {
    this.keytarBackend = new KeytarBackend();
    this.fileBackend = new EncryptedFileBackend(dataDir);
  }

  async initialize(masterPassword?: string): Promise<void> {
    // Try keychain first
    try {
      await this.keytarBackend.setPassword(SERVICE_NAME, '__test__', 'test');
      await this.keytarBackend.deletePassword(SERVICE_NAME, '__test__');
      this.useKeychain = true;
      log.info('Using OS keychain for credential storage');
    } catch {
      this.useKeychain = false;
      if (masterPassword) {
        const { key } = this.fileBackend.deriveMasterKey(masterPassword);
        this.fileBackend.setMasterKey(key);
        log.info('Using encrypted file storage for credentials');
      } else {
        log.warn('No keychain and no master password - credentials will use env vars only');
      }
    }
    this.initialized = true;
  }

  private getBackend(): KeychainBackend {
    return this.useKeychain ? this.keytarBackend : this.fileBackend;
  }

  async getCredential(key: CredentialKey): Promise<string | null> {
    // Always check env first (allows overrides)
    const envVal = process.env[key];
    if (envVal) return envVal;

    if (!this.initialized) return null;

    try {
      return await this.getBackend().getPassword(SERVICE_NAME, key);
    } catch (error) {
      log.debug({ key, error }, 'Failed to read from credential store');
      return null;
    }
  }

  async setCredential(key: CredentialKey, value: string): Promise<void> {
    if (!this.initialized) {
      throw new Error('CredentialManager not initialized');
    }
    await this.getBackend().setPassword(SERVICE_NAME, key, value);
    log.info({ key }, 'Credential stored');
  }

  async deleteCredential(key: CredentialKey): Promise<boolean> {
    if (!this.initialized) return false;
    return this.getBackend().deletePassword(SERVICE_NAME, key);
  }

  async listCredentials(): Promise<string[]> {
    // We don't enumerate keychain - just report known keys that have values
    const knownKeys: CredentialKey[] = [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'TELEGRAM_BOT_TOKEN',
      'DISCORD_BOT_TOKEN',
      'SLACK_BOT_TOKEN',
      'ELEVENLABS_API_KEY',
    ];

    const present: string[] = [];
    for (const key of knownKeys) {
      const val = await this.getCredential(key);
      if (val) present.push(key);
    }
    return present;
  }

  isKeychainAvailable(): boolean {
    return this.useKeychain;
  }
}

// ─── Utility: redact secrets from strings ────────────────────────────────────

const SECRET_PATTERNS = [
  /sk-[a-zA-Z0-9]{20,}/g,           // OpenAI
  /sk-ant-[a-zA-Z0-9-]{20,}/g,      // Anthropic
  /xoxb-[a-zA-Z0-9-]{20,}/g,        // Slack
  /[0-9]+:[a-zA-Z0-9_-]{35,}/g,     // Telegram
];

export function redactSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, '[REDACTED]');
  }
  return result;
}
