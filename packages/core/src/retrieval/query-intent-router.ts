import { createLogger } from '../logger.js';
import type { QueryIntent } from '../memory/types.js';

const log = createLogger('retrieval:intent-router');

export class QueryIntentRouter {
  routeQuery(query: string): QueryIntent {
    const lowerQuery = query.toLowerCase().trim();

    if (this.isCountQuery(lowerQuery)) {
      return 'COUNT';
    }

    if (this.isExactSearchQuery(lowerQuery)) {
      return 'EXACT_SEARCH';
    }

    if (this.isFilteredSearchQuery(lowerQuery)) {
      return 'FILTERED_SEARCH';
    }

    if (this.isAnalyticalQuery(lowerQuery)) {
      return 'ANALYTICAL';
    }

    return 'SEMANTIC';
  }

  private isCountQuery(query: string): boolean {
    const countPatterns = [
      /^how many/,
      /^count\s+/,
      /^number of/,
      /^total\s+/,
      /\bhow many\b/,
      /\bcount\b.*\?$/,
      /\btotal.*\?$/,
    ];

    return countPatterns.some(pattern => pattern.test(query));
  }

  private isExactSearchQuery(query: string): boolean {
    const exactPatterns = [
      /^".*"$/, // Quoted phrase
      /\bnamed\s+/,
      /\bcalled\s+/,
      /\bshows?\s+all.*where\b/,
      /\bmentions?\s+of\b/,
      /\bwhich documents.*mention\b/,
      // R1.5 — exact-reference patterns
      /\b(all|every|each)\s+(references?|mentions?|occurrences?)\b/,
      /\b(references?|mentions?)\s+to\s+\w/,
      /\bshow\s+all\b/,
      /\blist\s+(all|every)\b/,
      /\bfind\s+(all|every)\s+(mentions?|references?|occurrences?)/,
      /\b(documents?|files?)\s+(that\s+)?(mention|reference|contain)\b/,
    ];

    return exactPatterns.some(pattern => pattern.test(query));
  }

  private isFilteredSearchQuery(query: string): boolean {
    const filterPatterns = [
      /\bfrom\s+\w+/,
      /\bto\s+\w+/,
      /\bafter\s+\d/,
      /\bbefore\s+\d/,
      /\bfrom\s+\d{4}\b/,
      /\bfilter\s+/,
      /\bwhere\s+/,
      /\bonly\s+/,
    ];

    return filterPatterns.some(pattern => pattern.test(query));
  }

  private isAnalyticalQuery(query: string): boolean {
    const analyticalPatterns = [
      /\banalyze/,
      /\bsummarize/,
      /\bcompare/,
      /\brelationship/,
      /\bpattern/,
      /\btrend/,
      /\bcorrelate/,
    ];

    return analyticalPatterns.some(pattern => pattern.test(query));
  }
}
