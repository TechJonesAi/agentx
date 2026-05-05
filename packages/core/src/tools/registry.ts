import type { Tool, ToolDefinition, ToolContext } from '../types.js';
import type { PermissionManager, PermissionType } from '../security/permissions.js';
import type { HooksEngine } from '../security/hooks-engine.js';
import { createLogger } from '../logger.js';

const log = createLogger('tools:registry');

// Maps tool names to the permission required to invoke them
const TOOL_PERMISSION_MAP: Record<string, PermissionType> = {
  shell: 'shell',
  browser_navigate: 'browser',
  browser_click: 'browser',
  browser_fill: 'browser',
  browser_screenshot: 'browser',
  browser_extract: 'browser',
  memory_store: 'memory.write',
  memory_search: 'memory.read',
  web_search: 'network',
  cognitive_query: 'memory.read',
  // Computer control tools require 'browser' permission (closest fit)
  computer_mouse_move: 'browser',
  computer_mouse_click: 'browser',
  computer_mouse_drag: 'browser',
  computer_mouse_scroll: 'browser',
  computer_keyboard_type: 'browser',
  computer_keyboard_shortcut: 'browser',
  computer_screenshot: 'browser',
  computer_screen_dimensions: 'browser',
  computer_app_focus: 'browser',
  computer_app_launch: 'browser',
  computer_app_quit: 'browser',
  computer_app_list_running: 'browser',
  computer_terminal_command: 'shell',
  save_file: 'memory.write',
  extract_image_text: 'memory.read',
};

export { TOOL_PERMISSION_MAP };

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private disabledTools = new Set<string>();
  private permissionManager: PermissionManager | null = null;
  private hooksEngine: HooksEngine | null = null;

  setPermissionManager(pm: PermissionManager): void {
    this.permissionManager = pm;
  }

  /**
   * Attach a HooksEngine. When present, every tool call gains a
   * `before_tool` pre-exec evaluation (can deny) and an `after_tool`
   * post-exec evaluation (audit/log only). When null, behaviour is
   * identical to today — zero overhead, zero behaviour change.
   */
  setHooksEngine(engine: HooksEngine | null): void {
    this.hooksEngine = engine;
  }

  getHooksEngine(): HooksEngine | null {
    return this.hooksEngine;
  }

  register(tool: Tool): void {
    if (this.tools.has(tool.definition.name)) {
      log.warn({ name: tool.definition.name }, 'Overwriting existing tool');
    }
    this.tools.set(tool.definition.name, tool);
    log.info({ name: tool.definition.name }, 'Tool registered');
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getDefinitions(): ToolDefinition[] {
    return Array.from(this.tools.values()).map((t) => t.definition);
  }

  /**
   * Get tool definitions filtered by what a skill is allowed to use.
   */
  getDefinitionsForSkill(skillName: string): ToolDefinition[] {
    if (!this.permissionManager) return this.getDefinitions();

    return Array.from(this.tools.values())
      .filter((t) => {
        const requiredPerm = TOOL_PERMISSION_MAP[t.definition.name];
        if (!requiredPerm) return true; // No permission required for this tool
        return this.permissionManager!.hasPermission(skillName, requiredPerm);
      })
      .map((t) => t.definition);
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<string> {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new Error(`Unknown tool: ${name}`);
    }

    // Permission enforcement: if the call comes from a skill, check permissions
    if (context.skillName && this.permissionManager) {
      const requiredPerm = TOOL_PERMISSION_MAP[name];
      if (requiredPerm && !this.permissionManager.hasPermission(context.skillName, requiredPerm)) {
        const msg = `Skill '${context.skillName}' lacks '${requiredPerm}' permission to use tool '${name}'`;
        log.warn({ skill: context.skillName, tool: name, requiredPerm }, 'Permission denied');
        return `[Permission Denied]: ${msg}`;
      }
    }

    // Declarative hook evaluation — pre-execution. Runs ALONGSIDE the
    // permission check above, never in place of it. A hook can only ADD
    // denials (defence in depth). Absent/empty policy → no-op.
    if (this.hooksEngine && this.hooksEngine.hasRules()) {
      try {
        const decision = this.hooksEngine.evaluate('before_tool', { tool: name, args });
        if (decision.firings.length > 0) {
          log.info({ tool: name, firings: decision.firings }, 'Pre-tool hook firings');
        }
        if (decision.denied) {
          log.warn({ tool: name, reason: decision.denyReason }, 'Tool call denied by hooks policy');
          return `[Policy Denied]: ${decision.denyReason ?? 'Blocked by hooks policy'}`;
        }
      } catch (err) {
        // Hook evaluation itself blew up — fail open so a broken policy
        // file cannot wedge tool use.
        log.warn({ err: (err as Error).message, tool: name }, 'Hooks evaluation error (before_tool) — proceeding without hook');
      }
    }

    log.debug({ name, args, skill: context.skillName }, 'Executing tool');

    try {
      const result = await tool.execute(args, context);
      log.debug({ name, resultLength: result.length }, 'Tool execution complete');

      // Post-execution hook evaluation — audit / log only. A deny here
      // cannot unwind the tool call (already executed), but it IS logged
      // so downstream systems can react.
      if (this.hooksEngine && this.hooksEngine.hasRules()) {
        try {
          const decision = this.hooksEngine.evaluate('after_tool', { tool: name, args, result });
          if (decision.firings.length > 0) {
            log.info({ tool: name, firings: decision.firings }, 'Post-tool hook firings');
          }
        } catch (err) {
          log.warn({ err: (err as Error).message, tool: name }, 'Hooks evaluation error (after_tool) — ignored');
        }
      }

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ name, error: message }, 'Tool execution failed');
      throw error;
    }
  }

  isEnabled(name: string): boolean {
    return this.tools.has(name) && !this.disabledTools.has(name);
  }

  enable(name: string): void {
    this.disabledTools.delete(name);
    log.info({ name }, 'Tool enabled');
  }

  disable(name: string): void {
    this.disabledTools.add(name);
    log.info({ name }, 'Tool disabled');
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  clear(): void {
    this.tools.clear();
    this.disabledTools.clear();
  }
}
