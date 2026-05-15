import type { Tool } from '../types.js';
import { ShellSandbox } from '../security/sandbox.js';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// ─── Write File Tool ─────────────────────────────────────────────────────────
// Dedicated tool for writing file contents without shell-escaping pitfalls.
// Constrained to the AGENTX_APPS workspace and a small set of safe roots.

const WRITE_FILE_ALLOWED_ROOTS = [
  '/Users/darrenjones/Projects/AGENTX_APPS',
  '/tmp',
  '/var/folders',
];

function isPathAllowed(absPath: string): boolean {
  const resolved = resolve(absPath);
  return WRITE_FILE_ALLOWED_ROOTS.some((root) =>
    resolved === root || resolved.startsWith(root + '/'),
  );
}

export const writeFileTool: Tool = {
  definition: {
    name: 'write_file',
    description:
      'Write a file to disk with full content. Use this for any file >50 bytes ' +
      '(HTML/CSS/JS/JSON/MD) instead of `echo > file`. Creates parent directories ' +
      'automatically. Restricted to /Users/darrenjones/Projects/AGENTX_APPS/, /tmp, ' +
      'and /var/folders. Returns the byte count on success.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute file path. MUST start with /Users/darrenjones/Projects/AGENTX_APPS/ ' +
            'for app builds. Parent directories are created automatically.',
        },
        content: {
          type: 'string',
          description:
            'Full file content as a UTF-8 string. No shell escaping needed — pass ' +
            'the raw HTML/CSS/JS/text exactly as it should appear in the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  async execute(args) {
    const filePath = args['path'] as string;
    const content = args['content'] as string;

    if (!filePath || typeof filePath !== 'string') {
      return '[write_file error]: path is required and must be a string';
    }
    if (typeof content !== 'string') {
      return '[write_file error]: content is required and must be a string';
    }
    if (!filePath.startsWith('/')) {
      return `[write_file error]: path must be absolute, got: ${filePath}`;
    }
    if (!isPathAllowed(filePath)) {
      return `[write_file error]: path '${filePath}' is outside allowed roots ` +
        `(${WRITE_FILE_ALLOWED_ROOTS.join(', ')})`;
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      const st = await stat(filePath);
      return `[write_file ok]: wrote ${st.size} bytes to ${filePath}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `[write_file error]: ${msg}`;
    }
  },
};

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
  return [shellTool, writeFileTool, memoryStoreTool, memorySearchTool, currentTimeTool];
}
