import { createLogger } from '../logger.js';
import type { RetrievalResult } from '../memory/types.js';

const log = createLogger('retrieval:aggregator');

export class EvidenceAggregator {
  deduplicate(results: RetrievalResult[]): RetrievalResult[] {
    const seen = new Map<string, RetrievalResult>();

    for (const result of results) {
      const key = `${result.document_id}:${result.chunk_id || 'doc'}`;
      const existing = seen.get(key);

      if (!existing || result.score > existing.score) {
        seen.set(key, result);
      }
    }

    return Array.from(seen.values()).sort((a, b) => a.rank - b.rank);
  }

  groupByDocument(results: RetrievalResult[]): RetrievalResult[] {
    const grouped = new Map<string, RetrievalResult[]>();

    for (const result of results) {
      if (!grouped.has(result.document_id)) {
        grouped.set(result.document_id, []);
      }
      grouped.get(result.document_id)!.push(result);
    }

    const aggregated: RetrievalResult[] = [];
    let rank = 1;

    for (const [, docResults] of grouped) {
      const bestScore = Math.max(...docResults.map(r => r.score));
      const firstResult = docResults[0];

      aggregated.push({
        ...firstResult,
        rank: rank++,
        score: bestScore,
        score_type: 'aggregated',
      });
    }

    return aggregated;
  }

  rankByRelevance(results: RetrievalResult[], boosts: Map<string, number> = new Map()): RetrievalResult[] {
    const boosted = results.map(result => ({
      ...result,
      score: result.score * (boosts.get(result.document_id) || 1.0),
    }));

    boosted.sort((a, b) => b.score - a.score);

    return boosted.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  compressForLlm(results: RetrievalResult[], maxChars: number = 4000): string {
    let totalChars = 0;
    const compressed: string[] = [];

    for (const result of results) {
      if (totalChars >= maxChars) break;

      const line = `[${result.rank}] ${result.document_id}`;

      if (totalChars + line.length + 1 <= maxChars) {
        compressed.push(line);
        totalChars += line.length + 1;
      } else {
        break;
      }
    }

    return compressed.join('\n');
  }
}
