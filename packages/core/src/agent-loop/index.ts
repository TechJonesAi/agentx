/**
 * AgentX Agent Loop Module
 * Autonomous reasoning and task execution
 */

export { AgentLoopEngine } from './agent-loop-engine.js';
export { AgentLoopPlanner } from './agent-loop-planner.js';
export { AgentLoopExecutor } from './agent-loop-executor.js';
export { AgentLoopReflector } from './agent-loop-reflection.js';
export { AgentLoopRunner } from './agent-loop-runner.js';
export { eventBus } from './event-bus.js';
export { runtimeStateStore } from './runtime-state.js';

// Continuous Intelligence Layer
export { ExperienceStore } from './learning/index.js';
export { DEFAULT_LEARNING_CONFIG } from './learning/index.js';
export type {
  ExperienceRecord,
  ToolRoutingStat,
  ResearchPattern,
  ReasoningHeuristic,
  MultimodalPattern,
  LearningConfig,
} from './learning/index.js';

export type {
  // Core types
  AgentLoopGoal,
  AgentLoopTask,
  AgentLoopPlan,
  AgentLoopState,
  AgentLoopStatus,
  AgentLoopStatistics,
  AgentLoopConfig,
  AgentLoopContext,
  // Results and observations
  AgentLoopExecutionResult,
  AgentLoopObservation,
  AgentLoopReflection,
  AgentLoopAdjustment,
  // Event types
  AgentLoopStartedEvent,
  AgentLoopPlannedEvent,
  AgentLoopStepExecutedEvent,
  AgentLoopReflectionEvent,
  AgentLoopAdjustedEvent,
  AgentLoopCompletedEvent,
  AgentLoopFailedEvent,
} from './agent-loop-types.js';
