import type { Tool } from '../types.js';
import { ShellSandbox } from '../security/sandbox.js';

// ─── Shell Tool (sandboxed) ──────────────────────────────────────────────────

export const shellTool: Tool = {
  definition: {
    name: 'shell',
    description: 'Execute a shell command and return the output. Subject to security sandbox restrictions.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        workingDir: {
          type: 'string',
          description: 'Optional working directory for the command',
        },
      },
      required: ['command'],
    },
  },
  async execute(args, context) {
    const command = args['command'] as string;
    const workingDir = args['workingDir'] as string | undefined;
    const config = context.agent.getConfig();

    // Get confirm callback from agent (wired by CLI or integration)
    const confirmCallback = 'getShellConfirmCallback' in context.agent
      ? (context.agent as { getShellConfirmCallback(): ((cmd: string) => Promise<boolean>) | null }).getShellConfirmCallback()
      : undefined;

    const sandbox = new ShellSandbox({
      permissionLevel: config.security.shellPermissionLevel,
      maxTimeout: config.security.maxShellTimeout,
      confirmCallback: confirmCallback ?? undefined,
    });

    const result = await sandbox.execute(command, workingDir);

    if (!result.allowed) {
      return `[Blocked]: ${result.reason}`;
    }

    let output = result.stdout;
    if (result.stderr) {
      output += `\n[stderr]: ${result.stderr}`;
    }
    if (result.exitCode !== 0) {
      output += `\n[exit code]: ${result.exitCode}`;
    }
    if (result.error) {
      output += `\n[error]: ${result.error}`;
    }

    return output || '[No output]';
  },
};

// ─── Memory Tools ────────────────────────────────────────────────────────────

export const memoryStoreTool: Tool = {
  definition: {
    name: 'memory_store',
    description: 'Store information in long-term memory for later retrieval',
    parameters: {
      type: 'object',
      properties: {
        content: {
          type: 'string',
          description: 'The content to remember',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to categorize this memory',
        },
      },
      required: ['content'],
    },
  },
  async execute(args) {
    return JSON.stringify({ action: 'store', content: args['content'], tags: args['tags'] ?? [] });
  },
};

export const memorySearchTool: Tool = {
  definition: {
    name: 'memory_search',
    description: 'Search long-term memory for previously stored information',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by tags',
        },
      },
      required: ['query'],
    },
  },
  async execute(args) {
    return JSON.stringify({ action: 'search', query: args['query'], tags: args['tags'] ?? [] });
  },
};

export const currentTimeTool: Tool = {
  definition: {
    name: 'current_time',
    description: 'Get the current date and time',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async execute() {
    return new Date().toISOString();
  },
};

export function getBuiltinTools(): Tool[] {
  return [shellTool, memoryStoreTool, memorySearchTool, currentTimeTool];
}
