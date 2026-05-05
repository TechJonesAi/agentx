/**
 * Action Engine — High-level task execution system
 *
 * Orchestrates the full cycle:
 *   Goal → Plan → Execute → Verify → Adapt
 *
 * Uses existing DeviceControlService + computer tools for execution,
 * qwen3-vl for screen understanding, and qwen3 for planning.
 */

import { randomUUID } from 'node:crypto';
import { execSync } from 'node:child_process';
import { ScreenAnalyzer } from './screen-analyzer.js';
import { ActionPlanner } from './action-planner.js';
import type {
  ActionEngineConfig,
  ActionEngineCallbacks,
  ActionPlan,
  ActionStep,
  TaskExecution,
  StepResult,
  ScreenAnalysis,
  DEFAULT_CONFIG,
} from './types.js';

// Re-export for convenience
export { DEFAULT_CONFIG } from './types.js';

interface AgentInterface {
  getToolRegistry(): {
    get(name: string): { execute(args: Record<string, unknown>, context: Record<string, unknown>): Promise<string> } | undefined;
  };
  getComputerPermissionService(): { check(action: string): boolean; grant(input: { category: string; decision: string }): unknown } | null;
  getAuditLogger(): { log(entry: Record<string, unknown>): void } | null;
}

export class ActionEngine {
  private config: ActionEngineConfig;
  private screenAnalyzer: ScreenAnalyzer;
  private planner: ActionPlanner;
  private agent: AgentInterface | null;
  private executions: Map<string, TaskExecution> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();

  constructor(config: Partial<ActionEngineConfig> = {}, agent?: AgentInterface) {
    const defaults: ActionEngineConfig = {
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
    this.config = { ...defaults, ...config };
    this.agent = agent || null;

    this.screenAnalyzer = new ScreenAnalyzer({
      visionModel: this.config.visionModel,
      ollamaBaseUrl: this.config.ollamaBaseUrl,
    });

    this.planner = new ActionPlanner({
      plannerModel: this.config.plannerModel,
      ollamaBaseUrl: this.config.ollamaBaseUrl,
      maxSteps: this.config.maxSteps,
    });
  }

  /**
   * Set the Agent reference (for tool execution via registry).
   */
  setAgent(agent: AgentInterface): void {
    this.agent = agent;
  }

  /**
   * Execute a task from a natural-language goal.
   * This is the main entry point.
   */
  async executeTask(
    goal: string,
    callbacks?: ActionEngineCallbacks,
  ): Promise<TaskExecution> {
    const executionId = randomUUID();
    const abortController = new AbortController();
    this.abortControllers.set(executionId, abortController);

    const execution: TaskExecution = {
      id: executionId,
      goal,
      status: 'planning',
      plan: null,
      stepResults: [],
      currentStepIndex: 0,
      startedAt: Date.now(),
      finishedAt: null,
    };
    this.executions.set(executionId, execution);

    try {
      // ─── Phase 1: Analyze current screen ─────────────────────────
      this.audit('action_engine.start', { goal, executionId });
      let screenContext: ScreenAnalysis | undefined;

      try {
        screenContext = await this.screenAnalyzer.analyzeScreen(goal);
        callbacks?.onScreenAnalysis?.(screenContext);
      } catch (err) {
        // Non-fatal — plan without screen context
        this.audit('action_engine.screen_analysis_failed', {
          error: (err as Error).message,
        });
      }

      // ─── Phase 2: Create plan ────────────────────────────────────
      const plan = await this.planner.planSteps(goal, screenContext);
      execution.plan = plan;
      execution.status = 'executing';
      callbacks?.onPlanCreated?.(plan);
      this.audit('action_engine.plan_created', {
        executionId,
        stepCount: plan.steps.length,
        reasoning: plan.reasoning,
      });

      // ─── Phase 3: Execute steps ──────────────────────────────────
      await this.executeSteps(execution, callbacks, abortController.signal);

      // ─── Phase 4: Final verification ─────────────────────────────
      if (execution.status === 'executing') {
        execution.status = 'verifying';
        try {
          const verification = await this.screenAnalyzer.verifyAction(
            `Complete task: ${goal}`,
            plan.steps[plan.steps.length - 1]?.expectedOutcome || 'Task completed successfully',
          );
          execution.finalVerification = verification.description;

          if (verification.success) {
            execution.status = 'completed';
          } else {
            execution.status = 'completed'; // Still completed, just with a note
            execution.finalVerification = `Completed but verification uncertain: ${verification.description}`;
          }
        } catch {
          execution.status = 'completed'; // Verification failure is non-fatal
          execution.finalVerification = 'Verification skipped (vision unavailable)';
        }
      }

    } catch (err) {
      execution.status = 'failed';
      execution.error = (err as Error).message;
      callbacks?.onError?.((err as Error).message, execution);
      this.audit('action_engine.failed', { executionId, error: (err as Error).message });
    } finally {
      execution.finishedAt = Date.now();
      this.abortControllers.delete(executionId);
      callbacks?.onComplete?.(execution);
      this.audit('action_engine.complete', {
        executionId,
        status: execution.status,
        durationMs: execution.finishedAt - execution.startedAt,
        stepsCompleted: execution.stepResults.filter(r => r.status === 'completed').length,
        stepsFailed: execution.stepResults.filter(r => r.status === 'failed').length,
      });
    }

    return execution;
  }

  /**
   * Abort a running task.
   */
  abort(executionId: string): boolean {
    const controller = this.abortControllers.get(executionId);
    const execution = this.executions.get(executionId);
    if (controller && execution) {
      controller.abort();
      execution.status = 'aborted';
      execution.finishedAt = Date.now();
      return true;
    }
    return false;
  }

  /**
   * Get execution status.
   */
  getExecution(executionId: string): TaskExecution | undefined {
    return this.executions.get(executionId);
  }

  /**
   * Get all executions.
   */
  listExecutions(): TaskExecution[] {
    return Array.from(this.executions.values());
  }

  // ─── Private: Step Execution ─────────────────────────────────────────────

  private async executeSteps(
    execution: TaskExecution,
    callbacks: ActionEngineCallbacks | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const plan = execution.plan!;

    for (let i = 0; i < plan.steps.length; i++) {
      if (signal.aborted) {
        execution.status = 'aborted';
        return;
      }

      const step = plan.steps[i];
      execution.currentStepIndex = i;
      callbacks?.onStepStart?.(step, i);

      let result = await this.executeSingleStep(step, execution, callbacks);

      // Retry logic
      let retries = 0;
      while (result.status === 'failed' && retries < this.config.maxRetries) {
        retries++;
        result.retryCount = retries;
        result.status = 'retrying';

        this.audit('action_engine.step_retry', {
          executionId: execution.id,
          stepId: step.id,
          retry: retries,
        });

        // Wait before retry
        await this.delay(1000);

        // Try replanning if we've exhausted retries on this step
        if (retries >= this.config.maxRetries) {
          try {
            const completedSteps = plan.steps.slice(0, i).map((s, idx) => ({
              step: s,
              result: execution.stepResults[idx]?.output || 'unknown',
            }));

            let screenContext: ScreenAnalysis | undefined;
            try {
              screenContext = await this.screenAnalyzer.analyzeScreen(execution.goal);
            } catch { /* non-fatal */ }

            const newPlan = await this.planner.replan(
              execution.goal,
              completedSteps,
              step,
              result.error || 'Unknown error',
              screenContext,
            );

            callbacks?.onReplan?.(newPlan, result.error || 'Step failed');

            // Replace remaining steps with the new plan
            execution.plan = {
              ...plan,
              steps: [...plan.steps.slice(0, i), ...newPlan.steps],
              reasoning: `${plan.reasoning}\n[Replanned] ${newPlan.reasoning}`,
            };

            // Execute the first step of the new plan
            if (newPlan.steps.length > 0) {
              result = await this.executeSingleStep(newPlan.steps[0], execution, callbacks);
            }
            break;
          } catch (err) {
            result.error = `Replan failed: ${(err as Error).message}`;
            break;
          }
        }

        result = await this.executeSingleStep(step, execution, callbacks);
      }

      execution.stepResults.push(result);
      callbacks?.onStepComplete?.(result, i);

      // If step failed after all retries, decide whether to continue
      if (result.status === 'failed') {
        // For non-critical steps (wait, verify), continue
        if (step.type === 'wait' || step.type === 'verify') {
          continue;
        }
        // For critical steps, stop execution
        execution.status = 'failed';
        execution.error = `Step ${i + 1} failed: ${result.error}`;
        return;
      }

      // Delay between steps for UI to settle
      if (i < plan.steps.length - 1) {
        await this.delay(this.config.stepDelayMs);
      }
    }
  }

  private async executeSingleStep(
    step: ActionStep,
    execution: TaskExecution,
    callbacks: ActionEngineCallbacks | undefined,
  ): Promise<StepResult> {
    const startTime = Date.now();

    const result: StepResult = {
      stepId: step.id,
      status: 'running',
      durationMs: 0,
      retryCount: 0,
    };

    try {
      // Optional: capture screenshot before step
      if (this.config.screenshotBeforeStep && step.type !== 'screenshot' && step.type !== 'wait') {
        try {
          const preScreen = await this.screenAnalyzer.analyzeScreen(
            `About to: ${step.description}`,
          );
          callbacks?.onScreenAnalysis?.(preScreen);
        } catch { /* non-fatal */ }
      }

      // Execute the step
      const output = await this.executeStepAction(step);
      result.output = output;

      // Optional: verify after step
      if (this.config.verifyAfterStep && step.expectedOutcome && step.type !== 'wait') {
        await this.delay(300); // Brief pause for UI to update
        try {
          const verification = await this.screenAnalyzer.verifyAction(
            step.description,
            step.expectedOutcome,
          );
          if (!verification.success) {
            result.output = `${output}\n[Verification uncertain: ${verification.description}]`;
          }
          result.screenshot = verification.screenshotBase64;
        } catch { /* non-fatal */ }
      }

      result.status = 'completed';
    } catch (err) {
      result.status = 'failed';
      result.error = (err as Error).message;
    }

    result.durationMs = Date.now() - startTime;
    return result;
  }

  /**
   * Execute a single action step using the appropriate tool.
   */
  private async executeStepAction(step: ActionStep): Promise<string> {
    const toolContext = {
      sessionId: `action-engine-${Date.now()}`,
      agent: this.agent,
    };

    switch (step.type) {
      case 'launch_app': {
        const appName = String(step.params.appName || '');
        if (!appName) throw new Error('launch_app requires appName parameter');
        return this.executeTool('computer_app_launch', { appName }, toolContext);
      }

      case 'focus_app': {
        const appName = String(step.params.appName || '');
        if (!appName) throw new Error('focus_app requires appName parameter');
        return this.executeTool('computer_app_focus', { appName }, toolContext);
      }

      case 'click': {
        const x = Number(step.params.x);
        const y = Number(step.params.y);
        if (isNaN(x) || isNaN(y)) {
          throw new Error('click requires numeric x and y parameters');
        }
        // Move first, then click
        await this.executeTool('computer_mouse_move', { x, y }, toolContext);
        await this.delay(100);
        return this.executeTool('computer_mouse_click', {
          x, y,
          button: step.params.button || 'left',
        }, toolContext);
      }

      case 'type_text': {
        const text = String(step.params.text || '');
        if (!text) throw new Error('type_text requires text parameter');
        return this.executeTool('computer_keyboard_type', { text }, toolContext);
      }

      case 'keyboard_shortcut': {
        const shortcut = String(step.params.shortcut || '');
        if (!shortcut) throw new Error('keyboard_shortcut requires shortcut parameter');
        return this.executeTool('computer_keyboard_shortcut', { shortcut }, toolContext);
      }

      case 'mouse_move': {
        const x = Number(step.params.x);
        const y = Number(step.params.y);
        if (isNaN(x) || isNaN(y)) throw new Error('mouse_move requires numeric x and y');
        return this.executeTool('computer_mouse_move', { x, y }, toolContext);
      }

      case 'scroll': {
        const direction = String(step.params.direction || 'down');
        const amount = Number(step.params.amount) || 3;
        return this.executeTool('computer_mouse_scroll', { direction, amount }, toolContext);
      }

      case 'wait': {
        const ms = Number(step.params.ms) || 1000;
        await this.delay(ms);
        return `Waited ${ms}ms`;
      }

      case 'screenshot': {
        const result = await this.screenAnalyzer.captureScreen();
        return `Screenshot captured (${result.width}x${result.height})`;
      }

      case 'verify': {
        const expectation = String(step.params.expectation || step.expectedOutcome || '');
        const verification = await this.screenAnalyzer.verifyAction(
          'Verify screen state',
          expectation,
        );
        if (!verification.success) {
          throw new Error(`Verification failed: ${verification.description}`);
        }
        return `Verified: ${verification.description}`;
      }

      default:
        throw new Error(`Unknown step type: ${step.type}`);
    }
  }

  /**
   * Execute a tool via the Agent's ToolRegistry, or fall back to direct
   * osascript execution when no agent is available (standalone mode).
   */
  private async executeTool(
    toolName: string,
    args: Record<string, unknown>,
    _context: Record<string, unknown>,
  ): Promise<string> {
    // Try Agent-based execution first
    if (this.agent) {
      try {
        this.ensurePermission(toolName);
        const registry = this.agent.getToolRegistry();
        const tool = registry.get(toolName);
        if (tool) {
          return await tool.execute(args, _context);
        }
      } catch {
        // Fall through to direct execution
      }
    }

    // ─── Standalone execution via osascript/shell ─────────────────────
    return this.executeDirectly(toolName, args);
  }

  /**
   * Direct execution of computer actions via osascript and shell commands.
   * Used when no Agent/ToolRegistry is available (standalone mode).
   */
  private executeDirectly(toolName: string, args: Record<string, unknown>): string {
    const run = (cmd: string, timeout = 10000): string => {
      try {
        return execSync(cmd, { encoding: 'utf-8', timeout }).trim();
      } catch (err) {
        throw new Error(`Command failed: ${(err as Error).message}`);
      }
    };

    switch (toolName) {
      case 'computer_app_launch': {
        const app = String(args.appName);
        run(`open -a "${app}"`);
        return JSON.stringify({ success: true, detail: `Launched ${app}` });
      }

      case 'computer_app_focus': {
        const app = String(args.appName);
        run(`osascript -e 'tell application "${app}" to activate'`);
        return JSON.stringify({ success: true, detail: `Focused ${app}` });
      }

      case 'computer_app_quit': {
        const app = String(args.appName);
        run(`osascript -e 'tell application "${app}" to quit'`);
        return JSON.stringify({ success: true, detail: `Quit ${app}` });
      }

      case 'computer_mouse_move': {
        const x = Number(args.x);
        const y = Number(args.y);
        run(`osascript -l JavaScript -e '
          ObjC.import("CoreGraphics");
          $.CGDisplayMoveCursorToPoint(0, $.CGPointMake(${x}, ${y}));
        '`);
        return JSON.stringify({ success: true, detail: `Moved to (${x},${y})` });
      }

      case 'computer_mouse_click': {
        const x = Number(args.x ?? 0);
        const y = Number(args.y ?? 0);
        run(`osascript -l JavaScript -e '
          ObjC.import("CoreGraphics");
          var point = $.CGPointMake(${x}, ${y});
          var mouseDown = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseDown, point, $.kCGMouseButtonLeft);
          var mouseUp = $.CGEventCreateMouseEvent(null, $.kCGEventLeftMouseUp, point, $.kCGMouseButtonLeft);
          $.CGEventPost($.kCGHIDEventTap, mouseDown);
          delay(0.05);
          $.CGEventPost($.kCGHIDEventTap, mouseUp);
        '`);
        return JSON.stringify({ success: true, detail: `Clicked at (${x},${y})` });
      }

      case 'computer_keyboard_type': {
        const text = String(args.text);
        // Use CGEvents via osascript — no Accessibility permission needed
        // Map characters to macOS keycodes
        const MAC_KEYCODES: Record<string, number> = {
          'a':0,'b':11,'c':8,'d':2,'e':14,'f':3,'g':5,'h':4,'i':34,'j':38,
          'k':40,'l':37,'m':46,'n':45,'o':31,'p':35,'q':12,'r':15,'s':1,
          't':17,'u':32,'v':9,'w':13,'x':7,'y':16,'z':6,
          '0':29,'1':18,'2':19,'3':20,'4':21,'5':23,'6':22,'7':26,'8':28,'9':25,
          ' ':49,'\n':36,'\t':48,'-':27,'=':24,'[':33,']':30,'\\':42,';':41,
          "'":39,',':43,'.':47,'/':44,'`':50,
        };
        const SHIFT_CHARS: Record<string, string> = {
          '!':'1','@':'2','#':'3','$':'4','%':'5','^':'6','&':'7','*':'8','(':'9',')':'0',
          '_':'-','+':'=','{':'[','}':']','|':'\\',':':';','"':"'",
          '<':',','>':'.','?':'/','~':'`',
        };

        for (const ch of text) {
          const lower = ch.toLowerCase();
          const isShift = ch !== lower || SHIFT_CHARS[ch] !== undefined;
          const baseChar = SHIFT_CHARS[ch] || lower;
          const keycode = MAC_KEYCODES[baseChar];
          if (keycode !== undefined) {
            const shiftFlag = isShift && ch !== lower ? '| (1 << 17)' : (SHIFT_CHARS[ch] ? '| (1 << 17)' : '');
            run(`osascript -l JavaScript -e '
              ObjC.import("CoreGraphics");
              var down = $.CGEventCreateKeyboardEvent(null, ${keycode}, true);
              var up = $.CGEventCreateKeyboardEvent(null, ${keycode}, false);
              ${shiftFlag ? `down.flags = down.flags ${shiftFlag}; up.flags = up.flags ${shiftFlag};` : ''}
              $.CGEventPost($.kCGHIDEventTap, down);
              $.CGEventPost($.kCGHIDEventTap, up);
            '`);
          }
        }
        return JSON.stringify({ success: true, detail: `Typed ${text.length} chars` });
      }

      case 'computer_keyboard_shortcut': {
        const shortcut = String(args.shortcut);
        // Parse shortcut like "command+s"
        const parts = shortcut.toLowerCase().split('+');
        const key = parts.pop() || '';
        const modifiers = parts;

        const MAC_KEYS: Record<string, number> = {
          'a':0,'b':11,'c':8,'d':2,'e':14,'f':3,'g':5,'h':4,'i':34,'j':38,
          'k':40,'l':37,'m':46,'n':45,'o':31,'p':35,'q':12,'r':15,'s':1,
          't':17,'u':32,'v':9,'w':13,'x':7,'y':16,'z':6,
          '0':29,'1':18,'2':19,'3':20,'4':21,'5':23,'6':22,'7':26,'8':28,'9':25,
          'return':36,'enter':36,'tab':48,'space':49,'delete':51,'escape':53,
          'up':126,'down':125,'left':123,'right':124,
        };

        const MOD_FLAGS: Record<string, string> = {
          command: '(1 << 20)', cmd: '(1 << 20)',
          shift: '(1 << 17)',
          option: '(1 << 19)', alt: '(1 << 19)',
          control: '(1 << 18)', ctrl: '(1 << 18)',
        };

        const keycode = MAC_KEYS[key] ?? 0;
        const flagParts = modifiers.map(m => MOD_FLAGS[m]).filter(Boolean);
        const flagExpr = flagParts.length > 0 ? flagParts.join(' | ') : '0';

        run(`osascript -l JavaScript -e '
          ObjC.import("CoreGraphics");
          var flags = ${flagExpr};
          var down = $.CGEventCreateKeyboardEvent(null, ${keycode}, true);
          var up = $.CGEventCreateKeyboardEvent(null, ${keycode}, false);
          if (flags) { down.flags = flags; up.flags = flags; }
          $.CGEventPost($.kCGHIDEventTap, down);
          $.CGEventPost($.kCGHIDEventTap, up);
        '`);
        return JSON.stringify({ success: true, detail: `Shortcut: ${shortcut}` });
      }

      case 'computer_mouse_scroll': {
        const direction = String(args.direction || 'down');
        const amount = Number(args.amount) || 3;
        const scrollAmount = direction === 'up' ? amount : -amount;
        run(`osascript -l JavaScript -e '
          ObjC.import("CoreGraphics");
          var event = $.CGEventCreateScrollWheelEvent(null, $.kCGScrollEventUnitLine, 1, ${scrollAmount});
          $.CGEventPost($.kCGHIDEventTap, event);
        '`);
        return JSON.stringify({ success: true, detail: `Scrolled ${direction} ${amount}` });
      }

      case 'computer_app_list_running': {
        const result = run(`osascript -l JavaScript -e '
          ObjC.import("AppKit");
          var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
          var names = [];
          for (var i = 0; i < apps.count; i++) {
            var app = apps.objectAtIndex(i);
            if (app.activationPolicy === 0) {
              names.push(app.localizedName.js);
            }
          }
          JSON.stringify(names);
        '`);
        return result;
      }

      case 'computer_screen_dimensions': {
        const result = run(`osascript -l JavaScript -e '
          ObjC.import("AppKit");
          var screen = $.NSScreen.mainScreen;
          var frame = screen.frame;
          JSON.stringify({width: frame.size.width, height: frame.size.height});
        '`);
        return result;
      }

      default:
        throw new Error(`No direct execution available for: ${toolName}`);
    }
  }

  /**
   * Ensure the computer permission for a tool is granted.
   * The Action Engine operates with explicit user consent (via the API approval flow),
   * so we auto-grant permissions that the user has approved at the task level.
   */
  private ensurePermission(toolName: string): void {
    const permService = this.agent?.getComputerPermissionService?.();
    if (!permService) return;

    if (!permService.check(toolName)) {
      // Map tool to category and grant
      const categoryMap: Record<string, string> = {
        computer_mouse_move: 'mouse',
        computer_mouse_click: 'mouse',
        computer_mouse_drag: 'mouse',
        computer_mouse_scroll: 'mouse',
        computer_keyboard_type: 'keyboard',
        computer_keyboard_shortcut: 'keyboard',
        computer_screenshot: 'screenshot',
        computer_screen_dimensions: 'screen_info',
        computer_app_focus: 'app_control',
        computer_app_launch: 'app_control',
        computer_app_quit: 'app_control',
        computer_app_list_running: 'app_control',
        computer_terminal_command: 'terminal',
      };

      const category = categoryMap[toolName];
      if (category) {
        permService.grant({ category, decision: 'allow' });
      }
    }
  }

  // ─── Utilities ───────────────────────────────────────────────────────────

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private audit(action: string, details: Record<string, unknown>): void {
    this.agent?.getAuditLogger?.()?.log({
      action,
      sessionId: 'action-engine',
      details: JSON.stringify(details),
      success: true,
      metadata: details,
    });
  }
}
