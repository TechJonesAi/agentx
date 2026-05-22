/**
 * AgentX Agent Loop Types
 * Core types for autonomous reasoning cycles
 */

/**
 * Agent Loop Goal
 * What the agent should accomplish
 */
export interface AgentLoopGoal {
  id: string;
  description: string;
  context: Record<string, unknown>;
  constraints?: string[];
  maxSteps?: number;
  maxDuration?: number; // milliseconds
  maxFailures?: number;
  createdAt: number;
}

/**
 * Agent Loop Task
 * Individual steps in the plan
 */
export interface AgentLoopTask {
  id: string;
  action: 'inspect' | 'build' | 'repair' | 'query' | 'modify' | 'execute' | 'analyze';
  description: string;
  targetPath?: string;
  parameters?: Record<string, unknown>;
  dependencies?: string[]; // task IDs this depends on
  retryCount?: number;
  maxRetries?: number;
}

/**
 * Agent Loop Plan
 * Strategy to accomplish the goal
 */
export interface AgentLoopPlan {
  id: string;
  goalId: string;
  tasks: AgentLoopTask[];
  reasoning: string; // Why these tasks?
  expectedOutcome: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * Agent Loop Execution Result
 * Outcome of executing a step
 */
export interface AgentLoopExecutionResult {
  taskId: string;
  success: boolean;
  output?: unknown;
  error?: string;
  duration: number;
  timestamp: number;
  toolsCalled?: string[];
  stateChanges?: Record<string, unknown>;
}

/**
 * Agent Loop Observation
 * What happened after execution
 */
export interface AgentLoopObservation {
  stepNumber: number;
  taskId: string;
  executionResult: AgentLoopExecutionResult;
  buildMetrics?: {
    successRate?: number;
    errorCount?: number;
    buildTime?: number;
  };
  projectState?: {
    status?: string;
    errors?: string[];
    warnings?: string[];
  };
  timestamp: number;
}

/**
 * Agent Loop Reflection
 * Analysis of what went right/wrong
 */
export interface AgentLoopReflection {
  stepNumber: number;
  observation: AgentLoopObservation;
  analysis: string; // What did the agent learn?
  successMetrics: {
    errorReduction: number; // % reduction in errors
    progressMade: number; // % progress toward goal
    toolEfficiency: number; // % of tools that succeeded
  };
  shouldContinue: boolean;
  recommendedAdjustments?: string[];
  confidence: number; // 0-1, how confident in the analysis
  timestamp: number;
}

/**
 * Agent Loop Adjustment
 * Changes to the plan based on reflection
 */
export interface AgentLoopAdjustment {
  stepNumber: number;
  reason: string;
  planUpdates: {
    tasksAdded?: AgentLoopTask[];
    tasksRemoved?: string[];
    tasksModified?: AgentLoopTask[];
    priorityReordered?: boolean;
  };
  timestamp: number;
}

/**
 * Agent Loop State
 * Current state of the loop
 */
export type AgentLoopStatus =
  | 'created'
  | 'planning'
  | 'executing'
  | 'observing'
  | 'reflecting'
  | 'adjusting'
  | 'completed'
  | 'failed'
  | 'stopped';

export interface AgentLoopState {
  loopId: string;
  goal: AgentLoopGoal;
  plan: AgentLoopPlan | null;
  currentStep: number;
  status: AgentLoopStatus;
  executionResults: AgentLoopExecutionResult[];
  observations: AgentLoopObservation[];
  reflections: AgentLoopReflection[];
  adjustments: AgentLoopAdjustment[];
  totalDuration: number;
  startTime: number;
  endTime?: number;
  finalOutcome?: {
    success: boolean;
    summary: string;
    metrics: Record<string, unknown>;
  };
}

/**
 * Agent Loop Statistics
 * Metrics about loop execution
 */
export interface AgentLoopStatistics {
  totalLoops: number;
  successfulLoops: number;
  failedLoops: number;
  averageSteps: number;
  averageDuration: number;
  toolsUsed: string[];
  commonFailures: string[];
  successRate: number;
}

/**
 * Agent Loop Configuration
 */
export interface AgentLoopConfig {
  maxSteps: number;
  maxDuration: number; // ms
  maxFailures: number;
  enableLogging: boolean;
  enableTelemetry: boolean;
  enableEventEmission: boolean;
  enableMemoryLearning: boolean;
  retryFailedTasks: boolean;
  maxRetries: number;
  thoughtModel?: string; // LLM model for planning/reflection
  learning?: import('./learning/types.js').LearningConfig;
  enableMultiAgent?: boolean; // Route complex goals to AgentOrchestrator
  enableAutoBuild?: boolean; // Route build goals to BuildController
}

/**
 * Agent Loop Context
 * Access to platform systems
 */
export interface AgentLoopContext {
  buildMemory?: any; // Build learning memory reference
  workflowRuntime?: any; // Workflow runtime reference
  toolRegistry?: any; // Tool registry reference
  projectState?: Record<string, unknown>;
  sessionId?: string;
  llmProvider?: any; // LLM provider for planning/reasoning
  eventBus?: any; // Event bus for emitting events
  stateStore?: any; // Runtime state store for tracking loops
  longTermMemory?: any; // Long-term memory for pattern storage and retrieval
  builderV2?: any; // Builder V2 for app generation
  experienceStore?: import('./learning/experience-store.js').ExperienceStore;
  feedbackLoop?: any;
  executiveController?: any;
  memoryIngestionEngine?: import('../memory/memory-ingestion.js').MemoryIngestionEngine;
  orchestrator?: any;
  buildController?: any;
  autonomyGate?: import('../validation/autonomy-gate.js').AutonomyGate;
  checkpointManager?: import('../stability/checkpoint-manager.js').CheckpointManager;
  checkpointStateProvider?: () => Record<string, unknown>;
  buildIntelligenceService?: any;
  personalizationService?: any;
  /** Batch 7A — durable workflow store. When present, AgentLoopEngine
   *  registers every loop run + lifecycle event for restart recovery and
   *  dashboard surfacing. Optional so existing tests / standalone engine
   *  use stay compatible. */
  workflowRunStore?: import('../observability/workflow-run-store.js').WorkflowRunStore;
}

/**
 * Agent Loop Event Payloads
 */
export interface AgentLoopStartedEvent {
  loopId: string;
  goal: AgentLoopGoal;
  timestamp: number;
}

export interface AgentLoopPlannedEvent {
  loopId: string;
  plan: AgentLoopPlan;
  timestamp: number;
}

export interface AgentLoopStepExecutedEvent {
  loopId: string;
  stepNumber: number;
  taskId: string;
  result: AgentLoopExecutionResult;
  timestamp: number;
}

export interface AgentLoopReflectionEvent {
  loopId: string;
  stepNumber: number;
  reflection: AgentLoopReflection;
  timestamp: number;
}

export interface AgentLoopAdjustedEvent {
  loopId: string;
  stepNumber: number;
  adjustment: AgentLoopAdjustment;
  timestamp: number;
}

export interface AgentLoopCompletedEvent {
  loopId: string;
  success: boolean;
  totalSteps: number;
  duration: number;
  outcome: string;
  timestamp: number;
}

export interface AgentLoopFailedEvent {
  loopId: string;
  reason: string;
  failedAtStep: number;
  error: string;
  timestamp: number;
}
