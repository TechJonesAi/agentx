/**
 * AgentX licensing — offline-verifiable monthly subscription keys.
 *
 * Design goals:
 *   - MONETISABLE: keys carry a customer id, plan, and expiry (monthly).
 *   - OFFLINE: ed25519 signature verified with an embedded PUBLIC key —
 *     no phone-home, which preserves AgentX's local-first privacy promise.
 *   - UNFORGEABLE: only the vendor's PRIVATE key (never shipped) can sign.
 *   - GRACEFUL: a 7-day grace period after expiry keeps paying customers
 *     working through a late renewal, with a warning instead of a wall.
 *
 * Key format:  AGX1.<payload-base64url>.<signature-base64url>
 * Payload:     {"customer":"acme","plan":"pro","issuedAt":…,"expiresAt":…}
 *
 * Vendor workflow (scripts/license-admin.mjs):
 *   1. one-time: generate keypair; public key → AGENTX_LICENSE_PUBLIC_KEY
 *   2. per sale/renewal: sign a key with the private key, send to customer
 *   3. customer pastes the key into Settings → License (or license.json)
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface LicensePayload {
  customer: string;
  plan: string;            // e.g. 'pro-monthly'
  issuedAt: number;        // epoch ms
  expiresAt: number;       // epoch ms
}

export interface LicenseStatus {
  state: 'valid' | 'grace' | 'expired' | 'invalid' | 'unlicensed';
  customer?: string;
  plan?: string;
  expiresAt?: number;
  graceEndsAt?: number;
  daysRemaining?: number;
  reason?: string;
}

export const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const KEY_PREFIX = 'AGX1';

const b64url = {
  encode: (buf: Buffer): string => buf.toString('base64url'),
  decode: (s: string): Buffer => Buffer.from(s, 'base64url'),
};

/** Vendor-side: create a signing keypair (private stays with the vendor). */
export function generateKeypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  };
}

/** Vendor-side: sign a license key for a customer. */
export function signLicense(payload: LicensePayload, privateKeyB64: string): string {
  const key = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, 'base64'), type: 'pkcs8', format: 'der',
  });
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  const sig = crypto.sign(null, body, key);
  return `${KEY_PREFIX}.${b64url.encode(body)}.${b64url.encode(sig)}`;
}

/** App-side: verify a key against the embedded public key. Pure — no I/O. */
export function verifyLicense(licenseKey: string, publicKeyB64: string,
                              now: number = Date.now()): LicenseStatus {
  try {
    const parts = licenseKey.trim().split('.');
    if (parts.length !== 3 || parts[0] !== KEY_PREFIX) {
      return { state: 'invalid', reason: 'malformed key' };
    }
    const body = b64url.decode(parts[1]!);
    const sig = b64url.decode(parts[2]!);
    const key = crypto.createPublicKey({
      key: Buffer.from(publicKeyB64, 'base64'), type: 'spki', format: 'der',
    });
    if (!crypto.verify(null, body, key, sig)) {
      return { state: 'invalid', reason: 'signature check failed' };
    }
    const payload = JSON.parse(body.toString('utf-8')) as LicensePayload;
    if (!payload.customer || !payload.expiresAt) {
      return { state: 'invalid', reason: 'incomplete payload' };
    }
    const graceEndsAt = payload.expiresAt + GRACE_PERIOD_MS;
    if (now <= payload.expiresAt) {
      return {
        state: 'valid', customer: payload.customer, plan: payload.plan,
        expiresAt: payload.expiresAt,
        daysRemaining: Math.ceil((payload.expiresAt - now) / 86_400_000),
      };
    }
    if (now <= graceEndsAt) {
      return {
        state: 'grace', customer: payload.customer, plan: payload.plan,
        expiresAt: payload.expiresAt, graceEndsAt,
        daysRemaining: Math.ceil((graceEndsAt - now) / 86_400_000),
        reason: 'subscription expired — renew to keep access',
      };
    }
    return {
      state: 'expired', customer: payload.customer, plan: payload.plan,
      expiresAt: payload.expiresAt, reason: 'subscription expired',
    };
  } catch (e) {
    return { state: 'invalid', reason: e instanceof Error ? e.message : String(e) };
  }
}

// ─── Stored license management ───────────────────────────────────────────────

export interface LicenseManagerOptions {
  dataDir: string;
  /** base64 SPKI ed25519 public key; falls back to AGENTX_LICENSE_PUBLIC_KEY. */
  publicKey?: string;
  /** Gate requests when true; falls back to AGENTX_LICENSE_REQUIRED env. */
  required?: boolean;
}

export class LicenseManager {
  private readonly filePath: string;
  private readonly publicKey: string | undefined;
  readonly required: boolean;

  constructor(opts: LicenseManagerOptions) {
    this.filePath = path.join(opts.dataDir, 'license.json');
    this.publicKey = opts.publicKey ?? process.env['AGENTX_LICENSE_PUBLIC_KEY'];
    this.required = opts.required ??
      (process.env['AGENTX_LICENSE_REQUIRED'] ?? '').toLowerCase() === 'true';
  }

  /** Licensing only activates when BOTH a public key is configured AND the
   *  required flag is on — a dev instance stays fully open by default. */
  get enforced(): boolean {
    return this.required && !!this.publicKey;
  }

  status(now: number = Date.now()): LicenseStatus {
    if (!this.enforced) return { state: 'valid', reason: 'licensing not enforced' };
    const key = this.readStoredKey();
    if (!key) return { state: 'unlicensed', reason: 'no license key installed' };
    return verifyLicense(key, this.publicKey!, now);
  }

  /** True when API access should be allowed. */
  allowed(now: number = Date.now()): boolean {
    if (!this.enforced) return true;
    const s = this.status(now);
    return s.state === 'valid' || s.state === 'grace';
  }

  /** Validate + persist a new key. Returns the resulting status. */
  activate(licenseKey: string, now: number = Date.now()): LicenseStatus {
    if (!this.publicKey) return { state: 'invalid', reason: 'no public key configured' };
    const status = verifyLicense(licenseKey, this.publicKey, now);
    if (status.state === 'valid' || status.state === 'grace') {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify({ key: licenseKey.trim() }, null, 2));
    }
    return status;
  }

  deactivate(): void {
    try { fs.unlinkSync(this.filePath); } catch { /* not installed */ }
  }

  private readStoredKey(): string | null {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as { key?: string };
      return raw.key ?? null;
    } catch {
      return null;
    }
  }
}
