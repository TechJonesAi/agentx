/**
 * LLMInteractionLogger — structured record of every LLM call.
 *
 * Writes one JSON object per line (JSONL format) to a rotating file at
 *   $DATA_DIR/logs/llm-interactions.jsonl
 *
 * Each record captures:
 *   - id            : unique per call (used for correlation)
 *   - timestamp     : ISO timestamp
 *   - query         : the user's original input (truncated)
 *   - model         : which model produced the response
 *   - systemPromptPreview : first 600 chars of system prompt
 *   - evidence      : summary of [DOC-N] chunks attached (refs + fileNames + text snippets)
 *   - rawResponse   : the LLM's output, before any post-processing (truncated)
 *   - finalResponse : what the user saw (after grounding hedge + [DOC-N] replacement)
 *   - groundingReport : the GroundingReport if a check was run
 *   - durationMs    : how long the LLM call took
 *   - sessionId
 *   - knowledgeContext : summary (docChunkCount, isEmailFocused, queryIntent, retrievalFailed)
 *   - error         : populated only when the call failed
 *
 * The file is rotated when it exceeds 10 MB — the current file is renamed to
 * .1 and a fresh file is started. Last 3 rotations are kept.
 *
 * Design notes:
 *   - Sync append keeps ordering simple; a single interaction is ~2-6 KB,
 *     and we're not on a hot path.
 *   - Large fields (text, systemPrompt) are truncated to bound file size.
 *   - Logger never throws — observability failures must not break chat.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { resolveDataDir, ensureDataDir } from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('observability:llm');

const MAX_QUERY_LEN = 2000;
const MAX_SYSPROMPT_LEN = 600;
const MAX_RESPONSE_LEN = 8000;
const MAX_EVIDENCE_TEXT_LEN = 500;
const MAX_FILE_BYTES = 10 * 1024 * 1024;   // 10 MB per file
const MAX_ROTATIONS = 3;

export interface EvidenceSummary {
  citationRef: string;
  documentId: string;
  fileName: string | null;
  textSnippet: string;
  score?: number;
  pageNumber?: number | null;
}

export interface GroundingReportSummary {
  grounded: boolean;
  score: number;
  trustTier: 'high' | 'medium' | 'low';
  factualClaimCount: number;
  unsupportedCount: number;
  invalidCitations: string[];
  issueSample: Array<{ kind: string; message: string }>;
}

export interface LLMInteractionRecord {
  id: string;
  timestamp: string;
  sessionId?: string;
  query: string;
  model?: string;
  systemPromptPreview?: string;
  evidence: EvidenceSummary[];
  knowledgeContext?: {
    docChunkCount: number;
    memoryItemCount: number;
    isEmailFocused: boolean;
    queryIntent?: string;
    retrievalFailed?: boolean;
    resolvedDomain?: string;
  };
  rawResponse?: string;
  finalResponse?: string;
  groundingReport?: GroundingReportSummary;
  durationMs?: number;
  error?: string;
}

/**
 * Truncate a string to maxLen, adding an ellipsis marker when truncated.
 */
function truncate(s: string, maxLen: number): string {
  if (!s) return '';
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `… [+${s.length - maxLen} chars truncated]`;
}

export class LLMInteractionLogger {
  private static instance: LLMInteractionLogger | null = null;
  private filePath: string;
  private writable = true;

  static getInstance(): LLMInteractionLogger {
    if (!this.instance) this.instance = new LLMInteractionLogger();
    return this.instance;
  }

  private constructor(customPath?: string) {
    try {
      ensureDataDir();
      const logDir = path.join(resolveDataDir(), 'logs');
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      this.filePath = customPath ?? path.join(logDir, 'llm-interactions.jsonl');
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'LLMInteractionLogger: failed to set up log dir');
      this.filePath = '';
      this.writable = false;
    }
  }

  /** Generate a new unique interaction ID. */
  newId(): string {
    return `llm-${Date.now()}-${randomBytes(3).toString('hex')}`;
  }

  /**
   * Record a completed LLM interaction. Never throws.
   * Large fields are truncated to keep the log file bounded.
   */
  record(rec: LLMInteractionRecord): void {
    if (!this.writable) return;
    try {
      this.rotateIfNeeded();

      const safe: LLMInteractionRecord = {
        ...rec,
        query: truncate(rec.query ?? '', MAX_QUERY_LEN),
        systemPromptPreview: rec.systemPromptPreview ? truncate(rec.systemPromptPreview, MAX_SYSPROMPT_LEN) : undefined,
        rawResponse: rec.rawResponse ? truncate(rec.rawResponse, MAX_RESPONSE_LEN) : undefined,
        finalResponse: rec.finalResponse ? truncate(rec.finalResponse, MAX_RESPONSE_LEN) : undefined,
        evidence: (rec.evidence ?? []).map(e => ({
          ...e,
          textSnippet: truncate(e.textSnippet ?? '', MAX_EVIDENCE_TEXT_LEN),
        })),
      };

      const line = JSON.stringify(safe) + '\n';
      fs.appendFileSync(this.filePath, line, 'utf-8');
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'LLMInteractionLogger: write failed');
    }
  }

  /**
   * Fetch the most recent N interactions, newest first.
   * Used by the /api/logs/llm-interactions endpoint and tests.
   */
  tail(limit: number = 50): LLMInteractionRecord[] {
    if (!this.writable || !fs.existsSync(this.filePath)) return [];
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      const recent = lines.slice(-limit).reverse();
      const records: LLMInteractionRecord[] = [];
      for (const line of recent) {
        try {
          records.push(JSON.parse(line) as LLMInteractionRecord);
        } catch { /* skip malformed line */ }
      }
      return records;
    } catch (err) {
      log.warn({ error: (err as Error).message }, 'LLMInteractionLogger: tail failed');
      return [];
    }
  }

  /**
   * Look up a specific interaction by ID (used by the detail view).
   */
  findById(id: string): LLMInteractionRecord | null {
    if (!this.writable || !fs.existsSync(this.filePath)) return null;
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      const lines = content.split('\n').filter(l => l.trim().length > 0);
      for (const line of lines) {
        try {
          const rec = JSON.parse(line) as LLMInteractionRecord;
          if (rec.id === id) return rec;
        } catch { /* skip */ }
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Current log file path (for tests). */
  getFilePath(): string { return this.filePath; }

  /**
   * Rotate the log file when it exceeds MAX_FILE_BYTES.
   * Keeps up to MAX_ROTATIONS backups.
   */
  private rotateIfNeeded(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const stat = fs.statSync(this.filePath);
      if (stat.size < MAX_FILE_BYTES) return;

      // Shift existing rotations: .2 -> .3, .1 -> .2
      for (let i = MAX_ROTATIONS - 1; i >= 1; i--) {
        const from = `${this.filePath}.${i}`;
        const to = `${this.filePath}.${i + 1}`;
        if (fs.existsSync(from)) {
          try { fs.renameSync(from, to); } catch { /* best effort */ }
        }
      }
      // Rename current -> .1
      try { fs.renameSync(this.filePath, `${this.filePath}.1`); } catch { /* best effort */ }
    } catch (err) {
      log.debug({ error: (err as Error).message }, 'LLMInteractionLogger: rotation check failed');
    }
  }
}
