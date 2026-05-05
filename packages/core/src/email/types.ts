/**
 * Email Ingestion Types
 */

export interface EmailConfig {
  /** Gmail address to check */
  account: string;
  /** IMAP host */
  host: string;
  /** IMAP port */
  port: number;
  /** Use TLS */
  secure: boolean;
  /** Allowed sender emails */
  allowedSenders: string[];
  /** Allowed sender domains (e.g. "@company.com") */
  allowedDomains: string[];
  /** Directory to save attachments */
  attachmentDir: string;
  /** Max emails to fetch per run */
  maxPerRun: number;
}

export const DEFAULT_EMAIL_CONFIG: EmailConfig = {
  account: 'dezkindwords@gmail.com',
  host: 'imap.gmail.com',
  port: 993,
  secure: true,
  allowedSenders: [],
  allowedDomains: [],
  attachmentDir: '',
  maxPerRun: 50,
};

export interface ParsedEmail {
  messageId: string;
  from: string;
  to: string;
  subject: string;
  date: Date;
  textBody: string;
  htmlBody?: string;
  attachments: EmailAttachment[];
  headers: SafeHeaders;
}

/** Headers with sensitive fields stripped */
export interface SafeHeaders {
  from: string;
  to: string;
  subject: string;
  date: string;
  messageId: string;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  savedPath?: string;
  content?: Buffer;
}

export interface EmailRecord {
  id: string;
  messageId: string;
  sender: string;
  subject: string;
  body: string;
  timestamp: number;
  attachmentPaths: string[];
  status: 'ingested' | 'rejected' | 'failed';
  rejectReason?: string;
  ingestedAt: number;
}

export interface EmailIngestionState {
  lastCheckTimestamp: number;
  processedMessageIds: string[];
  totalIngested: number;
  totalRejected: number;
  lastError?: string;
  /** Message IDs that were saved to disk but failed cognitive memory ingestion */
  cognitiveMemoryFailedIds?: string[];
}

export interface EmailIngestionResult {
  fetched: number;
  ingested: number;
  rejected: number;
  duplicates: number;
  errors: number;
  details: Array<{
    messageId: string;
    subject: string;
    sender: string;
    status: 'ingested' | 'rejected' | 'duplicate' | 'error';
    reason?: string;
  }>;
}
