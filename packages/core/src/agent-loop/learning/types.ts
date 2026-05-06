/**
 * Continuous Intelligence Layer — Type Definitions
 */

export interface ExperienceRecord {
  id: string;
  goalDescription: string;
  goalHash: string;
  domain: string;
  toolSequence: string[];
  success: boolean;
  durationMs: number;
  qualityScore: number;
  stepCount: number;
  errorSummary?: string;
  createdAt: number;
}

export interface ToolRoutingStat {
  toolName: string;
  domain: string;
  actionType: string;
  invocationCount: number;
  successCount: number;
  failureCount: number;
  avgDurationMs: number;
  lastUsedAt: number;
}

export interface ResearchPattern {
  id: string;
  domain: string;
  originalQuery: string;
  expandedQueries: string[];
  resultQuality: number;
  usageCount: number;
  successCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface ReasoningHeuristic {
  id: string;
  patternName: string;
  domain: string;
  triggerConditions: Record<string, unknown>;
  reasoningTemplate: string;
  confidence: number;
  usageCount: number;
  successCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface MultimodalPattern {
  id: string;
  mediaType: string;
  contentCategory: string;
  interpretationStrategy: Record<string, unknown>;
  confidence: number;
  usageCount: number;
  successCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface LearningConfig {
  enabled: boolean;
  mode: 'conservative' | 'aggressive';
  skipToolThreshold: number;
  minInvocationsForSkip: number;
  maxInjectionTokens: number;
}

export const DEFAULT_LEARNING_CONFIG: LearningConfig = {
  enabled: true,
  mode: 'conservative',
  skipToolThreshold: 0.8,
  minInvocationsForSkip: 5,
  maxInjectionTokens: 1200,
};
