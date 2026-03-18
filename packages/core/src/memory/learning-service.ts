import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { generateId } from './id-generator.js';
import type { LearnedBoost } from './types.js';

const log = createLogger('memory:learning');

export class LearningService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  recordDocumentUsage(documentId: string, entityId?: string, feedbackScore: number = 0): void {
    try {
      const boostId = generateId('boost');
      const now = Date.now();

      const stmt = this.db.prepare(`
        INSERT INTO learned_boosts (
          boost_id, document_id, entity_id, boost_type,
          boost_multiplier, frequency_used, avg_feedback_score, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(document_id, entity_id) DO UPDATE SET
          frequency_used = frequency_used + 1,
          avg_feedback_score = (avg_feedback_score * frequency_used + ?) / (frequency_used + 1),
          boost_multiplier = MIN(2.0, 1.0 + (frequency_used + 1) * 0.1),
          updated_at = ?
      `);

      stmt.run(
        boostId,
        documentId,
        entityId ?? null,
        'usage',
        1.1,
        1,
        feedbackScore,
        0.6,
        now,
        now,
        feedbackScore,
        now,
      );

      log.debug({ documentId, entityId }, 'Document usage recorded');
    } catch (error) {
      log.error({ documentId, error }, 'Failed to record document usage');
    }
  }

  recordCorrectionFeedback(
    documentId: string,
    correction: string,
    relevanceScore: number,
  ): void {
    try {
      const boostId = generateId('boost');
      const now = Date.now();

      const stmt = this.db.prepare(`
        INSERT INTO learned_boosts (
          boost_id, document_id, boost_type, boost_multiplier,
          frequency_used, avg_feedback_score, confidence, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      stmt.run(
        boostId,
        documentId,
        'correction',
        relevanceScore > 0.5 ? 1.2 : 0.8,
        1,
        relevanceScore,
        Math.min(relevanceScore, 1.0),
        now,
        now,
      );

      log.debug({ documentId }, 'Correction feedback recorded');
    } catch (error) {
      log.error({ documentId, error }, 'Failed to record correction feedback');
    }
  }

  getLearnedBoosts(documentId: string): LearnedBoost[] {
    try {
      const stmt = this.db.prepare(`
        SELECT * FROM learned_boosts WHERE document_id = ? ORDER BY boost_multiplier DESC
      `);
      const rows = stmt.all(documentId) as any[];

      return rows.map(row => ({
        boost_id: row.boost_id,
        document_id: row.document_id,
        entity_id: row.entity_id,
        boost_type: row.boost_type,
        boost_multiplier: row.boost_multiplier,
        frequency_used: row.frequency_used,
        avg_feedback_score: row.avg_feedback_score,
        confidence: row.confidence,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
    } catch (error) {
      log.error({ documentId, error }, 'Failed to get learned boosts');
      return [];
    }
  }

  getBoostMultiplier(documentId: string): number {
    try {
      const stmt = this.db.prepare(`
        SELECT MAX(boost_multiplier) as max_boost FROM learned_boosts WHERE document_id = ?
      `);
      const result = stmt.get(documentId) as { max_boost: number | null };

      return result.max_boost ?? 1.0;
    } catch (error) {
      log.error({ documentId, error }, 'Failed to get boost multiplier');
      return 1.0;
    }
  }

  applyLearnings(baseScores: Map<string, number>): Map<string, number> {
    const boostedScores = new Map<string, number>();

    for (const [documentId, baseScore] of baseScores) {
      const multiplier = this.getBoostMultiplier(documentId);
      boostedScores.set(documentId, baseScore * multiplier);
    }

    return boostedScores;
  }
}
