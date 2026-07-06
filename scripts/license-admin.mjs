#!/usr/bin/env node
/**
 * AgentX license administration — VENDOR ONLY (never ship to customers).
 *
 * One-time setup:
 *   node scripts/license-admin.mjs keygen
 *     → prints the keypair. Store the PRIVATE key somewhere safe (password
 *       manager). Put the PUBLIC key in the customer install's environment:
 *       AGENTX_LICENSE_PUBLIC_KEY=<public> AGENTX_LICENSE_REQUIRED=true
 *
 * Per sale / monthly renewal (e.g. after a Stripe Payment Link fires):
 *   AGENTX_LICENSE_PRIVATE_KEY=<private> node scripts/license-admin.mjs issue \
 *     --customer "acme-ltd" --plan pro-monthly --months 1
 *     → prints the license key. Send it to the customer; they paste it in
 *       Settings → License. Renewal = issue a fresh key with a later expiry.
 *
 * Inspect any key:
 *   node scripts/license-admin.mjs inspect AGX1.…  [--public <key>]
 */

import { generateKeypair, signLicense, verifyLicense } from '../packages/core/dist/licensing/license.js';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : fallback;
}

const cmd = process.argv[2];

if (cmd === 'keygen') {
  const { publicKey, privateKey } = generateKeypair();
  console.log('PUBLIC key  (embed in customer installs):\n' + publicKey);
  console.log('\nPRIVATE key (VENDOR ONLY — keep secret):\n' + privateKey);
} else if (cmd === 'issue') {
  const privateKey = process.env.AGENTX_LICENSE_PRIVATE_KEY;
  if (!privateKey) {
    console.error('Set AGENTX_LICENSE_PRIVATE_KEY in the environment.');
    process.exit(1);
  }
  const customer = arg('customer');
  if (!customer) {
    console.error('--customer is required');
    process.exit(1);
  }
  const plan = arg('plan', 'pro-monthly');
  const months = Number(arg('months', '1'));
  const now = Date.now();
  const expiresAt = new Date(now);
  expiresAt.setMonth(expiresAt.getMonth() + months);
  const key = signLicense(
    { customer, plan, issuedAt: now, expiresAt: expiresAt.getTime() },
    privateKey,
  );
  console.log(`customer:  ${customer}`);
  console.log(`plan:      ${plan}`);
  console.log(`expires:   ${expiresAt.toISOString()}`);
  console.log(`\n${key}`);
} else if (cmd === 'inspect') {
  const key = process.argv[3];
  const publicKey = arg('public', process.env.AGENTX_LICENSE_PUBLIC_KEY);
  if (!key || !publicKey) {
    console.error('Usage: inspect <key> --public <publicKey>');
    process.exit(1);
  }
  console.log(JSON.stringify(verifyLicense(key, publicKey), null, 2));
} else {
  console.log('Usage: license-admin.mjs keygen | issue --customer <id> [--plan p] [--months n] | inspect <key>');
}
