/**
 * IMAP-backed EmailSource for production use.
 *
 * Connects via imapflow, parses with mailparser. Returns RawEmail[] in the
 * shape the EmailRunner expects. Uses Keychain credentials by default
 * (getKeychainPassword) so passwords never live in code or env.
 *
 * NOTE: This module is exercised only at the connection-error path in the
 * test sandbox (no real IMAP server). Real-world verification requires the
 * user's Gmail Keychain entry on their machine. Tests for the runner use
 * a fixture-based source instead.
 */

import { createLogger } from '../logger.js';
import { getKeychainPassword } from './keychain.js';
import type { EmailConfig } from './types.js';
import type { EmailSource, RawEmail } from './email-runner.js';

const log = createLogger('email:imap-source');

export interface ImapSourceOptions {
  account: string;
  host: string;
  port: number;
  secure: boolean;
  /** How far back to fetch on first run (default 7 days). */
  initialLookbackDays?: number;
  /** Max emails per run. */
  maxPerRun?: number;
  /** Optional override — return password directly instead of asking Keychain.
   *  Used by tests so they don't hit the real Keychain. */
  passwordResolver?: (account: string) => Promise<string | null>;
}

export function createImapSource(opts: ImapSourceOptions): EmailSource {
  return async (since?: Date): Promise<RawEmail[]> => {
    const password = opts.passwordResolver
      ? await opts.passwordResolver(opts.account)
      : await getKeychainPassword(opts.account);
    if (!password) {
      throw new Error(`No Keychain password for ${opts.account} — store with: security add-generic-password -s 'AgentX-Email' -a '${opts.account}' -w '<password>'`);
    }

    // Lazy-load IMAP libs so a missing dep doesn't crash the whole app
    let ImapFlow: unknown;
    let simpleParser: unknown;
    try {
      ImapFlow = (await import('imapflow' as string)).ImapFlow;
      simpleParser = (await import('mailparser' as string)).simpleParser;
    } catch (err) {
      throw new Error(`IMAP libraries not available: ${(err as Error).message}`);
    }

    const lookbackDays = opts.initialLookbackDays ?? 7;
    const sinceDate = since ?? new Date(Date.now() - lookbackDays * 86400_000);
    const maxPerRun = opts.maxPerRun ?? 50;

    const Client = ImapFlow as new (cfg: unknown) => {
      connect(): Promise<void>;
      logout(): Promise<void>;
      mailboxOpen(name: string): Promise<unknown>;
      search(opts: unknown): Promise<number[]>;
      fetch(range: unknown, opts: unknown): AsyncIterable<{ source?: Buffer; uid: number }>;
    };

    const client = new Client({
      host: opts.host,
      port: opts.port,
      secure: opts.secure,
      auth: { user: opts.account, pass: password },
      logger: false,
    });

    log.info({ host: opts.host, account: opts.account }, 'IMAP connecting');
    await client.connect();
    try {
      await client.mailboxOpen('INBOX');
      const uids = await client.search({ since: sinceDate });
      const sliced = uids.slice(0, maxPerRun);
      log.info({ found: uids.length, fetching: sliced.length, since: sinceDate.toISOString() }, 'IMAP search done');

      const parser = simpleParser as (src: Buffer) => Promise<{
        messageId?: string;
        from?: { value?: Array<{ name?: string; address?: string }>; text?: string };
        to?: { text?: string };
        subject?: string;
        date?: Date;
        text?: string;
        textAsHtml?: string;
        html?: string;
        attachments?: Array<{ filename?: string }>;
      }>;

      const out: RawEmail[] = [];
      for await (const msg of client.fetch(sliced, { source: true })) {
        if (!msg.source) continue;
        try {
          const p = await parser(msg.source);
          const fromArr = p.from?.value?.[0];
          out.push({
            messageId: p.messageId ?? `imap-${msg.uid}`,
            from: fromArr?.name ?? fromArr?.address ?? p.from?.text ?? 'unknown',
            fromEmail: fromArr?.address,
            to: p.to?.text,
            subject: p.subject ?? '(no subject)',
            date: p.date ?? new Date(),
            textBody: p.text ?? '',
            attachmentPaths: [],
          });
        } catch (err) {
          log.warn({ err: String(err), uid: msg.uid }, 'failed to parse message');
        }
      }
      return out;
    } finally {
      try { await client.logout(); } catch { /* ignore */ }
    }
  };
}
