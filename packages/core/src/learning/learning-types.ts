/**
 * Learning Foundation Layer — Type Definitions
 *
 * Structured experience capture for all AgentX subsystems.
 * NOT model training — this is experience recording for pattern analysis.
 */

export interface LearningSignal {
  subsystem: string;
  input: string;
  output: string;
  success: boolean;
  score?: number;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface LearningPattern {
  subsystem: string;
  patternType: 'success' | 'failure';
  count: number;
  avgScore: number;
  examples: LearningSignal[];
}

export interface LearningDiagnostics {
  totalSignals: number;
  signalsBySubsystem: Record<string, number>;
  successRate: number;
  avgScore: number;
  subsystemHealth: Record<string, { total: number; successRate: number; avgScore: number }>;
}
