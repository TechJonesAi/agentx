import { describe, it, expect } from 'vitest';
import { DomainClassifier } from '../../src/reasoning/domain-classifier.js';
import type { DecisionDomain } from '../../src/reasoning/decision-engine.js';

const c = new DomainClassifier();

function expectDomain(query: string, expected: DecisionDomain) {
  expect(c.classify(query)).toBe(expected);
}

describe('DomainClassifier — legal', () => {
  it('classifies "What does the contract say?" as legal', () => {
    expectDomain('What does the contract say?', 'legal');
  });
  it('classifies "Find the clause about indemnity" as legal', () => {
    expectDomain('Find the clause about indemnity', 'legal');
  });
  it('classifies "The plaintiff filed a lawsuit" as legal', () => {
    expectDomain('The plaintiff filed a lawsuit', 'legal');
  });
  it('classifies "Tribunal hearing tomorrow" as legal', () => {
    expectDomain('Tribunal hearing tomorrow', 'legal');
  });
  it('classifies "Check the jurisdiction rules" as legal', () => {
    expectDomain('Check the jurisdiction rules', 'legal');
  });
  it('classifies "subpoena issued today" as legal (lowercase)', () => {
    expectDomain('subpoena issued today', 'legal');
  });
  it('classifies "Breach of contract case" as legal', () => {
    expectDomain('Breach of contract case', 'legal');
  });
  it('classifies "Arbitration is required" as legal', () => {
    expectDomain('Arbitration is required', 'legal');
  });
});

describe('DomainClassifier — medical', () => {
  it('classifies "What is the diagnosis?" as medical', () => {
    expectDomain('What is the diagnosis?', 'medical');
  });
  it('classifies "List the symptoms" as medical', () => {
    expectDomain('List the symptoms', 'medical');
  });
  it('classifies "Prescription dosage instructions" as medical', () => {
    expectDomain('Prescription dosage instructions', 'medical');
  });
  it('classifies "Patient history review" as medical', () => {
    expectDomain('Patient history review', 'medical');
  });
  it('classifies "Refer to clinician" as medical', () => {
    expectDomain('Refer to clinician', 'medical');
  });
  it('classifies "Physician follow-up" as medical', () => {
    expectDomain('Physician follow-up', 'medical');
  });
  it('classifies "ICD code lookup" as medical', () => {
    expectDomain('ICD code lookup', 'medical');
  });
  it('classifies "100 mg/ml dosage" as medical', () => {
    expectDomain('100 mg/ml dosage', 'medical');
  });
  it('classifies "Antibiotic course completed" as medical', () => {
    expectDomain('Antibiotic course completed', 'medical');
  });
});

describe('DomainClassifier — technical', () => {
  it('classifies "API endpoint failed" as technical', () => {
    expectDomain('API endpoint failed', 'technical');
  });
  it('classifies "Stack trace shows error" as technical', () => {
    expectDomain('Stack trace shows error', 'technical');
  });
  it('classifies "Deploy the app" as technical', () => {
    expectDomain('Deploy the app', 'technical');
  });
  it('classifies "Async function example" as technical', () => {
    expectDomain('Async function example', 'technical');
  });
  it('classifies "Refactor this module" as technical', () => {
    expectDomain('Refactor this module', 'technical');
  });
  it('classifies "Database query performance" as technical', () => {
    expectDomain('Database query performance', 'technical');
  });
  it('classifies "Docker container restart" as technical', () => {
    expectDomain('Docker container restart', 'technical');
  });
  it('classifies "Kubernetes pod issues" as technical', () => {
    expectDomain('Kubernetes pod issues', 'technical');
  });
  it('classifies "Regex pattern error" as technical', () => {
    expectDomain('Regex pattern error', 'technical');
  });
});

describe('DomainClassifier — financial', () => {
  it('classifies "Invoice 12345 outstanding" as financial', () => {
    expectDomain('Invoice 12345 outstanding', 'financial');
  });
  it('classifies "Tax filing deadline" as financial', () => {
    expectDomain('Tax filing deadline', 'financial');
  });
  it('classifies "Balance sheet review" as financial', () => {
    expectDomain('Balance sheet review', 'financial');
  });
  it('classifies "P&L for Q4" as financial', () => {
    expectDomain('P&L for Q4', 'financial');
  });
  it('classifies "EBITDA calculation" as financial', () => {
    expectDomain('EBITDA calculation', 'financial');
  });
  it('classifies "Revenue forecast updated" as financial', () => {
    expectDomain('Revenue forecast updated', 'financial');
  });
  it('classifies "Audit findings" as financial', () => {
    expectDomain('Audit findings', 'financial');
  });
  it('classifies "VAT registration" as financial', () => {
    expectDomain('VAT registration', 'financial');
  });
  it('classifies "Budget for next quarter" as financial', () => {
    expectDomain('Budget for next quarter', 'financial');
  });
});

describe('DomainClassifier — general fallback', () => {
  it('classifies empty string as general', () => {
    expectDomain('', 'general');
  });
  it('classifies whitespace-only as general', () => {
    expectDomain('   ', 'general');
  });
  it('classifies a greeting as general', () => {
    expectDomain('Hello there', 'general');
  });
  it('classifies "What time is it?" as general', () => {
    expectDomain('What time is it?', 'general');
  });
  it('classifies a pizza recipe query as general', () => {
    expectDomain('How do I make pizza dough', 'general');
  });
  it('classifies casual chat as general', () => {
    expectDomain('Just saying hi', 'general');
  });
  it('classifies non-string input as general', () => {
    expectDomain(undefined as unknown as string, 'general');
  });
});

describe('DomainClassifier — priority on tie (legal > medical > technical > financial)', () => {
  it('returns legal when legal and financial both match', () => {
    expectDomain('Tax dispute in court', 'legal');
  });
  it('returns medical when medical and financial both match', () => {
    expectDomain('Patient invoice payment', 'medical');
  });
  it('returns legal when legal and technical both match', () => {
    expectDomain('API contract breach', 'legal');
  });
  it('returns medical when medical and technical both match', () => {
    expectDomain('Doctor API access for diagnosis', 'medical');
  });
  it('returns legal when legal and medical both match', () => {
    expectDomain('Court patient records', 'legal');
  });
  it('returns technical when technical and financial both match', () => {
    expectDomain('Deploy the audit dashboard', 'technical');
  });
});

describe('DomainClassifier — edge cases', () => {
  it('is case-insensitive (UPPER)', () => {
    expectDomain('CONTRACT REVIEW', 'legal');
  });
  it('is case-insensitive (Mixed)', () => {
    expectDomain('Diagnosis Pending', 'medical');
  });
  it('handles long input without crashing', () => {
    const long = 'background context: ' + 'a '.repeat(2000) + 'invoice attached';
    expectDomain(long, 'financial');
  });
  it('handles punctuation-only input as general', () => {
    expectDomain('?!?!', 'general');
  });
  it('does not falsely match a substring (e.g. "court" within "courteous")', () => {
    expectDomain('She was very courteous to me', 'general');
  });
  it('does not falsely match "tax" within "taxonomy"', () => {
    expectDomain('Update the taxonomy of species', 'general');
  });
});
