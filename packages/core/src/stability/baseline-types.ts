/**
 * Stable Baseline Protection — Type Definitions
 *
 * Types for the baseline feature registry and regression guard.
 * Ensures working features cannot regress silently as the system evolves.
 */

export type BaselineStatus = 'candidate' | 'validated' | 'locked';

export interface BaselineFeature {
  id: string;
  name: string;
  subsystem: string;
  status: BaselineStatus;
  validationScore: number;
  lastValidatedAt: number;
  locked: boolean;
  notes?: string;
}

export interface RegressionCheckResult {
  regression: boolean;
  severity: 'none' | 'minor' | 'critical';
  details: string[];
}

export interface BaselineMetrics {
  passRate: number;
  score: number;
  featureResults: Map<string, { pass: boolean; score: number }>;
}

export interface BaselineDiagnostics {
  totalFeatures: number;
  candidateFeatures: number;
  validatedFeatures: number;
  lockedFeatures: number;
  regressionHistory: RegressionCheckResult[];
  lastCheckAt: number | null;
}
