import type Database from 'better-sqlite3';
import { createLogger } from '../logger.js';
import { QueryIntentRouter } from './query-intent-router.js';
import { EvidenceAggregator } from './evidence-aggregator.js';
import { RetrievalLogger } from './retrieval-logger.js';
import { FtsIndexService } from '../memory/fts-index-service.js';
import { EntityIndexService } from '../entities/entity-index-service.js';
import { DocumentRegistry } from '../memory/document-registry.js';
import type { QueryIntent, RetrievalResult, DocumentMetadata, DocumentChunk } from '../memory/types.js';
import { generateId } from '../memory/id-generator.js';

const log = createLogger('retrieval:service');

export interface RetrievalOptions {
  topK?: number;
  userId?: string;
  sessionId?: string;
}

export interface RetrievalResponse {
  logId: string;
  intent: QueryIntent;
  results: RetrievalResult[];
  executionMs: number;
}

export class RetrievalService {
  private router: QueryIntentRouter;
  private aggregator: EvidenceAggregator;
  private logger: RetrievalLogger;
  private ftsIndex: FtsIndexService;
  private entityIndex: EntityIndexService;
  private registry: DocumentRegistry;
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.router = new QueryIntentRouter();
    this.aggregator = new EvidenceAggregator();
    this.logger = new RetrievalLogger(db);
    this.ftsIndex = new FtsIndexService(db);
    this.entityIndex = new EntityIndexService(db);
    this.registry = new DocumentRegistry(db);
  }

  async retrieve(query: string, options: RetrievalOptions = {}): Promise<RetrievalResponse> {
    const startTime = Date.now();
    const intent = this.router.routeQuery(query);
    const logId = generateId('retrieval');

    try {
      const results = await this.executeRetrieval(intent, query, options.topK || 10);
      const executionMs = Date.now() - startTime;

      this.logger.logRetrieval({
        log_id: logId,
        query_text: query,
        query_intent: intent,
        user_id: options.userId,
        session_id: options.sessionId,
        result_count: results.length,
        execution_ms: executionMs,
        ranked_correctly: false,
        feedback_provided: false,
        created_at: Date.now(),
      }, results);

      return {
        logId,
        intent,
        results,
        executionMs,
      };
    } catch (error) {
      log.error({ query, intent, error }, 'Retrieval failed');
      throw error;
    }
  }

  private async executeRetrieval(intent: QueryIntent, query: string, topK: number): Promise<RetrievalResult[]> {
    switch (intent) {
      case 'COUNT':
        return this.handleCountQuery(query);
      case 'EXACT_SEARCH':
        return this.handleExactSearch(query, topK);
      case 'FILTERED_SEARCH':
        return this.handleFilteredSearch(query, topK);
      case 'SEMANTIC':
        return this.handleSemanticSearch(query, topK);
      case 'ANALYTICAL':
        return this.handleAnalyticalQuery(query, topK);
      default:
        return [];
    }
  }

  private handleCountQuery(query: string): RetrievalResult[] {
    const docCount = this.registry.count();
    const result: RetrievalResult = {
      result_id: generateId('result'),
      log_id: '',
      document_id: '',
      rank: 1,
      score: docCount,
      score_type: 'count',
      created_at: Date.now(),
    };
    return [result];
  }

  private handleExactSearch(query: string, topK: number): RetrievalResult[] {
    const cleanQuery = query.replace(/^["']|["']$/g, '');
    const ftsResults = this.ftsIndex.phraseSearch(cleanQuery, topK);

    const results: RetrievalResult[] = [];
    for (let rank = 0; rank < ftsResults.length; rank++) {
      const ftsResult = ftsResults[rank];
      const doc = this.registry.get(ftsResult.document_id);

      if (doc) {
        results.push({
          result_id: generateId('result'),
          log_id: '',
          document_id: doc.document_id,
          rank: rank + 1,
          score: 1.0,
          score_type: 'exact_match',
          matched_field: 'full_text',
          created_at: Date.now(),
        });
      }
    }

    return this.aggregator.deduplicate(results);
  }

  private handleFilteredSearch(query: string, topK: number): RetrievalResult[] {
    const ftsResults = this.ftsIndex.searchDocuments(query, topK);

    const results: RetrievalResult[] = [];
    for (let rank = 0; rank < ftsResults.length; rank++) {
      const ftsResult = ftsResults[rank];
      const doc = this.registry.get(ftsResult.document_id);

      if (doc) {
        results.push({
          result_id: generateId('result'),
          log_id: '',
          document_id: doc.document_id,
          rank: rank + 1,
          score: Math.abs(ftsResult.rank),
          score_type: 'fts_match',
          created_at: Date.now(),
        });
      }
    }

    return this.aggregator.deduplicate(results);
  }

  private async handleSemanticSearch(query: string, topK: number): Promise<RetrievalResult[]> {
    const ftsResults = this.ftsIndex.searchChunks(query, topK);

    const results: RetrievalResult[] = [];
    const seenDocs = new Set<string>();

    for (let rank = 0; rank < ftsResults.length; rank++) {
      const ftsResult = ftsResults[rank];
      const doc = this.registry.get(ftsResult.document_id);

      if (doc && !seenDocs.has(doc.document_id)) {
        seenDocs.add(doc.document_id);
        results.push({
          result_id: generateId('result'),
          log_id: '',
          document_id: doc.document_id,
          chunk_id: ftsResult.chunk_id,
          rank: rank + 1,
          score: Math.abs(ftsResult.rank),
          score_type: 'semantic_match',
          created_at: Date.now(),
        });
      }
    }

    return this.aggregator.deduplicate(results);
  }

  private async handleAnalyticalQuery(query: string, topK: number): Promise<RetrievalResult[]> {
    const ftsResults = this.ftsIndex.searchDocuments(query, topK);
    const results: RetrievalResult[] = [];

    for (let rank = 0; rank < ftsResults.length; rank++) {
      const ftsResult = ftsResults[rank];
      const doc = this.registry.get(ftsResult.document_id);

      if (doc) {
        results.push({
          result_id: generateId('result'),
          log_id: '',
          document_id: doc.document_id,
          rank: rank + 1,
          score: Math.abs(ftsResult.rank),
          score_type: 'analytical_match',
          created_at: Date.now(),
        });
      }
    }

    return this.aggregator.groupByDocument(this.aggregator.deduplicate(results));
  }
}
