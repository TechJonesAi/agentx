/**
 * Email Ingestion Service — Secure IMAP email fetching and ingestion.
 *
 * SECURITY CONTRACT:
 * - Password retrieved from macOS Keychain at connection time only
 * - Password variable cleared immediately after IMAP auth
 * - No credentials in logs, database, or error messages
 * - Keychain failure = hard stop, no plaintext fallback
 */

import { randomUUID, createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import { resolveDataDir } from '../config.js';
import { getKeychainPassword } from './keychain.js';
import type {
  EmailConfig,
  ParsedEmail,
  EmailAttachment,
  EmailRecord,
  EmailIngestionState,
  EmailIngestionResult,
  DEFAULT_EMAIL_CONFIG,
} from './types.js';

const log = createLogger('email:ingestion');

export class EmailIngestionService {
  private config: EmailConfig;
  private state: EmailIngestionState;
  private statePath: string;
  private configPath: string;

  constructor(config?: Partial<EmailConfig>) {
    const defaults: EmailConfig = {
      account: 'dezkindwords@gmail.com',
      host: 'imap.gmail.com',
      port: 993,
      secure: true,
      allowedSenders: [],
      allowedDomains: [],
      attachmentDir: '',
      maxPerRun: 50,
    };
    this.config = { ...defaults, ...config };

    const dataDir = resolveDataDir();
    this.statePath = path.join(dataDir, 'email-ingestion-state.json');
    this.configPath = path.join(dataDir, 'email-ingestion-config.json');

    if (!this.config.attachmentDir) {
      this.config.attachmentDir = path.join(dataDir, 'email-attachments');
    }
    if (!fs.existsSync(this.config.attachmentDir)) {
      fs.mkdirSync(this.config.attachmentDir, { recursive: true });
    }

    this.state = this.loadState();
    this.loadSavedConfig();
  }

  // ─── Public API ──────────────────────────────────────────────────────────

  /**
   * Run a full email ingestion cycle.
   */
  async runIngestion(): Promise<EmailIngestionResult> {
    log.info('Starting email ingestion run');

    const result: EmailIngestionResult = {
      fetched: 0, ingested: 0, rejected: 0, duplicates: 0, errors: 0, details: [],
    };

    let client: any = null;
    try {
      client = await this.connectIMAP();
      const emails = await this.fetchEmails(client);
      result.fetched = emails.length;
      log.info({ count: emails.length }, 'Emails fetched');

      for (const email of emails) {
        try {
          const detail = await this.processEmail(email);
          result.details.push(detail);

          switch (detail.status) {
            case 'ingested': result.ingested++; break;
            case 'rejected': result.rejected++; break;
            case 'duplicate': result.duplicates++; break;
            case 'error': result.errors++; break;
          }
        } catch (err) {
          result.errors++;
          result.details.push({
            messageId: email.messageId || 'unknown',
            subject: email.subject || 'unknown',
            sender: email.from || 'unknown',
            status: 'error',
            reason: (err as Error).message,
          });
        }
      }

      this.state.lastCheckTimestamp = Date.now();
      this.state.totalIngested += result.ingested;
      this.state.totalRejected += result.rejected;
      this.state.lastError = undefined;
      this.saveState();

    } catch (err) {
      const safeError = this.sanitizeError((err as Error).message);
      log.error({ error: safeError }, 'Email ingestion failed');
      this.state.lastError = safeError;
      this.saveState();
      throw new Error(`Email ingestion failed: ${safeError}`);
    } finally {
      if (client) {
        try { await client.logout(); } catch { /* best effort */ }
      }
    }

    // P8-1.16: Retry any previously failed cognitive memory ingestions
    await this.reconcileFailedIngestions();

    log.info({
      ingested: result.ingested,
      rejected: result.rejected,
      duplicates: result.duplicates,
      errors: result.errors,
    }, 'Email ingestion run complete');

    return result;
  }

  /**
   * P8-1.16: Retry cognitive memory ingestion for emails that were saved to disk
   * but failed to be pushed to cognitive memory on previous runs.
   */
  async reconcileFailedIngestions(): Promise<{ retried: number; succeeded: number; failed: number }> {
    const failedIds = this.state.cognitiveMemoryFailedIds ?? [];
    if (failedIds.length === 0) return { retried: 0, succeeded: 0, failed: 0 };

    log.info({ count: failedIds.length }, 'Retrying failed cognitive memory ingestions');

    const recordDir = path.join(resolveDataDir(), 'email-records');
    let succeeded = 0;
    let failed = 0;
    const stillFailed: string[] = [];

    for (const messageId of failedIds) {
      // Find the record file on disk
      const files = fs.existsSync(recordDir)
        ? fs.readdirSync(recordDir).filter(f => f.endsWith('.json'))
        : [];

      let record: EmailRecord | null = null;
      for (const file of files) {
        try {
          const data = JSON.parse(fs.readFileSync(path.join(recordDir, file), 'utf-8'));
          if (data.messageId === messageId) {
            record = data;
            break;
          }
        } catch { /* skip malformed files */ }
      }

      if (!record) {
        log.warn({ messageId }, 'Cannot retry — email record not found on disk');
        failed++;
        continue;
      }

      try {
        await this.ingestIntoCognitiveMemory(record);
        succeeded++;
        log.info({ messageId, subject: record.subject }, 'Retry succeeded — email now in cognitive memory');
      } catch (err) {
        failed++;
        stillFailed.push(messageId);
        log.warn({ messageId, error: (err as Error).message }, 'Retry still failing');
      }
    }

    this.state.cognitiveMemoryFailedIds = stillFailed;
    this.saveState();

    log.info({ retried: failedIds.length, succeeded, failed }, 'Cognitive memory reconciliation complete');
    return { retried: failedIds.length, succeeded, failed };
  }

  /**
   * Test IMAP connectivity without fetching emails.
   */
  async testConnection(): Promise<{ connected: boolean; error?: string }> {
    let client: any = null;
    try {
      client = await this.connectIMAP();
      await client.logout();
      return { connected: true };
    } catch (err) {
      return { connected: false, error: this.sanitizeError((err as Error).message) };
    }
  }

  /**
   * Get current state (safe for UI display).
   */
  getState(): EmailIngestionState & { config: Omit<EmailConfig, 'account'> & { account: string } } {
    return {
      ...this.state,
      config: {
        ...this.config,
        // Account is safe to show, password is NEVER stored here
      },
    };
  }

  /**
   * Update allowlist configuration.
   */
  updateAllowlist(senders: string[], domains: string[]): void {
    this.config.allowedSenders = senders.map(s => s.toLowerCase().trim());
    this.config.allowedDomains = domains.map(d => d.toLowerCase().trim()).map(d => d.startsWith('@') ? d : `@${d}`);
    this.saveConfig();
    log.info({ senders: this.config.allowedSenders.length, domains: this.config.allowedDomains.length }, 'Allowlist updated');
  }

  /**
   * Get the allowlist.
   */
  getAllowlist(): { senders: string[]; domains: string[] } {
    return {
      senders: this.config.allowedSenders,
      domains: this.config.allowedDomains,
    };
  }

  /**
   * Check if a missed run needs to be recovered.
   */
  needsMissedRunRecovery(scheduledHour: number = 19): boolean {
    const now = new Date();
    const lastCheck = this.state.lastCheckTimestamp;
    if (!lastCheck) return true; // Never run before

    const lastCheckDate = new Date(lastCheck);
    const todayScheduled = new Date(now);
    todayScheduled.setHours(scheduledHour, 0, 0, 0);

    // If last check was before today's scheduled time and we're past it
    if (lastCheckDate < todayScheduled && now > todayScheduled) {
      return true;
    }

    // If last check was more than 25 hours ago (missed a full cycle)
    if (now.getTime() - lastCheck > 25 * 60 * 60 * 1000) {
      return true;
    }

    return false;
  }

  // ─── IMAP Connection ─────────────────────────────────────────────────────

  /**
   * Connect to IMAP using Keychain credentials.
   * SECURITY: Password held only during auth, then cleared.
   */
  private async connectIMAP(): Promise<any> {
    // Retrieve password from Keychain — NEVER from any other source
    let password = getKeychainPassword(this.config.account);
    if (!password) {
      throw new Error(
        'IMAP credentials not found in macOS Keychain. ' +
        'Store them with: security add-generic-password -s "agentx-email" -a "<email>" -w'
      );
    }

    try {
      const { ImapFlow } = await import('imapflow');

      const client = new ImapFlow({
        host: this.config.host,
        port: this.config.port,
        secure: this.config.secure,
        auth: {
          user: this.config.account,
          pass: password,
        },
        logger: false, // SECURITY: Disable IMAP protocol logging (would contain auth)
      });

      // SECURITY: Clear password from memory immediately after creating client
      password = null as any;

      await client.connect();
      log.info('IMAP connected');
      return client;

    } catch (err) {
      // SECURITY: Clear password on error path too
      password = null as any;

      // Provide safe, actionable error messages
      const msg = (err as Error).message || '';
      if (msg.includes('AUTHENTICATIONFAILED') || msg.includes('Invalid credentials')) {
        throw new Error(
          'IMAP authentication failed — the app password in Keychain may be incorrect or expired. ' +
          'Generate a new Gmail App Password and update Keychain with: ' +
          'security delete-generic-password -s "agentx-email" -a "<email>" && ' +
          'security add-generic-password -s "agentx-email" -a "<email>" -w'
        );
      }
      throw err;
    }
  }

  // ─── Email Fetching ───────────────────────────────────────────────────────

  private async fetchEmails(client: any): Promise<ParsedEmail[]> {
    const emails: ParsedEmail[] = [];

    await client.mailboxOpen('INBOX');

    // Build search criteria: unseen OR since last check
    const since = this.state.lastCheckTimestamp
      ? new Date(this.state.lastCheckTimestamp)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000); // Default: last 7 days

    const searchCriteria = { since };

    let count = 0;
    for await (const message of client.fetch(searchCriteria, {
      envelope: true,
      source: true,
    })) {
      if (count >= this.config.maxPerRun) break;

      try {
        const parsed = await this.parseMessage(message);
        if (parsed) {
          emails.push(parsed);
          count++;
        }
      } catch (err) {
        log.warn({ error: (err as Error).message }, 'Failed to parse email');
      }
    }

    return emails;
  }

  private async parseMessage(message: any): Promise<ParsedEmail | null> {
    const { simpleParser } = await import('mailparser');

    const parsed = await simpleParser(message.source);

    const fromObj = parsed.from;
    const from = fromObj?.value?.[0]?.address || '';
    const toObj = Array.isArray(parsed.to) ? parsed.to[0] : parsed.to;
    const to = toObj?.value?.[0]?.address || '';
    const messageId = parsed.messageId || message.uid?.toString() || randomUUID();

    const attachments: EmailAttachment[] = (parsed.attachments || []).map((att: any) => ({
      filename: att.filename || 'unnamed',
      contentType: att.contentType || 'application/octet-stream',
      size: att.size || 0,
      content: att.content,
    }));

    return {
      messageId,
      from,
      to: to,
      subject: parsed.subject || '(no subject)',
      date: parsed.date || new Date(),
      textBody: parsed.text || '',
      htmlBody: parsed.html || undefined,
      attachments,
      headers: {
        from,
        to: to,
        subject: parsed.subject || '',
        date: parsed.date?.toISOString() || '',
        messageId,
      },
    };
  }

  // ─── Email Processing ─────────────────────────────────────────────────────

  private async processEmail(email: ParsedEmail): Promise<{
    messageId: string;
    subject: string;
    sender: string;
    status: 'ingested' | 'rejected' | 'duplicate' | 'error';
    reason?: string;
  }> {
    // Check for duplicates
    if (this.state.processedMessageIds.includes(email.messageId)) {
      return {
        messageId: email.messageId,
        subject: email.subject,
        sender: email.from,
        status: 'duplicate',
        reason: 'Already processed',
      };
    }

    // Check allowlist
    if (!this.isAllowedSender(email.from)) {
      this.state.processedMessageIds.push(email.messageId);
      return {
        messageId: email.messageId,
        subject: email.subject,
        sender: email.from,
        status: 'rejected',
        reason: `Sender not in allowlist: ${email.from}`,
      };
    }

    // Save attachments
    const savedAttachments: string[] = [];
    for (const att of email.attachments) {
      if (att.content) {
        const safeName = att.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const savePath = path.join(this.config.attachmentDir, `${Date.now()}-${safeName}`);
        fs.writeFileSync(savePath, att.content);
        att.savedPath = savePath;
        savedAttachments.push(savePath);
      }
    }

    // Create email record for memory ingestion
    // Use a deterministic ID derived from messageId for idempotent writes
    const deterministicId = this.messageIdToRecordId(email.messageId);
    const record: EmailRecord = {
      id: deterministicId,
      messageId: email.messageId,
      sender: email.from,
      subject: email.subject,
      body: email.textBody,
      timestamp: email.date.getTime(),
      attachmentPaths: savedAttachments,
      status: 'ingested',
      ingestedAt: Date.now(),
    };

    // Store in state file (lightweight persistence)
    if (!this.state.processedMessageIds.includes(email.messageId)) {
      this.state.processedMessageIds.push(email.messageId);
    }

    // Keep only last 1000 message IDs to prevent unbounded growth
    if (this.state.processedMessageIds.length > 1000) {
      this.state.processedMessageIds = this.state.processedMessageIds.slice(-1000);
    }

    // Write record to disk — deterministic filename prevents duplicates
    const recordPath = path.join(resolveDataDir(), 'email-records');
    if (!fs.existsSync(recordPath)) {
      fs.mkdirSync(recordPath, { recursive: true });
    }
    const recordFile = path.join(recordPath, `${record.id}.json`);
    if (fs.existsSync(recordFile)) {
      log.info({ messageId: email.messageId }, 'Email record already on disk — skipping write');
    } else {
      fs.writeFileSync(recordFile, JSON.stringify(record, null, 2));
    }

    log.info({ sender: email.from, subject: email.subject, attachments: savedAttachments.length }, 'Email ingested');

    // ─── Lifelong Memory: Push to cognitive memory via API ───
    // All trusted emails are stored permanently. No relevance filtering.
    // P8-1.16: Await ingestion and track failures for retry instead of fire-and-forget.
    try {
      await this.ingestIntoCognitiveMemory(record);
      // Remove from failed list if previously failed
      if (this.state.cognitiveMemoryFailedIds?.includes(email.messageId)) {
        this.state.cognitiveMemoryFailedIds = this.state.cognitiveMemoryFailedIds.filter(id => id !== email.messageId);
        this.saveState();
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      log.error({ error: errMsg, sender: email.from, subject: email.subject, messageId: email.messageId },
        'Cognitive memory ingestion FAILED — email saved to disk but NOT searchable. Will retry on next run.');
      // Track for retry
      if (!this.state.cognitiveMemoryFailedIds) this.state.cognitiveMemoryFailedIds = [];
      if (!this.state.cognitiveMemoryFailedIds.includes(email.messageId)) {
        this.state.cognitiveMemoryFailedIds.push(email.messageId);
        this.saveState();
      }
    }

    return {
      messageId: email.messageId,
      subject: email.subject,
      sender: email.from,
      status: 'ingested',
    };
  }

  /**
   * Push an email record into cognitive memory for lifelong retrieval.
   * - Image/PDF attachments → /api/cognitive/ingest-book (OCR pipeline, Emails collection)
   * - Text body → /api/cognitive/ingest + PATCH collection
   * Fires-and-forgets — if the web server is down, disk records still serve as durable store.
   */
  private async ingestIntoCognitiveMemory(record: EmailRecord): Promise<void> {
    const webPort = Number(process.env['AGENTX_WEB_PORT'] ?? 3001);
    const host = process.env['AGENTX_MEMORY_API_HOST'] ?? '127.0.0.1';
    const baseUrl = `http://${host}:${webPort}`;

    // Quick health check against web server
    try {
      const healthRes = await fetch(`${baseUrl}/api/health`, { signal: AbortSignal.timeout(2000) });
      if (!healthRes.ok) {
        throw new Error(`Web server health check failed with status ${healthRes.status}`);
      }
    } catch (err) {
      throw new Error(`Web server not reachable at ${baseUrl} — cognitive memory ingestion deferred. ${(err as Error).message}`);
    }

    // Idempotency: if an email body doc already exists for this record, skip re-ingest.
    // Prevents double-ingestion when reconcileFailedIngestions retries after a
    // transient attachment network error.
    const recordPrefix = record.id.slice(0, 8);
    try {
      const existingRes = await fetch(`${baseUrl}/api/cognitive/documents?search=email-${recordPrefix}`, {
        signal: AbortSignal.timeout(5000),
      });
      if (existingRes.ok) {
        const existing = await existingRes.json() as any;
        const docs = Array.isArray(existing?.documents) ? existing.documents : [];
        const alreadyIngested = docs.some((d: any) =>
          typeof d?.file_name === 'string' && d.file_name.startsWith(`email-${recordPrefix}`)
        );
        if (alreadyIngested) {
          log.info({ recordId: record.id }, 'Email body already in cognitive memory — skipping re-ingest');
          return;
        }
      }
    } catch {
      // Non-fatal — proceed with ingestion
    }

    // ── Image attachments: PRESERVE AS IMAGES (no OCR) ───────────────
    // Images stay on disk at record.attachmentPaths. We do NOT run OCR —
    // it degrades image content into potentially inaccurate text.
    // Each image is registered in the "Email Images" collection so it
    // appears as a viewable/deletable item in the Memory dashboard.
    const imageAttachments = record.attachmentPaths.filter(p =>
      /\.(png|jpg|jpeg|gif|tiff|webp|bmp|heic|heif)$/i.test(p)
    );
    const docAttachments = record.attachmentPaths.filter(p =>
      /\.(pdf|docx|doc|txt|csv|xlsx|md|epub)$/i.test(p)
    );

    // Register each image as a document in "Email Images" collection
    for (const imgPath of imageAttachments) {
      await this.registerImageAsDocument(baseUrl, record, imgPath);
    }

    // Ingest document attachments individually (text-based — extraction is safe)
    for (const attPath of docAttachments) {
      await this.ingestSingleAttachment(baseUrl, record, attPath);
    }

    // ── Ingest email text body (if substantive) ──────────────────────
    // Clean noise (image markers, auto-descriptions, HTML artifacts) but preserve original wording.
    // Append image attachment references so they're discoverable without OCR.
    const { cleanEmailBody } = await import('./clean-email-body.js');
    let cleanedBody = cleanEmailBody(record.body);

    if (imageAttachments.length > 0) {
      const imageList = imageAttachments
        .map(p => `  - ${p.split('/').pop()}`)
        .join('\n');
      cleanedBody = (cleanedBody.trim().length > 0 ? cleanedBody + '\n\n' : '')
        + `[Image attachments — stored as original image files, not OCR'd:]\n${imageList}`;
      log.info({ recordId: record.id, imageCount: imageAttachments.length },
        'Preserving image attachments as files (no OCR)');
    }

    if (cleanedBody.length > 20) {
      await this.ingestEmailBody(baseUrl, record, cleanedBody);
    }
  }

  /**
   * Register an email image attachment as a document in the "Email Images" collection.
   * The image stays on disk at imgPath — we store a reference to it, no OCR.
   * User can view, open, or delete the image via the Memory dashboard.
   */
  private async registerImageAsDocument(baseUrl: string, record: EmailRecord, imgPath: string): Promise<void> {
    if (!fs.existsSync(imgPath)) return;

    const filename = path.basename(imgPath);
    const ext = path.extname(imgPath).toLowerCase().slice(1);
    const mimeType = ext === 'png' ? 'image/png'
      : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
      : ext === 'gif' ? 'image/gif'
      : ext === 'tiff' ? 'image/tiff'
      : ext === 'webp' ? 'image/webp'
      : ext === 'bmp' ? 'image/bmp'
      : ext === 'heic' ? 'image/heic'
      : ext === 'heif' ? 'image/heif'
      : 'application/octet-stream';

    try {
      // Use a dedicated registration endpoint so we skip text extraction/OCR
      // and just record the metadata pointing at the existing file on disk.
      const res = await fetch(`${baseUrl}/api/cognitive/register-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          file_path: imgPath,
          file_name: filename,
          mime_type: mimeType,
          collection: 'Email Images',
          origin_type: 'email',
          source_type: 'image',
          email_record_id: record.id,
          email_subject: record.subject,
          email_sender: record.sender,
          email_timestamp: record.timestamp,
        }),
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) {
        const result = await res.json() as any;
        log.info({ recordId: record.id, documentId: result.document_id, filename },
          'Image attachment registered in Email Images collection');
      } else if (res.status === 409) {
        // Already registered — non-fatal
        log.debug({ filename }, 'Image already registered in Email Images');
      } else {
        const errText = await res.text();
        log.warn({ status: res.status, error: errText, filename }, 'Image registration failed');
      }
    } catch (err) {
      log.warn({ error: (err as Error).message, filename }, 'Image registration API not reachable');
      // Non-fatal — email text body can still be ingested
    }
  }

  /**
   * Ingest image attachments as a multi-page book via /api/cognitive/ingest-book.
   * This runs OCR on each image and groups them under one document in the Emails collection.
   */
  private async ingestAttachmentsAsBook(baseUrl: string, record: EmailRecord, imagePaths: string[]): Promise<void> {
    const bookName = `Email: ${record.subject} (${record.sender})`;

    // Build multipart form with all images
    const boundary = `----EmailIngest${Date.now()}`;
    const parts: Buffer[] = [];

    // Add book_name field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="book_name"\r\n\r\n${bookName}\r\n`
    ));

    // Add collection field
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="collection"\r\n\r\nEmails\r\n`
    ));

    // Add each image as a file part
    for (const imgPath of imagePaths) {
      if (!fs.existsSync(imgPath)) continue;
      const filename = path.basename(imgPath);
      const ext = path.extname(imgPath).toLowerCase().slice(1);
      const mimeType = ext === 'png' ? 'image/png'
        : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg'
        : ext === 'gif' ? 'image/gif'
        : ext === 'tiff' ? 'image/tiff'
        : ext === 'webp' ? 'image/webp'
        : 'application/octet-stream';

      const fileData = fs.readFileSync(imgPath);
      parts.push(Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
      ));
      parts.push(fileData);
      parts.push(Buffer.from('\r\n'));
    }

    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    try {
      const res = await fetch(`${baseUrl}/api/cognitive/ingest-book`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(120000), // OCR can be slow
      });
      if (res.ok) {
        const result = await res.json() as any;
        log.info({
          recordId: record.id,
          documentId: result.document_id,
          pages: result.total_pages,
          words: result.total_words,
        }, 'Email attachments ingested as book in Emails collection');
      } else {
        const errText = await res.text();
        log.warn({ status: res.status, error: errText }, 'Email book ingest failed');
      }
    } catch (err) {
      log.debug({ error: (err as Error).message }, 'Email book ingest API not reachable');
    }
  }

  /**
   * Ingest a single document attachment (PDF, DOCX, etc.) via /api/cognitive/ingest,
   * then set its collection to Emails.
   */
  private async ingestSingleAttachment(baseUrl: string, record: EmailRecord, attPath: string): Promise<void> {
    if (!fs.existsSync(attPath)) return;

    const filename = path.basename(attPath);
    const ext = path.extname(attPath).toLowerCase().slice(1);
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      doc: 'application/msword', txt: 'text/plain', csv: 'text/csv',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      md: 'text/markdown', epub: 'application/epub+zip',
    };
    const mimeType = mimeMap[ext] || 'application/octet-stream';
    const fileData = fs.readFileSync(attPath);

    const boundary = `----EmailAttach${Date.now()}`;
    const parts: Buffer[] = [];
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimeType}\r\n\r\n`
    ));
    parts.push(fileData);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    try {
      const res = await fetch(`${baseUrl}/api/cognitive/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(60000),
      });
      if (res.ok) {
        const result = await res.json() as any;
        // Set collection to Emails via PATCH
        if (result.document_id) {
          await this.setDocumentCollection(baseUrl, result.document_id);
          log.info({ recordId: record.id, documentId: result.document_id, filename }, 'Email attachment ingested into Emails collection');
        }
      } else {
        const errText = await res.text();
        log.warn({ status: res.status, error: errText, filename }, 'Email attachment ingest returned error');
      }
    } catch (err) {
      log.warn({ error: (err as Error).message, filename }, 'Email attachment ingest failed');
      throw err;
    }
  }

  /**
   * Ingest the email text body via /api/cognitive/ingest, then set collection.
   */
  private async ingestEmailBody(baseUrl: string, record: EmailRecord, bodyText: string): Promise<void> {
    const content = [
      `Subject: ${record.subject}`,
      `From: ${record.sender}`,
      `Date: ${new Date(record.timestamp).toISOString()}`,
      '',
      bodyText,
    ].join('\n');

    const filename = `email-${record.id.slice(0, 8)}-${record.subject.replace(/[^a-zA-Z0-9]/g, '_').slice(0, 40)}.txt`;
    const boundary = `----EmailBody${Date.now()}`;
    const parts: Buffer[] = [];
    parts.push(Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n`
    ));
    parts.push(Buffer.from(content));
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
    const body = Buffer.concat(parts);

    try {
      const res = await fetch(`${baseUrl}/api/cognitive/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(30000),
      });
      if (res.ok) {
        const result = await res.json() as any;
        if (result.document_id) {
          await this.setDocumentCollection(baseUrl, result.document_id);
          log.info({ recordId: record.id, documentId: result.document_id }, 'Email body ingested into Emails collection');
        }
      } else {
        const errText = await res.text();
        log.warn({ status: res.status, error: errText }, 'Email body ingest returned error');
      }
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'Email body ingest failed');
      throw err;
    }
  }

  /**
   * Set a document's collection to "Emails" via PATCH.
   */
  private async setDocumentCollection(baseUrl: string, documentId: string): Promise<void> {
    try {
      await fetch(`${baseUrl}/api/cognitive/books/${documentId}/collection`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ collection: 'Emails' }),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Non-fatal — document is still ingested, just uncategorised
    }
  }

  // ─── Allowlist ─────────────────────────────────────────────────────────────

  private isAllowedSender(sender: string): boolean {
    const senderLower = sender.toLowerCase();

    // STRICT POLICY: If no allowlist configured, reject all.
    // Production systems must have an explicit allowlist.
    if (this.config.allowedSenders.length === 0 && this.config.allowedDomains.length === 0) {
      return false;
    }

    // Check exact sender match
    if (this.config.allowedSenders.includes(senderLower)) {
      return true;
    }

    // Check domain match
    for (const domain of this.config.allowedDomains) {
      if (senderLower.endsWith(domain)) {
        return true;
      }
    }

    return false;
  }

  // ─── State Persistence ─────────────────────────────────────────────────────

  private loadState(): EmailIngestionState {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf-8');
        return JSON.parse(raw);
      }
    } catch {
      log.warn('Failed to load email ingestion state — starting fresh');
    }
    return {
      lastCheckTimestamp: 0,
      processedMessageIds: [],
      totalIngested: 0,
      totalRejected: 0,
    };
  }

  private saveState(): void {
    try {
      fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to save email ingestion state');
    }
  }

  private loadSavedConfig(): void {
    try {
      if (fs.existsSync(this.configPath)) {
        const raw = JSON.parse(fs.readFileSync(this.configPath, 'utf-8'));
        if (raw.allowedSenders) this.config.allowedSenders = raw.allowedSenders;
        if (raw.allowedDomains) this.config.allowedDomains = raw.allowedDomains;
        if (raw.maxPerRun) this.config.maxPerRun = raw.maxPerRun;
      }
    } catch { /* use defaults */ }
  }

  private saveConfig(): void {
    try {
      const safeConfig = {
        allowedSenders: this.config.allowedSenders,
        allowedDomains: this.config.allowedDomains,
        maxPerRun: this.config.maxPerRun,
      };
      fs.writeFileSync(this.configPath, JSON.stringify(safeConfig, null, 2));
    } catch (err) {
      log.error({ error: (err as Error).message }, 'Failed to save email config');
    }
  }

  /**
   * Derive a deterministic record ID from an email messageId.
   * Uses SHA-256 hash truncated to 36 chars (UUID-length) so the same
   * messageId always produces the same filename / record key.
   */
  private messageIdToRecordId(messageId: string): string {
    return createHash('sha256').update(messageId).digest('hex').slice(0, 36);
  }

  /**
   * Strip any potential credential data from error messages.
   */
  private sanitizeError(message: string): string {
    // Remove anything that looks like a password or auth token
    return message
      .replace(/pass(?:word)?[=:]\s*\S+/gi, 'pass=***REDACTED***')
      .replace(/auth[=:]\s*\S+/gi, 'auth=***REDACTED***')
      .replace(/token[=:]\s*\S+/gi, 'token=***REDACTED***');
  }
}
