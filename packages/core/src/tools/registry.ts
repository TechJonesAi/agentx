import type { Tool, ToolDefinition, ToolContext } from '../types.js';
import type { PermissionManager, PermissionType } from '../security/permissions.js';
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
};

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private permissionManager: PermissionManager | null = null;

  setPermissionManager(pm: PermissionManager): void {
    this.permissionManager = pm;
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

    log.debug({ name, args, skill: context.skillName }, 'Executing tool');

    try {
      const result = await tool.execute(args, context);
      log.debug({ name, resultLength: result.length }, 'Tool execution complete');
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error({ name, error: message }, 'Tool execution failed');
      throw error;
    }
  }

  list(): string[] {
    return Array.from(this.tools.keys());
  }

  clear(): void {
    this.tools.clear();
  }
}
