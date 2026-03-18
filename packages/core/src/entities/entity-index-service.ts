import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { generateId } from '../memory/id-generator.js';
import type { Entity, EntityMention } from '../memory/types.js';

const log = createLogger('entities:index-service');

export interface EntityMentionInput {
  mention_id: string;
  entity_id: string;
  document_id: string;
  page_id?: string;
  chunk_id?: string;
  position_start?: number;
  position_end?: number;
  context_before?: string;
  context_after?: string;
  mention_text: string;
  confidence?: number;
}

export class EntityIndexService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  upsertEntity(entity: any): Entity {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO entities (
        entity_id, canonical_form, entity_type, normalized_form,
        first_seen, last_seen, mention_count, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(canonical_form) DO UPDATE SET
        last_seen = ?,
        mention_count = mention_count + 1
    `);

    const entityId = entity.entity_id || generateId('entity');
    stmt.run(
      entityId,
      entity.canonical_form,
      entity.entity_type,
      entity.normalized_form,
      entity.first_seen || now,
      now,
      0,
      JSON.stringify(entity.metadata || {}),
      now,
      now,
    );

    return this.getEntityByCanonical(entity.canonical_form)!;
  }

  upsertMention(mention: EntityMentionInput): EntityMention {
    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO entity_mentions (
        mention_id, entity_id, document_id, page_id, chunk_id,
        position_start, position_end, context_before, context_after,
        mention_text, confidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      mention.mention_id,
      mention.entity_id,
      mention.document_id,
      mention.page_id ?? null,
      mention.chunk_id ?? null,
      mention.position_start ?? null,
      mention.position_end ?? null,
      mention.context_before ?? null,
      mention.context_after ?? null,
      mention.mention_text,
      mention.confidence ?? 1.0,
      now,
    );

    return this.getMention(mention.mention_id)!;
  }

  getMention(mentionId: string): EntityMention | null {
    const stmt = this.db.prepare('SELECT * FROM entity_mentions WHERE mention_id = ?');
    const row = stmt.get(mentionId) as any;

    if (!row) return null;

    return this.rowToMention(row);
  }

  getMentionsByEntity(entityId: string): EntityMention[] {
    const stmt = this.db.prepare('SELECT * FROM entity_mentions WHERE entity_id = ?');
    const rows = stmt.all(entityId) as any[];

    return rows.map(row => this.rowToMention(row));
  }

  getMentionsByDocument(documentId: string): EntityMention[] {
    const stmt = this.db.prepare('SELECT * FROM entity_mentions WHERE document_id = ?');
    const rows = stmt.all(documentId) as any[];

    return rows.map(row => this.rowToMention(row));
  }

  getMentionCount(entityId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM entity_mentions WHERE entity_id = ?');
    const result = stmt.get(entityId) as { count: number };

    return result.count;
  }

  getEntityByCanonical(canonicalForm: string): Entity | null {
    const stmt = this.db.prepare('SELECT * FROM entities WHERE canonical_form = ?');
    const row = stmt.get(canonicalForm) as any;

    if (!row) return null;

    return this.rowToEntity(row);
  }

  searchEntitiesByNormalized(normalizedForm: string): Entity[] {
    const stmt = this.db.prepare('SELECT * FROM entities WHERE normalized_form LIKE ?');
    const rows = stmt.all(`%${normalizedForm}%`) as any[];

    return rows.map(row => this.rowToEntity(row));
  }

  getEntityType(entityId: string): string | null {
    const stmt = this.db.prepare('SELECT entity_type FROM entities WHERE entity_id = ?');
    const result = stmt.get(entityId) as { entity_type: string } | undefined;

    return result?.entity_type ?? null;
  }

  private rowToEntity(row: any): Entity {
    return {
      entity_id: row.entity_id,
      canonical_form: row.canonical_form,
      entity_type: row.entity_type,
      normalized_form: row.normalized_form,
      first_seen: row.first_seen,
      last_seen: row.last_seen,
      mention_count: row.mention_count,
      metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
      created_at: row.created_at,
    };
  }

  private rowToMention(row: any): EntityMention {
    return {
      mention_id: row.mention_id,
      entity_id: row.entity_id,
      document_id: row.document_id,
      page_id: row.page_id,
      chunk_id: row.chunk_id,
      position_start: row.position_start,
      position_end: row.position_end,
      context_before: row.context_before,
      context_after: row.context_after,
      mention_text: row.mention_text,
      confidence: row.confidence,
      created_at: row.created_at,
    };
  }
}
