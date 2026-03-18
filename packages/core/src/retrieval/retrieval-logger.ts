import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { generateId } from '../memory/id-generator.js';
import type { RetrievalLog, RetrievalResult } from '../memory/types.js';

const log = createLogger('retrieval:logger');

export class RetrievalLogger {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  logRetrieval(retrievalLog: RetrievalLog, results: RetrievalResult[]): void {
    try {
      const stmt = this.db.prepare(`
        INSERT INTO retrieval_logs (
          log_id, query_text, query_intent, user_id, session_id,
          result_count, execution_ms, ranked_correctly, feedback_provided, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        retrievalLog.log_id,
        retrievalLog.query_text,
        retrievalLog.query_intent,
        retrievalLog.user_id ?? null,
        retrievalLog.session_id ?? null,
        retrievalLog.result_count,
        retrievalLog.execution_ms,
        retrievalLog.ranked_correctly ? 1 : 0,
        retrievalLog.feedback_provided ? 1 : 0,
        retrievalLog.created_at,
      );

      this.logResults(retrievalLog.log_id, results);
    } catch (error) {
      log.error({ error }, 'Failed to log retrieval');
    }
  }

  private logResults(logId: string, results: RetrievalResult[]): void {
    const stmt = this.db.prepare(`
      INSERT INTO retrieval_results (
        result_id, log_id, document_id, chunk_id, rank, score, score_type, matched_field, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const result of results) {
      stmt.run(
        result.result_id,
        logId,
        result.document_id,
        result.chunk_id ?? null,
        result.rank,
        result.score,
        result.score_type,
        result.matched_field ?? null,
        result.created_at,
      );
    }
  }

  recordFeedback(
    logId: string,
    resultId: string | null,
    documentId: string,
    feedbackType: string,
    feedbackValue: number,
    notes?: string,
  ): void {
    try {
      const feedbackId = generateId('feedback');
      const stmt = this.db.prepare(`
        INSERT INTO user_feedback_memory (
          feedback_id, log_id, result_id, document_id, feedback_type, feedback_value, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        feedbackId,
        logId,
        resultId ?? null,
        documentId,
        feedbackType,
        feedbackValue,
        notes ?? null,
        Date.now(),
      );

      log.debug({ feedbackId, documentId }, 'Feedback recorded');
    } catch (error) {
      log.error({ error }, 'Failed to record feedback');
    }
  }

  getRetrievalLog(logId: string): RetrievalLog | null {
    const stmt = this.db.prepare('SELECT * FROM retrieval_logs WHERE log_id = ?');
    const row = stmt.get(logId) as any;

    if (!row) return null;

    return {
      log_id: row.log_id,
      query_text: row.query_text,
      query_intent: row.query_intent,
      user_id: row.user_id,
      session_id: row.session_id,
      result_count: row.result_count,
      execution_ms: row.execution_ms,
      ranked_correctly: row.ranked_correctly === 1,
      feedback_provided: row.feedback_provided === 1,
      created_at: row.created_at,
    };
  }

  getLogsForUser(userId: string, limit: number = 100): RetrievalLog[] {
    const stmt = this.db.prepare(`
      SELECT * FROM retrieval_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT ?
    `);
    const rows = stmt.all(userId, limit) as any[];

    return rows.map(row => ({
      log_id: row.log_id,
      query_text: row.query_text,
      query_intent: row.query_intent,
      user_id: row.user_id,
      session_id: row.session_id,
      result_count: row.result_count,
      execution_ms: row.execution_ms,
      ranked_correctly: row.ranked_correctly === 1,
      feedback_provided: row.feedback_provided === 1,
      created_at: row.created_at,
    }));
  }
}
