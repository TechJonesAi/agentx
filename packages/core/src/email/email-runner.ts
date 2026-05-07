/**
 * Email ingestion runner — pluggable scheduler with a swappable source.
 *
 * Why a new module rather than silly-johnson's EmailIngestionService.runIngestion:
 *   silly's version makes HTTP calls back to its own web server's
 *   /api/cognitive/documents endpoints (a self-recursive architecture that
 *   only worked in silly's setup). This runner goes straight to the DB
 *   using the same code path as the upload route — emails land in the
 *   `documents` table, get FTS-indexed by triggers, and immediately appear
 *   in /api/memory/control-center.
 *
 * Pluggable source:
 *   - Production: createImapSource(config) — connects to Gmail IMAP via
 *     imapflow + mailparser (deps already in core/package.json).
 *   - Tests / demo: pass a fixed array — no network needed.
 *
 * Safety:
 *   - Never throws to the caller. All errors are caught, logged, and
 *     written to lastError/lastResult. The server keeps running.
 *   - State (processed message-ids, last run time) persists to a JSON file
 *     so dedupe survives restart.
 *   - Default OFF — only runs if explicitly started.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import { resolveDataDir } from '../config.js';
import { ingestUploadedDocument, type UploadIngestDb } from '../ingestion/upload-ingest.js';

const log = createLogger('email:runner');

export interface RawEmail {
  /** Stable per-message identifier. Used for dedupe. */
  messageId: string;
  from: string;
  fromEmail?: string;
  to?: string;
  subject: string;
  date: Date;
  /** Plain-text body. Caller is responsible for stripping HTML if needed. */
  textBody: string;
  /** Attachments list (paths only — already saved to disk by source). */
  attachmentPaths?: string[];
}

/**
 * A source returns the next batch of emails to ingest. Implementations:
 *   - createImapSource() — talks to a real IMAP server
 *   - tests pass a () => Promise.resolve([...]) closure
 */
export type EmailSource = (since?: Date) => Promise<RawEmail[]>;

export interface EmailRunResult {
  fetched: number;
  ingested: number;
  duplicates: number;
  rejected: number;
  errors: number;
  startedAt: number;
  finishedAt: number;
  details: Array<{
    messageId: string;
    subject: string;
    sender: string;
    status: 'ingested' | 'duplicate' | 'rejected' | 'error';
    documentId?: string;
    reason?: string;
  }>;
}

export interface EmailRunnerStatus {
  running: boolean;
  enabled: boolean;
  lastRunAt: number | null;
  lastResult: EmailRunResult | null;
  lastError: string | null;
  intervalMs: number | null;
  processedCount: number;
}

interface RunnerState {
  processedMessageIds: string[];
  lastRunAt: number | null;
}

export interface EmailRunnerOptions {
  db: UploadIngestDb;
  source: EmailSource;
  /** Allowlist of senders. Empty = accept all. */
  allowedSenders?: string[];
  allowedDomains?: string[];
  /** State file path. Defaults to {dataDir}/email-runner-state.json. */
  statePath?: string;
  /** Optional callback to run R5 entity ingestion per ingested doc. */
  onIngested?: (documentId: string, textSnippet: string) => void | Promise<void>;
}

/**
 * Cap to keep state file from growing forever. We hold the last N message
 * IDs for dedupe; older ones can be safely forgotten because IMAP fetches
 * are time-bounded too.
 */
const MAX_PROCESSED_IDS = 5000;

export class EmailRunner {
  private db: UploadIngestDb;
  private source: EmailSource;
  private allowedSenders: string[];
  private allowedDomains: string[];
  private statePath: string;
  private onIngested?: EmailRunnerOptions['onIngested'];
  private state: RunnerState;
  private intervalHandle: NodeJS.Timeout | null = null;
  private intervalMs: number | null = null;
  private lastRunAt: number | null = null;
  private lastResult: EmailRunResult | null = null;
  private lastError: string | null = null;
  private inflight = false;

  constructor(opts: EmailRunnerOptions) {
    this.db = opts.db;
    this.source = opts.source;
    this.allowedSenders = (opts.allowedSenders ?? []).map((s) => s.toLowerCase());
    this.allowedDomains = (opts.allowedDomains ?? []).map((s) => s.toLowerCase().replace(/^@/, ''));
    this.onIngested = opts.onIngested;
    this.statePath = opts.statePath ?? path.join(resolveDataDir(), 'email-runner-state.json');
    this.state = this.loadState();
  }

  // ─── Public API ──────────────────────────────────────────────────────

  /** Run a single ingestion cycle. Never throws. */
  async runOnce(): Promise<EmailRunResult> {
    if (this.inflight) {
      const placeholder: EmailRunResult = {
        fetched: 0, ingested: 0, duplicates: 0, rejected: 0, errors: 0,
        startedAt: Date.now(), finishedAt: Date.now(),
        details: [{ messageId: '-', subject: '-', sender: '-', status: 'error', reason: 'another run in progress' }],
      };
      return placeholder;
    }
    this.inflight = true;
    const startedAt = Date.now();
    const result: EmailRunResult = {
      fetched: 0, ingested: 0, duplicates: 0, rejected: 0, errors: 0,
      startedAt, finishedAt: 0, details: [],
    };

    try {
      const since = this.state.lastRunAt ? new Date(this.state.lastRunAt) : undefined;
      const emails = await this.source(since);
      result.fetched = emails.length;
      log.info({ count: emails.length }, 'Email source returned');

      for (const email of emails) {
        try {
          // Dedupe by message-id
          if (this.state.processedMessageIds.includes(email.messageId)) {
            result.duplicates++;
            result.details.push({
              messageId: email.messageId,
              subject: email.subject,
              sender: email.from,
              status: 'duplicate',
              reason: 'already processed',
            });
            continue;
          }

          // Allowlist check
          if (!this.isAllowedSender(email.fromEmail || email.from)) {
            this.markProcessed(email.messageId);
            result.rejected++;
            result.details.push({
              messageId: email.messageId,
              subject: email.subject,
              sender: email.from,
              status: 'rejected',
              reason: 'sender not in allowlist',
            });
            continue;
          }

          // Ingest into documents table via the same upload helper
          const buffer = Buffer.from(email.textBody, 'utf8');
          const safeSubject = (email.subject || 'no-subject').slice(0, 60).replace(/[^\w\s.-]/g, '_');
          const filename = `email-${email.date.toISOString().slice(0, 10)}-${safeSubject}.eml`;
          const ingest = await ingestUploadedDocument(this.db, {
            buffer,
            filename,
            mimeHint: 'message/rfc822',
            title: email.subject || filename,
            originType: 'email',
          });

          // Patch the row with email-specific metadata that the upload helper
          // doesn't know about (sender, subject, document_date).
          try {
            this.db
              .prepare(
                `UPDATE documents SET sender = ?, sender_email = ?, recipient = ?, subject = ?, document_date = ?, file_type = ?, mime_type = ?, content_type = ? WHERE document_id = ?`,
              )
              .run(
                email.from,
                email.fromEmail ?? null,
                email.to ?? null,
                email.subject,
                email.date.getTime(),
                'eml',
                'message/rfc822',
                'email',
                ingest.documentId,
              );
          } catch (err) {
            log.warn({ err: String(err) }, 'failed to patch email metadata on document row');
          }

          this.markProcessed(email.messageId);

          if (ingest.duplicateOf) {
            // content-hash dedupe — already had identical bytes
            result.duplicates++;
            result.details.push({
              messageId: email.messageId,
              subject: email.subject,
              sender: email.from,
              status: 'duplicate',
              documentId: ingest.duplicateOf,
              reason: 'content_hash matched existing document',
            });
          } else {
            result.ingested++;
            // Optional R5 entity ingestion
            if (this.onIngested) {
              try {
                await this.onIngested(ingest.documentId, email.textBody.slice(0, 100_000));
              } catch (err) {
                log.warn({ err: String(err), documentId: ingest.documentId }, 'onIngested callback failed');
              }
            }
            result.details.push({
              messageId: email.messageId,
              subject: email.subject,
              sender: email.from,
              status: 'ingested',
              documentId: ingest.documentId,
            });
          }
        } catch (err) {
          result.errors++;
          result.details.push({
            messageId: email.messageId,
            subject: email.subject,
            sender: email.from,
            status: 'error',
            reason: err instanceof Error ? err.message : String(err),
          });
          log.error({ err: String(err), messageId: email.messageId }, 'failed to ingest email');
        }
      }

      this.state.lastRunAt = startedAt;
      this.saveState();
      this.lastError = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.lastError = msg;
      log.error({ err: msg }, 'email runner failed at source');
    } finally {
      this.inflight = false;
    }

    result.finishedAt = Date.now();
    this.lastRunAt = result.finishedAt;
    this.lastResult = result;
    log.info(
      { fetched: result.fetched, ingested: result.ingested, dups: result.duplicates, rejected: result.rejected, errors: result.errors },
      'Email run complete',
    );
    return result;
  }

  /** Start the polling loop. No-op if already running. */
  start(intervalMs: number = 60_000): void {
    if (this.intervalHandle) {
      log.info('start() called but already running — ignoring');
      return;
    }
    this.intervalMs = Math.max(5000, intervalMs); // never poll faster than every 5s
    log.info({ intervalMs: this.intervalMs }, 'Email runner started');
    // Fire one immediately, then on interval
    void this.runOnce();
    this.intervalHandle = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    // Don't keep the process alive just for the interval
    if (typeof this.intervalHandle.unref === 'function') this.intervalHandle.unref();
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
      this.intervalMs = null;
      log.info('Email runner stopped');
    }
  }

  isRunning(): boolean { return this.intervalHandle !== null; }

  getStatus(): EmailRunnerStatus {
    return {
      running: this.intervalHandle !== null,
      enabled: process.env['AGENT_EMAIL_INGESTION_ENABLED'] === 'true',
      lastRunAt: this.lastRunAt,
      lastResult: this.lastResult,
      lastError: this.lastError,
      intervalMs: this.intervalMs,
      processedCount: this.state.processedMessageIds.length,
    };
  }

  /** Update allowlist at runtime. */
  setAllowlist(senders: string[], domains: string[]): void {
    this.allowedSenders = senders.map((s) => s.toLowerCase());
    this.allowedDomains = domains.map((s) => s.toLowerCase().replace(/^@/, ''));
  }

  // ─── Private helpers ─────────────────────────────────────────────────

  private markProcessed(messageId: string): void {
    if (!this.state.processedMessageIds.includes(messageId)) {
      this.state.processedMessageIds.push(messageId);
      if (this.state.processedMessageIds.length > MAX_PROCESSED_IDS) {
        this.state.processedMessageIds = this.state.processedMessageIds.slice(-MAX_PROCESSED_IDS);
      }
    }
  }

  private isAllowedSender(sender: string): boolean {
    // Empty allowlist = accept all (matches silly's behaviour)
    if (this.allowedSenders.length === 0 && this.allowedDomains.length === 0) return true;
    const lower = sender.toLowerCase();
    if (this.allowedSenders.includes(lower)) return true;
    for (const d of this.allowedDomains) {
      if (lower.endsWith(`@${d}`) || lower.endsWith(d)) return true;
    }
    return false;
  }

  private loadState(): RunnerState {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf8');
        const parsed = JSON.parse(raw) as RunnerState;
        return {
          processedMessageIds: Array.isArray(parsed.processedMessageIds) ? parsed.processedMessageIds : [],
          lastRunAt: typeof parsed.lastRunAt === 'number' ? parsed.lastRunAt : null,
        };
      }
    } catch (err) {
      log.warn({ err: String(err) }, 'failed to load runner state — starting fresh');
    }
    return { processedMessageIds: [], lastRunAt: null };
  }

  private saveState(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      log.warn({ err: String(err), path: this.statePath }, 'failed to save runner state');
    }
  }
}
