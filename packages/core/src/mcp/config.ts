/**
 * MCP config loading + writing.
 *
 * Lives at `~/.agentx/mcp.json`. Format is a deliberate subset of the
 * Claude Desktop / Claude Code / Cursor config so the user's existing MCP
 * configs drop in unchanged. Extra fields AgentX adds (`enabled`, `safety`,
 * `toolAllowlist`) are ignored by other clients, so interop is preserved.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import type { MCPConfig, MCPServerConfig } from './types.js';

const log = createLogger('mcp:config');

/** File name we use inside the data dir. */
export const MCP_CONFIG_FILENAME = 'mcp.json';

/**
 * Default starter config — only the safe green-band servers, all DISABLED.
 *
 * Note on commands: Anthropic's official MCP servers are split across two
 * runtimes. Filesystem, Memory, Sequential Thinking and Everything are
 * published to npm (run via `npx`). Git, Time and Fetch are published only
 * as Python packages (run via `uvx`, which comes with uv / is available
 * through Homebrew). We default each entry to whichever command actually
 * resolves that package, so users don't hit "package not found" errors.
 */
export const DEFAULT_MCP_CONFIG: MCPConfig = {
  allowRemote: false,
  mcpServers: {
    // ALL DISABLED by default. The user opts in via the UI. This ships the
    // config skeleton so the starter set is discoverable without auto-
    // connecting anything.
    filesystem: {
      description: 'Scoped file read/write. Path allowlist is passed as trailing args — edit the args to include the directories you want exposed.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem'],
      enabled: false,
      safety: 'green',
    },
    memory: {
      description: 'Lightweight knowledge-graph store (complementary to AgentX memory).',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      enabled: false,
      safety: 'green',
    },
    'sequential-thinking': {
      description: 'Chain-of-thought reasoning scaffold. Pure computation, zero network.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      enabled: false,
      safety: 'green',
    },
    everything: {
      description: 'Reference/diagnostic server that exposes every MCP primitive. Useful for testing the plumbing.',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-everything'],
      enabled: false,
      safety: 'green',
    },
    time: {
      description: 'Timezone conversion utilities. Requires `uvx` (install via `brew install uv`).',
      command: 'uvx',
      args: ['mcp-server-time'],
      enabled: false,
      safety: 'green',
    },
    git: {
      description: 'Local git repo introspection. Pass --repository as an arg. Requires `uvx`.',
      command: 'uvx',
      args: ['mcp-server-git'],
      enabled: false,
      safety: 'green',
    },
  },
};

export interface LoadOptions {
  /**
   * Data dir (defaults to resolveDataDir()). Overridable for tests so they
   * can use a tmpdir without touching the real user config.
   */
  dataDir?: string;
  /** If true, write the default file when none exists. Default true. */
  createIfMissing?: boolean;
}

/** Load the mcp.json, creating the default if missing and requested. */
export function loadMCPConfig(dataDir: string, options: { createIfMissing?: boolean } = {}): MCPConfig {
  const createIfMissing = options.createIfMissing !== false;
  const configPath = path.join(dataDir, MCP_CONFIG_FILENAME);

  if (!fs.existsSync(configPath)) {
    if (createIfMissing) {
      try {
        if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify(DEFAULT_MCP_CONFIG, null, 2), 'utf-8');
        log.info({ configPath }, 'Created default mcp.json (all servers disabled)');
      } catch (err) {
        log.warn({ err: (err as Error).message }, 'Failed to create default mcp.json');
      }
    }
    return { ...DEFAULT_MCP_CONFIG };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<MCPConfig>;
    // Normalise: allow top-level arrays / bad shapes to degrade gracefully.
    const servers = (parsed.mcpServers && typeof parsed.mcpServers === 'object')
      ? parsed.mcpServers as Record<string, Omit<MCPServerConfig, 'name'>>
      : {};
    return {
      allowRemote: parsed.allowRemote === true,
      mcpServers: servers,
    };
  } catch (err) {
    log.warn({ err: (err as Error).message, configPath }, 'Failed to parse mcp.json — falling back to defaults');
    return { ...DEFAULT_MCP_CONFIG };
  }
}

/** Persist config atomically (tmp + rename). */
export function saveMCPConfig(dataDir: string, config: MCPConfig): void {
  const configPath = path.join(dataDir, MCP_CONFIG_FILENAME);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, configPath);
  log.info({ configPath }, 'MCP config saved');
}

/**
 * Validate a server config — returns list of problems (empty = OK). Used by
 * the API endpoints before accepting new configs from the UI.
 */
export function validateServerConfig(c: Partial<MCPServerConfig>): string[] {
  const errors: string[] = [];
  if (!c.command && !c.url) {
    errors.push('either `command` (stdio) or `url` (http) must be set');
  }
  const transport = c.transport ?? (c.url ? 'http' : 'stdio');
  if (transport === 'stdio' && !c.command) errors.push('stdio transport requires `command`');
  if (transport === 'http' && !c.url) errors.push('http transport requires `url`');
  if (transport === 'http' && c.url && !/^https?:\/\//.test(c.url)) {
    errors.push('http url must start with http:// or https://');
  }
  if (c.args && !Array.isArray(c.args)) errors.push('`args` must be an array of strings');
  if (c.env && typeof c.env !== 'object') errors.push('`env` must be an object');
  if (c.safety && !['green', 'yellow', 'red'].includes(c.safety)) {
    errors.push('`safety` must be "green", "yellow", or "red"');
  }
  return errors;
}
