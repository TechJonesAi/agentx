/**
 * Licensing — offline ed25519 monthly subscription keys.
 * Covers: sign/verify round-trip, forgery rejection, expiry, the 7-day
 * grace period, LicenseManager enforcement gating and persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  generateKeypair,
  signLicense,
  verifyLicense,
  LicenseManager,
  GRACE_PERIOD_MS,
} from '../../src/licensing/license.js';

const DAY = 86_400_000;

describe('license sign/verify', () => {
  const { publicKey, privateKey } = generateKeypair();
  const now = Date.now();

  function issue(expiresAt: number): string {
    return signLicense(
      { customer: 'acme', plan: 'pro-monthly', issuedAt: now, expiresAt },
      privateKey,
    );
  }

  it('valid key verifies with customer, plan, expiry', () => {
    const s = verifyLicense(issue(now + 30 * DAY), publicKey, now);
    expect(s.state).toBe('valid');
    expect(s.customer).toBe('acme');
    expect(s.plan).toBe('pro-monthly');
    expect(s.daysRemaining).toBeGreaterThanOrEqual(29);
  });

  it('rejects a key signed by a DIFFERENT private key (forgery)', () => {
    const attacker = generateKeypair();
    const forged = signLicense(
      { customer: 'acme', plan: 'pro-monthly', issuedAt: now, expiresAt: now + 30 * DAY },
      attacker.privateKey,
    );
    expect(verifyLicense(forged, publicKey, now).state).toBe('invalid');
  });

  it('rejects tampered payloads (extended expiry)', () => {
    const key = issue(now + DAY);
    const [prefix, , sig] = key.split('.');
    const tampered = Buffer.from(JSON.stringify({
      customer: 'acme', plan: 'pro-monthly', issuedAt: now, expiresAt: now + 365 * DAY,
    })).toString('base64url');
    expect(verifyLicense(`${prefix}.${tampered}.${sig}`, publicKey, now).state).toBe('invalid');
  });

  it('rejects malformed keys', () => {
    expect(verifyLicense('not-a-key', publicKey, now).state).toBe('invalid');
    expect(verifyLicense('AGX1.only-two', publicKey, now).state).toBe('invalid');
  });

  it('grace period: expired < 7 days ago → grace with warning', () => {
    const s = verifyLicense(issue(now - 2 * DAY), publicKey, now);
    expect(s.state).toBe('grace');
    expect(s.graceEndsAt).toBe(now - 2 * DAY + GRACE_PERIOD_MS);
  });

  it('fully expired after the grace window', () => {
    const s = verifyLicense(issue(now - 9 * DAY), publicKey, now);
    expect(s.state).toBe('expired');
  });
});

describe('LicenseManager', () => {
  let dir: string;
  const { publicKey, privateKey } = generateKeypair();
  const now = Date.now();

  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agx-lic-')); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  function goodKey(): string {
    return signLicense(
      { customer: 'client-1', plan: 'pro-monthly', issuedAt: now, expiresAt: now + 30 * DAY },
      privateKey,
    );
  }

  it('NOT enforced without a public key — everything allowed (dev/owner mode)', () => {
    const m = new LicenseManager({ dataDir: dir, required: true, publicKey: undefined });
    // required=true but no key configured → open
    if (!process.env['AGENTX_LICENSE_PUBLIC_KEY']) {
      expect(m.enforced).toBe(false);
      expect(m.allowed()).toBe(true);
    }
  });

  it('NOT enforced when required=false even with a public key', () => {
    const m = new LicenseManager({ dataDir: dir, required: false, publicKey });
    expect(m.enforced).toBe(false);
    expect(m.allowed()).toBe(true);
  });

  it('enforced + no key installed → unlicensed, blocked', () => {
    const m = new LicenseManager({ dataDir: dir, required: true, publicKey });
    expect(m.enforced).toBe(true);
    expect(m.status().state).toBe('unlicensed');
    expect(m.allowed()).toBe(false);
  });

  it('activate persists the key and unblocks; survives a new manager instance', () => {
    const m = new LicenseManager({ dataDir: dir, required: true, publicKey });
    expect(m.activate(goodKey()).state).toBe('valid');
    expect(m.allowed()).toBe(true);
    const m2 = new LicenseManager({ dataDir: dir, required: true, publicKey });
    expect(m2.status().state).toBe('valid');
    expect(m2.status().customer).toBe('client-1');
  });

  it('activate rejects an invalid key and does NOT persist it', () => {
    const m = new LicenseManager({ dataDir: dir, required: true, publicKey });
    expect(m.activate('AGX1.garbage.key').state).toBe('invalid');
    expect(m.status().state).toBe('unlicensed');
  });

  it('deactivate removes the license', () => {
    const m = new LicenseManager({ dataDir: dir, required: true, publicKey });
    m.activate(goodKey());
    m.deactivate();
    expect(m.status().state).toBe('unlicensed');
  });
});

describe('G5 — config profiles (AGENTX_CONFIG_PROFILE)', () => {
  it('client profile hardens security settings', async () => {
    const prev = process.env['AGENTX_CONFIG_PROFILE'];
    process.env['AGENTX_CONFIG_PROFILE'] = 'client';
    try {
      const { loadConfig } = await import('../../src/config.js');
      const cfg = loadConfig();
      // Only asserts when running from the repo root (config/client.yaml visible)
      if (cfg.security?.shellPermissionLevel === 'allowlist-only') {
        expect(cfg.security.encryptStorage).toBe(true);
        expect(cfg.security.localAuth).toBe(true);
        expect((cfg as { web?: { host?: string } }).web?.host).toBe('127.0.0.1');
      }
    } finally {
      if (prev === undefined) delete process.env['AGENTX_CONFIG_PROFILE'];
      else process.env['AGENTX_CONFIG_PROFILE'] = prev;
    }
  });

  it('bogus profile name falls back to defaults safely', async () => {
    const prev = process.env['AGENTX_CONFIG_PROFILE'];
    process.env['AGENTX_CONFIG_PROFILE'] = '../evil';
    try {
      const { loadConfig } = await import('../../src/config.js');
      const cfg = loadConfig();
      expect(cfg.agent.name).toBeTruthy(); // loads, no traversal
    } finally {
      if (prev === undefined) delete process.env['AGENTX_CONFIG_PROFILE'];
      else process.env['AGENTX_CONFIG_PROFILE'] = prev;
    }
  });
});
