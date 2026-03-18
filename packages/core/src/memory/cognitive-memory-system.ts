import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { SqliteMemoryDb } from '../db/sqlite-memory.js';
import { DocumentRegistry } from './document-registry.js';
import { DocumentIngestionService } from '../ingestion/document-ingestion-service.js';
import { RetrievalService } from '../retrieval/retrieval-service.js';
import { LearningService } from './learning-service.js';
import { EntityIndexService } from '../entities/entity-index-service.js';
import { FtsIndexService } from './fts-index-service.js';
import { VectorIndexService } from './vector-index-service.js';

const log = createLogger('memory:cognitive-system');

export class CognitiveMemorySystem {
  private db: SqliteMemoryDb;
  private registry: DocumentRegistry;
  private ingestionService: DocumentIngestionService;
  private retrievalService: RetrievalService;
  private learningService: LearningService;
  private entityIndex: EntityIndexService;
  private ftsIndex: FtsIndexService;
  private vectorIndex: VectorIndexService | null = null;

  constructor(dataDir: string, vectorIndex?: VectorIndexService) {
    this.db = new SqliteMemoryDb(dataDir);
    this.registry = new DocumentRegistry(this.db.getDatabase());
    this.ingestionService = new DocumentIngestionService(this.db.getDatabase());
    this.retrievalService = new RetrievalService(this.db.getDatabase());
    this.learningService = new LearningService(this.db.getDatabase());
    this.entityIndex = new EntityIndexService(this.db.getDatabase());
    this.ftsIndex = new FtsIndexService(this.db.getDatabase());
    this.vectorIndex = vectorIndex || null;

    log.info({ dataDir }, 'Cognitive Memory System initialized');
  }

  getRegistry(): DocumentRegistry {
    return this.registry;
  }

  getIngestionService(): DocumentIngestionService {
    return this.ingestionService;
  }

  getRetrievalService(): RetrievalService {
    return this.retrievalService;
  }

  getLearningService(): LearningService {
    return this.learningService;
  }

  getEntityIndex(): EntityIndexService {
    return this.entityIndex;
  }

  getFtsIndex(): FtsIndexService {
    return this.ftsIndex;
  }

  getVectorIndex(): VectorIndexService | null {
    return this.vectorIndex;
  }

  getDatabase(): Database.Database {
    return this.db.getDatabase();
  }

  close(): void {
    this.db.close();
    log.info('Cognitive Memory System closed');
  }
}
