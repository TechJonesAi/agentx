/**
 * R5 — Entity Ingestion Service
 *
 * Coordinates per-document entity extraction + indexing with re-ingestion
 * semantics: stale mentions for the document are removed before fresh ones
 * are written, so updating a document doesn't leave dangling mentions.
 *
 * Deduplication:
 *   - Across documents: `entities.canonical_form` is UNIQUE — `upsertEntity`
 *     hits ON CONFLICT and reuses the existing entity_id.
 *   - Within a document: `EntityExtractor.extract` uses a Map keyed on the
 *     entity value so repeated occurrences of the same name produce one
 *     entry per document.
 */

import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { generateId } from '../memory/id-generator.js';
import { EntityExtractor } from './entity-extractor.js';
import { EntityIndexService } from './entity-index-service.js';

const log = createLogger('entities:ingestion');

export interface EntityIngestionResult {
  entitiesProcessed: number;
  mentionsCreated: number;
  staleMentionsRemoved: number;
}

export class EntityIngestionService {
  private db: Database.Database;
  private extractor: EntityExtractor;
  private index: EntityIndexService;

  constructor(
    db: Database.Database,
    extractor: EntityExtractor = new EntityExtractor(),
    index?: EntityIndexService,
  ) {
    this.db = db;
    this.extractor = extractor;
    this.index = index ?? new EntityIndexService(db);
  }

  /**
   * Ingest entity mentions for a document. Removes any pre-existing mentions
   * for `documentId` first, then extracts + writes fresh ones. Idempotent
   * across re-runs.
   */
  ingestDocument(documentId: string, text: string): EntityIngestionResult {
    if (!documentId) throw new Error('EntityIngestionService.ingestDocument: documentId required');

    // Step 1: remove stale mentions for this document so re-ingestion is clean.
    const delResult = this.db.prepare('DELETE FROM entity_mentions WHERE document_id = ?').run(documentId);
    const staleMentionsRemoved = Number(delResult.changes ?? 0);

    if (!text || text.trim().length === 0) {
      return { entitiesProcessed: 0, mentionsCreated: 0, staleMentionsRemoved };
    }

    // Step 2: extract entities (extractor de-dupes within text via Map keying).
    const extracted = this.extractor.extract(text);

    // Step 3: upsert each entity, then write a fresh mention referencing the
    // STORED entity_id (the upsert may have collapsed onto a pre-existing id).
    let mentionsCreated = 0;
    for (const ent of extracted) {
      const stored = this.index.upsertEntity(ent);
      this.index.upsertMention({
        mention_id: generateId('mention'),
        entity_id: stored.entity_id,
        document_id: documentId,
        mention_text: ent.canonical_form,
        confidence: ent.confidence,
      });
      mentionsCreated++;
    }

    log.info({ documentId, entitiesProcessed: extracted.length, mentionsCreated, staleMentionsRemoved },
      'Entity ingestion complete');

    return { entitiesProcessed: extracted.length, mentionsCreated, staleMentionsRemoved };
  }

  /** Remove all entity mentions for a document (e.g. on document deletion). */
  removeDocumentMentions(documentId: string): number {
    const r = this.db.prepare('DELETE FROM entity_mentions WHERE document_id = ?').run(documentId);
    return Number(r.changes ?? 0);
  }
}
