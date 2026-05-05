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

export type RetrievalSource = 'sql' | 'entity' | 'fts' | 'vector' | 'mixed';

export interface RetrievalResponse {
  logId: string;
  intent: QueryIntent;
  source: RetrievalSource;
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
      const sourceInfo: { source: RetrievalSource } = { source: 'fts' };
      const results = await this.executeRetrieval(intent, query, options.topK || 10, sourceInfo);
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
        source: sourceInfo.source,
        results,
        executionMs,
      };
    } catch (error) {
      log.error({ query, intent, error }, 'Retrieval failed');
      throw error;
    }
  }

  private async executeRetrieval(intent: QueryIntent, query: string, topK: number, sourceInfo: { source: RetrievalSource }): Promise<RetrievalResult[]> {
    switch (intent) {
      case 'COUNT':
        sourceInfo.source = 'sql';
        return this.handleCountQuery(query);
      case 'EXACT_SEARCH':
        return this.handleExactSearch(query, topK, sourceInfo);
      case 'FILTERED_SEARCH':
        sourceInfo.source = 'fts';
        return this.handleFilteredSearch(query, topK);
      case 'SEMANTIC':
        sourceInfo.source = 'vector';
        return this.handleSemanticSearch(query, topK);
      case 'ANALYTICAL':
        sourceInfo.source = 'mixed';
        return this.handleAnalyticalQuery(query, topK);
      default:
        return [];
    }
  }

  /**
   * R1.5: Parse a count-intent query for type filters and count via SQL only.
   * The LLM is never consulted for counts. Recognised filters:
   *   - file_type: "pdf"/"pdfs", "txt"/"txts", "docx", "image"/"images", "json"
   *   - content_type: "email"/"emails", "report"/"reports", "letter"/"letters",
   *     "legal"/"legal documents", "policy"/"policies", "transcript"/"transcripts"
   *   - origin_type: "scanned"/"scanned documents"/"OCR"
   * If multiple filters match the most-specific (file_type) wins.
   * If none match, the total count is returned.
   */
  private handleCountQuery(query: string): RetrievalResult[] {
    const filters = this.parseCountFilters(query);
    const count = this.registry.count(filters);
    const result: RetrievalResult = {
      result_id: generateId('result'),
      log_id: '',
      document_id: '',
      rank: 1,
      score: count,
      score_type: 'count',
      created_at: Date.now(),
    };
    return [result];
  }

  /** R1.5 helper — exposed for testing. */
  parseCountFilters(query: string): Partial<{
    file_type: string;
    origin_type: string;
    classification_label: string;
  }> {
    const q = query.toLowerCase();
    const filters: Partial<{ file_type: string; origin_type: string; classification_label: string }> = {};

    // file_type (most specific — wins)
    if (/\bpdfs?\b/.test(q))               filters.file_type = 'pdf';
    else if (/\b(txt|text)s?\b/.test(q))   filters.file_type = 'txt';
    else if (/\bdocx\b/.test(q))           filters.file_type = 'docx';
    else if (/\b(images?|jpe?gs?|pngs?)\b/.test(q)) filters.file_type = 'image';
    else if (/\bjsons?\b/.test(q))         filters.file_type = 'json';

    // content_type via classification_label
    if (!filters.file_type) {
      if (/\bemails?\b/.test(q))           filters.classification_label = 'email';
      else if (/\breports?\b/.test(q))     filters.classification_label = 'report';
      else if (/\bletters?\b/.test(q))     filters.classification_label = 'letter';
      else if (/\bpolic(y|ies)\b/.test(q)) filters.classification_label = 'policy';
      else if (/\btranscripts?\b/.test(q)) filters.classification_label = 'transcript';
      else if (/\blegal\b/.test(q))        filters.classification_label = 'legal_document';
    }

    // origin_type
    if (/\b(scanned|ocr|ocr-noisy)\b/.test(q)) filters.origin_type = 'scanned';

    return filters;
  }

  /**
   * R1.5: When a query asks for "all"/"every"/"list every"/"show all",
   * exact-search must NOT silently truncate to topK.
   */
  private isAllMatchQuery(query: string): boolean {
    const q = query.toLowerCase();
    return /\b(all|every|list (every|all)|show all|each)\b/.test(q);
  }

  /**
   * R1.5: extract the target phrase from a natural-language exact-search query.
   * "show all references to robert moyes" → "robert moyes"
   * "list every mention of grievance" → "grievance"
   * '"exact phrase"' → "exact phrase"
   */
  extractExactSearchPhrase(query: string): string {
    // 1) if the whole query is wrapped in quotes, return the inner content
    const quoted = query.match(/^"([^"]+)"$|^'([^']+)'$/);
    if (quoted) return quoted[1] ?? quoted[2] ?? '';

    // 2) try common natural-language patterns
    const patterns: RegExp[] = [
      /\b(?:references?|mentions?|occurrences?|references? to|mentions? of)\s+(?:to\s+|of\s+)?(.+?)$/i,
      /\b(?:which|what)\s+documents?\s+(?:that\s+)?(?:mention|reference|contain)\s+(.+?)$/i,
      /\b(?:find|show|list|get)\s+(?:all\s+|every\s+)?(?:documents?|files?)?\s*(?:that\s+)?(?:mention|reference|contain)\s+(.+?)$/i,
      /\b(?:find|show|list|get)\s+(?:all\s+|every\s+)?(?:references?|mentions?|occurrences?)\s+(?:to|of)\s+(.+?)$/i,
      /\bnamed\s+(.+?)$/i,
      /\bcalled\s+(.+?)$/i,
    ];
    for (const re of patterns) {
      const m = query.match(re);
      if (m && m[1]) return m[1].replace(/[\?\.\!]+$/, '').trim();
    }
    // 3) fallback: whole query (legacy behaviour, but with quote stripping)
    return query.replace(/^["']|["']$/g, '').trim();
  }

  /**
   * R4/R6: exact-search routes through EntityIndexService FIRST. If entity
   * results don't fill the requested limit, supplement with FTS5 phrase
   * search and merge by document_id.
   *
   * Source labelling:
   *   - 'entity' — at least one entity match AND FTS contributed nothing new
   *   - 'fts'    — no entity match (or empty results overall)
   *   - 'mixed'  — entity matched AND FTS added at least one new document
   *
   * The 'isAllMatchQuery' cap-lift from R1.5 applies on both legs so
   * "show all references to X" returns every match across both sources.
   */
  private handleExactSearch(query: string, topK: number, sourceInfo: { source: RetrievalSource }): RetrievalResult[] {
    const phrase = this.extractExactSearchPhrase(query);
    const limit = this.isAllMatchQuery(query) ? 10_000 : topK;

    const seen = new Set<string>();
    const results: RetrievalResult[] = [];

    // 1) Entity-index leg
    const entities = this.entityIndex.searchEntitiesByNormalized(phrase.toLowerCase());
    let entityResultsCount = 0;
    for (const entity of entities) {
      const mentions = this.entityIndex.getMentionsByEntity(entity.entity_id);
      for (const m of mentions) {
        if (seen.has(m.document_id)) continue;
        seen.add(m.document_id);
        const doc = this.registry.get(m.document_id);
        if (!doc) continue;
        results.push({
          result_id: generateId('result'),
          log_id: '',
          document_id: doc.document_id,
          chunk_id: m.chunk_id,
          rank: results.length + 1,
          score: 1.0,
          score_type: 'entity_match',
          matched_field: 'entity_mention',
          created_at: Date.now(),
        });
        entityResultsCount++;
        if (results.length >= limit) break;
      }
      if (results.length >= limit) break;
    }

    // 2) Supplement with FTS only when entity didn't fill the limit
    let ftsContributed = 0;
    if (results.length < limit) {
      const ftsResults = this.ftsIndex.phraseSearch(phrase, limit);
      for (const ftsResult of ftsResults) {
        if (seen.has(ftsResult.document_id)) continue; // already from entity leg
        seen.add(ftsResult.document_id);
        const doc = this.registry.get(ftsResult.document_id);
        if (!doc) continue;
        results.push({
          result_id: generateId('result'),
          log_id: '',
          document_id: doc.document_id,
          rank: results.length + 1,
          score: 1.0,
          score_type: 'exact_match',
          matched_field: 'full_text',
          created_at: Date.now(),
        });
        ftsContributed++;
        if (results.length >= limit) break;
      }
    }

    // 3) Source labelling
    if (entityResultsCount > 0 && ftsContributed > 0) {
      sourceInfo.source = 'mixed';
    } else if (entityResultsCount > 0) {
      sourceInfo.source = 'entity';
    } else {
      sourceInfo.source = 'fts';
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
