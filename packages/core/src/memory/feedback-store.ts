/**
 * R11 — chat feedback store.
 *
 * Persists thumbs-up/thumbs-down ratings on assistant messages along with
 * the originating query, response, and retrieval metadata snapshot. The
 * goal is data capture for future ranking work — this store does NOT
 * change retrieval behaviour.
 *
 * Schema is created on construction via CREATE TABLE IF NOT EXISTS so the
 * store is self-contained and works without depending on a migration run.
 */
import type Database from 'better-sqlite3';
import { generateId } from './id-generator.js';

export type FeedbackRating = 'up' | 'down';

export interface FeedbackPayload {
  messageId: string;
  userQuery: string;
  assistantResponse: string;
  rating: FeedbackRating;
  comment?: string;
  retrievalIntent?: string;
  retrievalSource?: string;
  retrievalMatchCount?: number;
  retrievalDocumentIds?: string[];
  sessionId?: string;
}

export interface FeedbackRecord {
  feedbackId: string;
  messageId: string;
  userQuery: string;
  assistantResponse: string;
  rating: FeedbackRating;
  comment: string | null;
  retrievalIntent: string | null;
  retrievalSource: string | null;
  retrievalMatchCount: number | null;
  retrievalDocumentIds: string[] | null;
  sessionId: string | null;
  createdAt: number;
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS chat_feedback (
  feedback_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  user_query TEXT NOT NULL,
  assistant_response TEXT NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  comment TEXT,
  retrieval_intent TEXT,
  retrieval_source TEXT,
  retrieval_match_count INTEGER,
  retrieval_document_ids TEXT,
  session_id TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_feedback_rating ON chat_feedback(rating);
CREATE INDEX IF NOT EXISTS idx_chat_feedback_created_at ON chat_feedback(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_feedback_message_id ON chat_feedback(message_id);
`;

export class FeedbackStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(SCHEMA_SQL);
  }

  /** Validate a payload. Throws Error on invalid input. */
  static validate(payload: unknown): FeedbackPayload {
    if (!payload || typeof payload !== 'object') {
      throw new Error('feedback payload must be an object');
    }
    const p = payload as Record<string, unknown>;
    const required = ['messageId', 'userQuery', 'assistantResponse', 'rating'] as const;
    for (const k of required) {
      if (typeof p[k] !== 'string' || (p[k] as string).length === 0) {
        throw new Error(`feedback.${k} must be a non-empty string`);
      }
    }
    if (p.rating !== 'up' && p.rating !== 'down') {
      throw new Error("feedback.rating must be 'up' or 'down'");
    }
    if (p.comment !== undefined && p.comment !== null && typeof p.comment !== 'string') {
      throw new Error('feedback.comment must be a string when present');
    }
    if (p.retrievalDocumentIds !== undefined && p.retrievalDocumentIds !== null) {
      if (!Array.isArray(p.retrievalDocumentIds)) {
        throw new Error('feedback.retrievalDocumentIds must be a string array when present');
      }
      for (const id of p.retrievalDocumentIds) {
        if (typeof id !== 'string') {
          throw new Error('feedback.retrievalDocumentIds entries must be strings');
        }
      }
    }
    return {
      messageId: p.messageId as string,
      userQuery: p.userQuery as string,
      assistantResponse: p.assistantResponse as string,
      rating: p.rating,
      comment: typeof p.comment === 'string' ? p.comment : undefined,
      retrievalIntent: typeof p.retrievalIntent === 'string' ? p.retrievalIntent : undefined,
      retrievalSource: typeof p.retrievalSource === 'string' ? p.retrievalSource : undefined,
      retrievalMatchCount: typeof p.retrievalMatchCount === 'number' ? p.retrievalMatchCount : undefined,
      retrievalDocumentIds: Array.isArray(p.retrievalDocumentIds) ? p.retrievalDocumentIds as string[] : undefined,
      sessionId: typeof p.sessionId === 'string' ? p.sessionId : undefined,
    };
  }

  record(payload: FeedbackPayload): FeedbackRecord {
    const validated = FeedbackStore.validate(payload);
    const feedbackId = generateId('fbk');
    const createdAt = Date.now();

    this.db.prepare(`
      INSERT INTO chat_feedback (
        feedback_id, message_id, user_query, assistant_response, rating,
        comment, retrieval_intent, retrieval_source, retrieval_match_count,
        retrieval_document_ids, session_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      feedbackId,
      validated.messageId,
      validated.userQuery,
      validated.assistantResponse,
      validated.rating,
      validated.comment ?? null,
      validated.retrievalIntent ?? null,
      validated.retrievalSource ?? null,
      validated.retrievalMatchCount ?? null,
      validated.retrievalDocumentIds ? JSON.stringify(validated.retrievalDocumentIds) : null,
      validated.sessionId ?? null,
      createdAt,
    );

    return {
      feedbackId,
      messageId: validated.messageId,
      userQuery: validated.userQuery,
      assistantResponse: validated.assistantResponse,
      rating: validated.rating,
      comment: validated.comment ?? null,
      retrievalIntent: validated.retrievalIntent ?? null,
      retrievalSource: validated.retrievalSource ?? null,
      retrievalMatchCount: validated.retrievalMatchCount ?? null,
      retrievalDocumentIds: validated.retrievalDocumentIds ?? null,
      sessionId: validated.sessionId ?? null,
      createdAt,
    };
  }

  list(limit = 100): FeedbackRecord[] {
    // Tie-break on rowid so two records inserted in the same millisecond
    // still return in deterministic newest-first order.
    const rows = this.db.prepare(`
      SELECT * FROM chat_feedback ORDER BY created_at DESC, rowid DESC LIMIT ?
    `).all(limit) as Array<Record<string, unknown>>;
    return rows.map(r => this.rowToRecord(r));
  }

  count(): number {
    const row = this.db.prepare('SELECT COUNT(*) as n FROM chat_feedback').get() as { n: number };
    return row.n;
  }

  private rowToRecord(row: Record<string, unknown>): FeedbackRecord {
    let docIds: string[] | null = null;
    const raw = row.retrieval_document_ids;
    if (typeof raw === 'string' && raw.length > 0) {
      try { docIds = JSON.parse(raw); } catch { docIds = null; }
    }
    return {
      feedbackId: String(row.feedback_id),
      messageId: String(row.message_id),
      userQuery: String(row.user_query),
      assistantResponse: String(row.assistant_response),
      rating: row.rating as FeedbackRating,
      comment: row.comment === null || row.comment === undefined ? null : String(row.comment),
      retrievalIntent: row.retrieval_intent === null ? null : String(row.retrieval_intent),
      retrievalSource: row.retrieval_source === null ? null : String(row.retrieval_source),
      retrievalMatchCount: row.retrieval_match_count === null ? null : Number(row.retrieval_match_count),
      retrievalDocumentIds: docIds,
      sessionId: row.session_id === null ? null : String(row.session_id),
      createdAt: Number(row.created_at),
    };
  }
}
