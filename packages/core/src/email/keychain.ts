/**
 * Keychain Integration — Secure credential retrieval from macOS Keychain.
 *
 * SECURITY: Credentials are NEVER stored in code, env vars, logs, or database.
 * Retrieved from macOS Keychain at runtime only, held briefly, then cleared.
 */

import { execSync } from 'node:child_process';
import { createLogger } from '../logger.js';

const log = createLogger('email:keychain');

const KEYCHAIN_SERVICE = 'agentx-email';

/**
 * Retrieve a password from macOS Keychain.
 * Returns the password string or null if not found.
 * CALLER IS RESPONSIBLE for clearing the returned string after use.
 */
export function getKeychainPassword(account: string): string | null {
  try {
    const password = execSync(
      `security find-generic-password -w -s "${KEYCHAIN_SERVICE}" -a "${account}"`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    ).trim();

    if (!password) {
      log.warn('Keychain returned empty password');
      return null;
    }

    // SECURITY: Do NOT log the password or any part of it
    log.info('Keychain credential retrieved successfully');
    return password;
  } catch (err) {
    // SECURITY: Only log safe error info — never the password or auth details
    const message = (err as Error).message || '';
    if (message.includes('could not be found')) {
      log.error({ account }, 'Keychain entry not found — user must store it via: security add-generic-password -s "agentx-email" -a "<email>" -w');
    } else {
      log.error('Keychain lookup failed — ensure macOS Keychain is unlocked');
    }
    return null;
  }
}

/**
 * Check if a Keychain entry exists (without retrieving the password).
 */
export function keychainEntryExists(account: string): boolean {
  try {
    execSync(
      `security find-generic-password -s "${KEYCHAIN_SERVICE}" -a "${account}" 2>/dev/null`,
      { encoding: 'utf-8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return true;
  } catch {
    return false;
  }
}
