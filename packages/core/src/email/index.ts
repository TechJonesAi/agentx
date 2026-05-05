/**
 * Email Ingestion Module
 *
 * Secure IMAP email fetching with Keychain-only credential storage.
 */

export { EmailIngestionService } from './email-ingestion-service.js';
export { getKeychainPassword, keychainEntryExists } from './keychain.js';
export type {
  EmailConfig,
  ParsedEmail,
  EmailAttachment,
  EmailRecord,
  EmailIngestionState,
  EmailIngestionResult,
  SafeHeaders,
} from './types.js';
export { DEFAULT_EMAIL_CONFIG } from './types.js';
