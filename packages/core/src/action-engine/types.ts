/**
 * Action Engine Types
 *
 * Shared types for the AgentX Task Execution Engine.
 * Converts natural-language goals into multi-step desktop automation
 * with screen-aware feedback loops.
 */

// ─── Action Steps ────────────────────────────────────────────────────────────

export type ActionStepType =
  | 'launch_app'
  | 'focus_app'
  | 'click'
  | 'type_text'
  | 'keyboard_shortcut'
  | 'mouse_move'
  | 'scroll'
  | 'wait'
  | 'screenshot'
  | 'verify';

export interface ActionStep {
  id: string;
  type: ActionStepType;
  description: string;
  params: Record<string, unknown>;
  /** What the screen should look like after this step succeeds */
  expectedOutcome?: string;
  /** Maximum time (ms) to wait for this step */
  timeoutMs?: number;
}

export interface ActionPlan {
  goal: string;
  steps: ActionStep[];
  reasoning: string;
  estimatedDurationMs: number;
}

// ─── Execution State ─────────────────────────────────────────────────────────

export type StepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'retrying';

export interface StepResult {
  stepId: string;
  status: StepStatus;
  output?: string;
  error?: string;
  screenshot?: string;  // base64
  durationMs: number;
  retryCount: number;
}

export type TaskStatus = 'planning' | 'executing' | 'verifying' | 'completed' | 'failed' | 'aborted';

export interface TaskExecution {
  id: string;
  goal: string;
  status: TaskStatus;
  plan: ActionPlan | null;
  stepResults: StepResult[];
  currentStepIndex: number;
  startedAt: number;
  finishedAt: number | null;
  finalVerification?: string;
  error?: string;
}

// ─── Screen Analysis ─────────────────────────────────────────────────────────

export interface UIElement {
  type: string;         // button, input, menu, text, window, icon, etc.
  label: string;        // visible text or aria label
  bounds?: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  clickTarget?: {
    x: number;
    y: number;
  };
  state?: string;       // focused, disabled, selected, etc.
}

export interface ScreenAnalysis {
  description: string;
  activeApp?: string;
  activeWindow?: string;
  elements: UIElement[];
  rawResponse: string;
  screenshotBase64: string;
  dimensions: { width: number; height: number };
  analyzedAt: number;
}

// ─── Callbacks ───────────────────────────────────────────────────────────────

export interface ActionEngineCallbacks {
  onPlanCreated?: (plan: ActionPlan) => void;
  onStepStart?: (step: ActionStep, index: number) => void;
  onStepComplete?: (result: StepResult, index: number) => void;
  onScreenAnalysis?: (analysis: ScreenAnalysis) => void;
  onReplan?: (newPlan: ActionPlan, reason: string) => void;
  onComplete?: (execution: TaskExecution) => void;
  onError?: (error: string, execution: TaskExecution) => void;
}

// ─── Configuration ───────────────────────────────────────────────────────────

export interface ActionEngineConfig {
  /** Vision model for screen analysis */
  visionModel: string;
  /** LLM model for planning */
  plannerModel: string;
  /** Ollama base URL */
  ollamaBaseUrl: string;
  /** Max retries per step */
  maxRetries: number;
  /** Max total steps in a plan */
  maxSteps: number;
  /** Delay between steps (ms) for UI to settle */
  stepDelayMs: number;
  /** Whether to capture screenshot before each step */
  screenshotBeforeStep: boolean;
  /** Whether to verify each step with a screenshot */
  verifyAfterStep: boolean;
  /** Whether approval is needed before execution */
  requireApproval: boolean;
}

export const DEFAULT_CONFIG: ActionEngineConfig = {
  visionModel: 'qwen3-vl:32b',
  plannerModel: 'qwen3:14b',
  ollamaBaseUrl: 'http://127.0.0.1:11434',
  maxRetries: 2,
  maxSteps: 20,
  stepDelayMs: 500,
  screenshotBeforeStep: true,
  verifyAfterStep: true,
  requireApproval: true,
};
