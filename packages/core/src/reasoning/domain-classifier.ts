/**
 * Phase 1 — Domain Classifier
 *
 * Lightweight, pure, synchronous classifier mapping a user query to one of
 * five domains that the Decision Engine consumes via
 * `DecisionKnowledgeContext.detectedDomain`.
 *
 * Rules:
 *   - Pure: same input → same output. No state, no IO.
 *   - Priority order on tie: legal > medical > technical > financial > general.
 *     This biases toward the higher-stakes safety domains (legal, medical)
 *     when a query contains terms from multiple domains, which is the
 *     conservative choice for downstream routing.
 *   - Anchor-term whitelist per domain. Single words are matched on word
 *     boundaries; multi-word or punctuated phrases (e.g. "stack trace",
 *     "mg/ml") use substring matching after lower-casing.
 */

import type { DecisionDomain } from './decision-engine.js';

const LEGAL_TERMS: readonly string[] = [
  'contract', 'clause', 'plaintiff', 'defendant', 'tribunal', 'court',
  'lawsuit', 'statute', 'jurisdiction', 'indemnity', 'liability',
  'subpoena', 'litigation', 'arbitration', 'breach of contract',
];

const MEDICAL_TERMS: readonly string[] = [
  'diagnosis', 'symptom', 'symptoms', 'prescription', 'dosage', 'patient',
  'clinician', 'physician', 'medication', 'therapy', 'pathology',
  'antibiotic', 'icd', 'mg/ml', 'mmhg',
];

const TECHNICAL_TERMS: readonly string[] = [
  'api', 'endpoint', 'regex', 'deploy', 'build', 'runtime', 'segfault',
  'async', 'refactor', 'compiler', 'kubernetes', 'docker',
  'stack trace', 'database query',
];

const FINANCIAL_TERMS: readonly string[] = [
  'invoice', 'tax', 'gst', 'vat', 'ebitda', 'accruals', 'ledger',
  'revenue', 'expense', 'budget', 'audit', 'p&l', 'balance sheet',
];

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isMultiWordOrPunctuated(term: string): boolean {
  return term.includes(' ') || term.includes('/') || term.includes('&');
}

function matchAny(lower: string, terms: readonly string[]): boolean {
  for (const term of terms) {
    if (isMultiWordOrPunctuated(term)) {
      if (lower.includes(term)) return true;
    } else {
      const re = new RegExp(`\\b${escapeForRegex(term)}\\b`);
      if (re.test(lower)) return true;
    }
  }
  return false;
}

export class DomainClassifier {
  classify(query: string): DecisionDomain {
    if (typeof query !== 'string') return 'general';
    const trimmed = query.trim();
    if (trimmed.length === 0) return 'general';
    const lower = trimmed.toLowerCase();

    if (matchAny(lower, LEGAL_TERMS)) return 'legal';
    if (matchAny(lower, MEDICAL_TERMS)) return 'medical';
    if (matchAny(lower, TECHNICAL_TERMS)) return 'technical';
    if (matchAny(lower, FINANCIAL_TERMS)) return 'financial';
    return 'general';
  }
}
