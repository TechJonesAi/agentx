/**
 * Action Engine — Human-level desktop automation for AgentX
 *
 * Provides goal-oriented task execution using:
 * - LLM planning (qwen3)
 * - Vision feedback (qwen3-vl)
 * - macOS computer tools (mouse, keyboard, app control)
 * - Permission-gated execution
 */

export { ActionEngine, DEFAULT_CONFIG } from './action-engine.js';
export { ActionPlanner } from './action-planner.js';
export { ScreenAnalyzer } from './screen-analyzer.js';
export type {
  ActionEngineConfig,
  ActionEngineCallbacks,
  ActionPlan,
  ActionStep,
  ActionStepType,
  TaskExecution,
  TaskStatus,
  StepResult,
  StepStatus,
  ScreenAnalysis,
  UIElement,
} from './types.js';
