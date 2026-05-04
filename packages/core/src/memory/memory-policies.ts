/**
 * Memory Policies — Ranking, decay, promotion rules and scoring helpers
 *
 * Centralizes all scoring math, normalization, and heuristics for
 * the Lifelong Memory Core. No magic numbers scattered elsewhere.
 */

import * as crypto from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MemoryPolicy {
  rankingWeights: {
    relevance: number;   // text match contribution (default 0.50)
    strength: number;    // memory strength contribution (default 0.25)
    recency: number;     // time since last access (default 0.15)
    frequency: number;   // access count contribution (default 0.10)
  };
  /** Blend weights for the enhanced retrieval pipeline.
   *  When ImportanceScorer / EpisodeStore are wired into retrieval,
   *  these control how the base score, importance score, and episodic
   *  boost are blended into the final ranking. Must sum to 1.0. */
  retrievalBlend: {
    baseWeight: number;       // weight of traditional base score (default 0.65)
    importanceWeight: number; // weight of importance score (default 0.25)
    episodicWeight: number;   // weight of episodic context boost (default 0.10)
  };
  decay: {
    enabled: boolean;
    intervalHours: number;              // how often decay runs (default 24)
    halfLifeDays: number;               // strength halves every N days without access (default 30)
    minStrengthBeforeArchive: number;   // below this, auto-archive (default 0.05)
  };
  promotion: {
    experienceToProjectThreshold: number; // quality score threshold (default 0.8)
    researchToUserThreshold: number;      // access count threshold (default 5)
  };
}

export const DEFAULT_MEMORY_POLICY: MemoryPolicy = {
  rankingWeights: {
    relevance: 0.50,
    strength: 0.25,
    recency: 0.15,
    frequency: 0.10,
  },
  retrievalBlend: {
    baseWeight: 0.65,
    importanceWeight: 0.25,
    episodicWeight: 0.10,
  },
  decay: {
    enabled: true,
    intervalHours: 24,
    halfLifeDays: 30,
    minStrengthBeforeArchive: 0.05,
  },
  promotion: {
    experienceToProjectThreshold: 0.8,
    researchToUserThreshold: 5,
  },
};

// ---------------------------------------------------------------------------
// Content Normalization & Hashing
// ---------------------------------------------------------------------------

/** Normalize content for comparison: lowercase, collapse whitespace, trim */
export function normalizeContent(content: string): string {
  return content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** SHA-256 hash of normalized content */
export function contentHash(content: string): string {
  const normalized = normalizeContent(content);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

// ---------------------------------------------------------------------------
// Trigram Similarity (Jaccard)
// ---------------------------------------------------------------------------

/** Generate character trigrams from text */
export function generateTrigrams(text: string): Set<string> {
  const normalized = normalizeContent(text);
  const trigrams = new Set<string>();
  for (let i = 0; i <= normalized.length - 3; i++) {
    trigrams.add(normalized.substring(i, i + 3));
  }
  return trigrams;
}

/** Jaccard similarity between two trigram sets: |A ∩ B| / |A ∪ B| */
export function jaccardTrigramSimilarity(a: string, b: string): number {
  const trigramsA = generateTrigrams(a);
  const trigramsB = generateTrigrams(b);

  if (trigramsA.size === 0 && trigramsB.size === 0) return 1.0;
  if (trigramsA.size === 0 || trigramsB.size === 0) return 0.0;

  let intersection = 0;
  for (const t of trigramsA) {
    if (trigramsB.has(t)) intersection++;
  }

  const union = trigramsA.size + trigramsB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Scoring Helpers
// ---------------------------------------------------------------------------

/**
 * Compute text relevance score for a query against content.
 * Returns 0–1 based on term overlap and position weighting.
 */
// Common stop words that should not dilute keyword matching.
// These words appear in almost every sentence and matching them
// adds no signal — e.g. for "Where do I work?" only "work" is
// informative, but without filtering, "do" counts as 1 of 3 terms.
const STOP_WORDS = new Set([
  'the', 'be', 'to', 'of', 'and', 'in', 'that', 'have', 'it',
  'for', 'not', 'on', 'with', 'he', 'as', 'you', 'do', 'at',
  'this', 'but', 'his', 'by', 'from', 'they', 'we', 'say', 'her',
  'she', 'or', 'an', 'will', 'its', 'so', 'up', 'out', 'if',
  'about', 'who', 'get', 'which', 'go', 'me', 'when', 'can', 'no',
  'just', 'him', 'how', 'has', 'more', 'now', 'did', 'been',
  'am', 'are', 'was', 'were', 'where', 'what', 'is',
]);

export function computeRelevanceScore(query: string, content: string): { score: number; matchedTerms: string[] } {
  const queryNorm = normalizeContent(query);
  const contentNorm = normalizeContent(content);
  const allTerms = queryNorm.split(' ').filter(t => t.length > 1);
  const contentTerms = allTerms.filter(t => !STOP_WORDS.has(t));
  // Use content terms if available, otherwise fall back to all terms
  const queryTerms = contentTerms.length > 0 ? contentTerms : allTerms;
  const matchedTerms: string[] = [];

  if (queryTerms.length === 0) return { score: 0, matchedTerms };

  // Exact substring match bonus
  let exactBonus = 0;
  if (contentNorm.includes(queryNorm)) {
    exactBonus = 0.3;
  }

  // Per-term matching (against meaningful terms only)
  let termMatches = 0;
  for (const term of queryTerms) {
    if (contentNorm.includes(term)) {
      termMatches++;
      matchedTerms.push(term);
    }
  }
  const termScore = termMatches / queryTerms.length;

  // Bigram matching using ALL terms (including stop words)
  // to detect phrases like "my name", "do work"
  let bigramBonus = 0;
  if (allTerms.length >= 2) {
    let bigramMatches = 0;
    for (let i = 0; i < allTerms.length - 1; i++) {
      const bigram = allTerms[i] + ' ' + allTerms[i + 1];
      if (contentNorm.includes(bigram)) {
        bigramMatches++;
      }
    }
    if (bigramMatches > 0) {
      bigramBonus = 0.2 * (bigramMatches / (allTerms.length - 1));
    }
  }

  // Combine: term overlap (0.5 weight) + bigram (0.2) + exact bonus (0.3 weight)
  const rawScore = termScore * 0.5 + bigramBonus + exactBonus;
  return {
    score: Math.min(1.0, rawScore),
    matchedTerms,
  };
}

/**
 * Compute recency score from accessedAt (with createdAt fallback).
 * Returns 0–1 where 1 = very recent, decays exponentially.
 */
export function computeRecencyScore(accessedAt: number, createdAt: number, now?: number): number {
  const currentTime = now ?? Date.now();
  const lastAccess = accessedAt > 0 ? accessedAt : createdAt;
  const ageDays = (currentTime - lastAccess) / (1000 * 60 * 60 * 24);

  // Exponential decay with 30-day half-life for recency scoring
  // Score = e^(-ln(2) * ageDays / 30)
  const halfLifeDays = 30;
  return Math.exp(-Math.LN2 * ageDays / halfLifeDays);
}

/**
 * Compute frequency contribution from access count.
 * Returns 0–1 with logarithmic scaling.
 */
export function computeFrequencyScore(accessCount: number): number {
  if (accessCount <= 0) return 0;
  // log(1 + count) / log(1 + 100) → 0–1 range, saturates around 100 accesses
  return Math.min(1.0, Math.log(1 + accessCount) / Math.log(101));
}

/**
 * Compute the decay factor to apply to strength.
 * Returns the multiplier (0–1) to apply: newStrength = oldStrength * decayFactor
 */
export function computeDecayFactor(
  accessedAt: number,
  createdAt: number,
  halfLifeDays: number,
  now?: number,
): number {
  const currentTime = now ?? Date.now();
  const lastAccess = accessedAt > 0 ? accessedAt : createdAt;
  const ageDays = (currentTime - lastAccess) / (1000 * 60 * 60 * 24);

  if (ageDays <= 0) return 1.0;
  // Exponential decay: factor = 2^(-ageDays / halfLife)
  return Math.pow(2, -ageDays / halfLifeDays);
}

/**
 * Compute final combined ranking score.
 * Weights: relevance, strength, recency, frequency.
 */
export function computeFinalScore(
  relevance: number,
  strength: number,
  recency: number,
  frequency: number,
  weights: MemoryPolicy['rankingWeights'],
): number {
  return (
    relevance * weights.relevance +
    strength * weights.strength +
    recency * weights.recency +
    frequency * weights.frequency
  );
}

/**
 * Compute effective strength after decay.
 * Does NOT mutate — returns the effective value for ranking purposes.
 */
export function effectiveStrength(
  currentStrength: number,
  accessedAt: number,
  createdAt: number,
  halfLifeDays: number,
  now?: number,
): number {
  const factor = computeDecayFactor(accessedAt, createdAt, halfLifeDays, now);
  return currentStrength * factor;
}

/**
 * Compute reinforcement strength bump.
 * Increases strength toward 1.0 with diminishing returns.
 */
export function computeReinforcementBump(currentStrength: number): number {
  // Bump by 20% of the remaining gap to 1.0
  const gap = 1.0 - currentStrength;
  return Math.min(1.0, currentStrength + gap * 0.2);
}
