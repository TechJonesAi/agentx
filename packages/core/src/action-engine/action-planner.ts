/**
 * Action Planner — Goal decomposition into executable steps
 *
 * Converts natural-language goals into structured ActionPlans
 * using an LLM. Supports initial planning and adaptive replanning
 * when steps fail.
 */

import type { ActionPlan, ActionStep, ActionStepType, ScreenAnalysis } from './types.js';

export interface ActionPlannerConfig {
  plannerModel: string;
  ollamaBaseUrl: string;
  maxSteps: number;
}

let stepCounter = 0;
function nextStepId(): string {
  return `step-${Date.now()}-${++stepCounter}`;
}

export class ActionPlanner {
  private config: ActionPlannerConfig;

  constructor(config: ActionPlannerConfig) {
    this.config = config;
  }

  /**
   * Create an action plan from a natural-language goal.
   */
  async planSteps(goal: string, screenContext?: ScreenAnalysis): Promise<ActionPlan> {
    const screenInfo = screenContext
      ? `\nCurrent screen state:\n- Active app: ${screenContext.activeApp || 'unknown'}\n- Window: ${screenContext.activeWindow || 'unknown'}\n- Description: ${screenContext.description}\n- Screen size: ${screenContext.dimensions.width}x${screenContext.dimensions.height}\n- Visible elements: ${screenContext.elements.map(e => `${e.type}:"${e.label}"`).join(', ') || 'none detected'}`
      : '\nNo screen context available — plan from scratch.';

    const systemPrompt = `You are a macOS desktop automation planner. You break down user goals into precise, executable steps.

Available action types:
- launch_app: Open an application. Params: { "appName": "TextEdit" }
- focus_app: Bring app to foreground. Params: { "appName": "TextEdit" }
- click: Click at coordinates or on a UI element. Params: { "x": 500, "y": 300 } or { "element": "Save button" }
- type_text: Type text via keyboard. Params: { "text": "Hello World" }
- keyboard_shortcut: Press a keyboard shortcut. Params: { "shortcut": "command+s" }
- mouse_move: Move mouse without clicking. Params: { "x": 500, "y": 300 }
- scroll: Scroll in a direction. Params: { "direction": "up"|"down", "amount": 3 }
- wait: Wait for UI to settle. Params: { "ms": 1000 }
- verify: Check screen state matches expectation. Params: { "expectation": "TextEdit window is open" }

Rules:
1. Always start by launching or focusing the target application
2. Add a "wait" step (1000-2000ms) after launching an app
3. Add a "verify" step after important actions
4. Use realistic macOS screen coordinates (typical display: 1440x900 or 2560x1440)
5. For text input, click the target field first, then type
6. Use keyboard shortcuts for save (command+s), copy (command+c), paste (command+v), etc.
7. Keep plans under ${this.config.maxSteps} steps
8. Each step must have a clear "expectedOutcome" describing what success looks like

Return ONLY valid JSON (no markdown fences):
{
  "goal": "the user's goal",
  "reasoning": "brief explanation of the approach",
  "estimatedDurationMs": number,
  "steps": [
    {
      "type": "action_type",
      "description": "human-readable step description",
      "params": { ... },
      "expectedOutcome": "what success looks like",
      "timeoutMs": 5000
    }
  ]
}`;

    const userPrompt = `Plan steps to accomplish this goal: "${goal}"${screenInfo}`;

    const response = await this.callLLM(systemPrompt, userPrompt);
    return this.parsePlan(response, goal);
  }

  /**
   * Replan after a step failure, incorporating what happened.
   */
  async replan(
    goal: string,
    completedSteps: { step: ActionStep; result: string }[],
    failedStep: ActionStep,
    error: string,
    screenContext?: ScreenAnalysis,
  ): Promise<ActionPlan> {
    const completedSummary = completedSteps
      .map((s, i) => `Step ${i + 1}: ${s.step.description} → ${s.result}`)
      .join('\n');

    const screenInfo = screenContext
      ? `\nCurrent screen: ${screenContext.description}\nActive app: ${screenContext.activeApp || 'unknown'}`
      : '';

    const systemPrompt = `You are a macOS desktop automation planner. A previous plan partially failed. Create a new plan to recover and complete the goal.

Available action types: launch_app, focus_app, click, type_text, keyboard_shortcut, mouse_move, scroll, wait, verify.

Return ONLY valid JSON with the same format as before.`;

    const userPrompt = `Goal: "${goal}"

Steps completed so far:
${completedSummary || 'None'}

Step that failed: ${failedStep.description}
Error: ${error}
${screenInfo}

Create a recovery plan to complete the original goal. Do NOT repeat already-completed steps unless needed for recovery.`;

    const response = await this.callLLM(systemPrompt, userPrompt);
    return this.parsePlan(response, goal);
  }

  /**
   * Call Ollama LLM for planning.
   */
  private async callLLM(systemPrompt: string, userPrompt: string): Promise<string> {
    const url = `${this.config.ollamaBaseUrl}/api/chat`;

    const body: Record<string, unknown> = {
      model: this.config.plannerModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      stream: false,
      think: false,  // Disable qwen3 thinking mode — we want direct JSON output
      options: {
        temperature: 0.3,
        num_predict: 4096,
      },
    };

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 90000);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Ollama planner request failed (${response.status})`);
      }

      const data = await response.json() as { message?: { content?: string; thinking?: string } };
      // Handle qwen3 thinking mode: content may be empty, actual response in thinking field
      const content = data.message?.content || '';
      const thinking = data.message?.thinking || '';
      return content || thinking;
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Parse LLM response into an ActionPlan.
   */
  private parsePlan(response: string, goal: string): ActionPlan {
    const json = this.extractJSON(response);

    try {
      const parsed = JSON.parse(json);

      const steps: ActionStep[] = (parsed.steps || []).map((s: Record<string, unknown>) => ({
        id: nextStepId(),
        type: this.validateStepType(String(s.type || 'wait')),
        description: String(s.description || ''),
        params: (s.params && typeof s.params === 'object') ? s.params as Record<string, unknown> : {},
        expectedOutcome: s.expectedOutcome ? String(s.expectedOutcome) : undefined,
        timeoutMs: typeof s.timeoutMs === 'number' ? s.timeoutMs : 5000,
      }));

      return {
        goal,
        steps: steps.slice(0, this.config.maxSteps),
        reasoning: String(parsed.reasoning || ''),
        estimatedDurationMs: typeof parsed.estimatedDurationMs === 'number'
          ? parsed.estimatedDurationMs
          : steps.length * 3000,
      };
    } catch (err) {
      throw new Error(`Failed to parse action plan: ${(err as Error).message}\nRaw response: ${response.substring(0, 500)}`);
    }
  }

  private validateStepType(type: string): ActionStepType {
    const valid: ActionStepType[] = [
      'launch_app', 'focus_app', 'click', 'type_text',
      'keyboard_shortcut', 'mouse_move', 'scroll', 'wait',
      'screenshot', 'verify',
    ];
    return valid.includes(type as ActionStepType) ? type as ActionStepType : 'wait';
  }

  private extractJSON(text: string): string {
    const trimmed = text.trim();
    if (trimmed.startsWith('{')) return trimmed;
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) return fenceMatch[1].trim();
    const objMatch = trimmed.match(/\{[\s\S]*\}/);
    if (objMatch) return objMatch[0];
    return trimmed;
  }
}
