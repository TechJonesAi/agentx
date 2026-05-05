/**
 * Validation types — permissive definitions to support self-improvement-controller.
 */
export type RunStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped';
export type Subsystem = string; // Permissive — subsystem names vary across modules

export interface ValidationRun {
  id: string;
  status: RunStatus;
  subsystem: Subsystem;
  failures: ValidationFailure[];
  timestamp: number;
  pass?: boolean;
  scenarioId?: string;
  [key: string]: unknown;
}

export interface ValidationFailure {
  id: string;
  runId: string;
  subsystem: Subsystem;
  message: string;
  stackTrace?: string;
  dimension?: string;
  explanation?: string;
  [key: string]: unknown;
}

export interface RepairSuggestion {
  id: string;
  failureId: string;
  subsystem: Subsystem;
  description: string;
  suggestedFix: string;
  confidence: number;
  status?: string;
  issue?: string;
  sourceScenarioId?: string;
  [key: string]: unknown;
}

export interface SelfImprovementProposal {
  id: string;
  suggestions: RepairSuggestion[];
  autoApplyAllowed: boolean;
  createdAt: number;
  status?: string;
  targetSubsystem?: string;
  [key: string]: unknown;
}
