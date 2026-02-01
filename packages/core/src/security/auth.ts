import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('security:auth');

const PBKDF2_ITERATIONS = 100000;
const SALT_LENGTH = 32;
const HASH_LENGTH = 64;
const MAX_FAILED_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 5 * 60 * 1000; // 5 minutes

interface AuthState {
  passwordHash: string;
  salt: string;
  failedAttempts: number;
  lastFailedAt: number;
  lockedUntil: number;
  autoLockMinutes: number;
  lastActivityAt: number;
}

export class LocalAuth {
  private authFile: string;
  private state: AuthState | null = null;
  private unlocked = false;
  private lastActivity = Date.now();

  constructor(dataDir: string) {
    this.authFile = path.join(dataDir, '.auth');
    this.loadState();
  }

  private loadState(): void {
    if (fs.existsSync(this.authFile)) {
      try {
        const raw = fs.readFileSync(this.authFile, 'utf-8');
        this.state = JSON.parse(raw) as AuthState;
      } catch {
        log.error('Failed to load auth state');
        this.state = null;
      }
    }
  }

  private saveState(): void {
    if (!this.state) return;

    const dir = path.dirname(this.authFile);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(this.authFile, JSON.stringify(this.state), { mode: 0o600 });
  }

  private hashPassword(password: string, salt: Buffer): string {
    return crypto.pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, HASH_LENGTH, 'sha512').toString('hex');
  }

  /**
   * Check if local auth is configured (password set).
   */
  isConfigured(): boolean {
    return this.state !== null;
  }

  /**
   * Set up a new PIN/password for local auth.
   */
  setup(password: string, autoLockMinutes = 30): void {
    const salt = crypto.randomBytes(SALT_LENGTH);
    const hash = this.hashPassword(password, salt);

    this.state = {
      passwordHash: hash,
      salt: salt.toString('hex'),
      failedAttempts: 0,
      lastFailedAt: 0,
      lockedUntil: 0,
      autoLockMinutes,
      lastActivityAt: Date.now(),
    };

    this.saveState();
    this.unlocked = true;
    this.lastActivity = Date.now();
    log.info('Local authentication configured');
  }

  /**
   * Attempt to unlock with a password.
   */
  unlock(password: string): AuthResult {
    if (!this.state) {
      return { success: true, message: 'Auth not configured' };
    }

    // Check lockout
    if (this.isLockedOut()) {
      const remaining = Math.ceil((this.state.lockedUntil - Date.now()) / 1000);
      return {
        success: false,
        message: `Account locked. Try again in ${remaining} seconds.`,
        lockedOut: true,
      };
    }

    const salt = Buffer.from(this.state.salt, 'hex');
    const hash = this.hashPassword(password, salt);

    if (crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(this.state.passwordHash, 'hex'))) {
      // Success
      this.state.failedAttempts = 0;
      this.state.lastActivityAt = Date.now();
      this.saveState();
      this.unlocked = true;
      this.lastActivity = Date.now();
      log.info('Authentication successful');
      return { success: true, message: 'Authenticated' };
    }

    // Failed
    this.state.failedAttempts++;
    this.state.lastFailedAt = Date.now();

    if (this.state.failedAttempts >= MAX_FAILED_ATTEMPTS) {
      this.state.lockedUntil = Date.now() + LOCKOUT_DURATION_MS;
      this.saveState();
      log.warn({ attempts: this.state.failedAttempts }, 'Account locked due to failed attempts');
      return {
        success: false,
        message: `Too many failed attempts. Locked for ${LOCKOUT_DURATION_MS / 60000} minutes.`,
        lockedOut: true,
      };
    }

    this.saveState();
    const remaining = MAX_FAILED_ATTEMPTS - this.state.failedAttempts;
    log.warn({ attempts: this.state.failedAttempts, remaining }, 'Authentication failed');
    return {
      success: false,
      message: `Invalid password. ${remaining} attempts remaining.`,
      attemptsRemaining: remaining,
    };
  }

  /**
   * Check if currently unlocked and not auto-locked.
   */
  isUnlocked(): boolean {
    if (!this.state) return true; // No auth configured = always unlocked
    if (!this.unlocked) return false;

    // Check auto-lock
    if (this.state.autoLockMinutes > 0) {
      const elapsed = Date.now() - this.lastActivity;
      if (elapsed > this.state.autoLockMinutes * 60 * 1000) {
        this.lock();
        return false;
      }
    }

    return true;
  }

  /**
   * Record activity to prevent auto-lock.
   */
  touch(): void {
    this.lastActivity = Date.now();
  }

  /**
   * Lock the agent.
   */
  lock(): void {
    this.unlocked = false;
    log.info('Agent locked');
  }

  /**
   * Change the password.
   */
  changePassword(currentPassword: string, newPassword: string): AuthResult {
    const unlockResult = this.unlock(currentPassword);
    if (!unlockResult.success) return unlockResult;

    const salt = crypto.randomBytes(SALT_LENGTH);
    const hash = this.hashPassword(newPassword, salt);

    this.state!.passwordHash = hash;
    this.state!.salt = salt.toString('hex');
    this.state!.failedAttempts = 0;
    this.saveState();

    log.info('Password changed');
    return { success: true, message: 'Password changed' };
  }

  /**
   * Remove local auth entirely.
   */
  disable(password: string): AuthResult {
    const unlockResult = this.unlock(password);
    if (!unlockResult.success) return unlockResult;

    if (fs.existsSync(this.authFile)) {
      fs.unlinkSync(this.authFile);
    }
    this.state = null;
    this.unlocked = true;

    log.info('Local authentication disabled');
    return { success: true, message: 'Authentication disabled' };
  }

  isLockedOut(): boolean {
    if (!this.state) return false;
    return this.state.lockedUntil > Date.now();
  }

  getAutoLockMinutes(): number {
    return this.state?.autoLockMinutes ?? 0;
  }

  setAutoLockMinutes(minutes: number): void {
    if (this.state) {
      this.state.autoLockMinutes = minutes;
      this.saveState();
    }
  }
}

export interface AuthResult {
  success: boolean;
  message: string;
  lockedOut?: boolean;
  attemptsRemaining?: number;
}
