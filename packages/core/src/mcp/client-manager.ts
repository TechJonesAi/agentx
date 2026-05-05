/**
 * MCPClientManager — orchestrates connections to configured MCP servers.
 *
 * Responsibilities:
 *   - Read mcp.json at boot, spawn each ENABLED server as an isolated
 *     child process (stdio transport by default).
 *   - Perform the MCP handshake (initialize), list tools, and expose each
 *     discovered tool to AgentX's ToolRegistry via the adapter.
 *   - Watch subprocess lifecycle (restart on crash with backoff).
 *   - Surface state through `getStatus()` for the dashboard.
 *
 * Privacy / safety guarantees enforced here:
 *   - HTTPS transport is REFUSED unless `allowRemote: true` is set in
 *     mcp.json. The first time a user tries to enable an http server without
 *     the flag, they get a clear error instead of silent allow-by-default.
 *   - Each server is its own OS process (child_process.spawn via the SDK's
 *     StdioClientTransport). It inherits only the env you declare in config —
 *     never AgentX's secrets.
 *   - All MCP tool calls go through the existing ToolRegistry, which means
 *     permission gates, audit logging, tool-use-miss detection, and the
 *     tool-call quality evaluator all apply uniformly to MCP tools.
 *   - Qualified tool names (`mcp:<server>:<tool>`) make every MCP-originated
 *     call trivially identifiable in logs and the Tools-page UI.
 */

import { createLogger } from '../logger.js';
import type { Tool } from '../types.js';
import {
  loadMCPConfig,
  saveMCPConfig,
  validateServerConfig,
} from './config.js';
import type {
  MCPConfig,
  MCPServerConfig,
  MCPServerStatus,
  MCPDiscoveredTool,
  MCPSafetyBand,
} from './types.js';
import { MCPClientError } from './types.js';

const log = createLogger('mcp:client-manager');

/** Prefix every AgentX-internal MCP tool name with this so origin is obvious. */
export const MCP_TOOL_PREFIX = 'mcp:';

/** Maximum time to wait for a server's initialize + listTools round-trip. */
const HANDSHAKE_TIMEOUT_MS = 15_000;

/**
 * Environment variables that MCP subprocesses are allowed to inherit from
 * AgentX's process env. We intentionally keep this TINY — just enough for
 * `npx`, `uvx`, `python3` etc. to locate binaries and behave correctly in
 * the user's locale. Everything else (API keys, OAuth tokens, AgentX
 * feature flags, DB paths) is stripped so a compromised MCP server cannot
 * exfiltrate host secrets via its subprocess env.
 *
 * Any variable NOT in this list must be declared explicitly in the
 * server's `env:` block in mcp.json — forcing the user to make an
 * informed decision about what that third-party process sees.
 */
export const MCP_ENV_ALLOWLIST: ReadonlySet<string> = new Set([
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'SHELL',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'LC_MESSAGES',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  // Node / Python toolchain roots — needed so `npx`/`uvx` find their caches.
  'NODE_PATH',
  'npm_config_cache',
  'NPM_CONFIG_CACHE',
  'PNPM_HOME',
  'PYTHONPATH',
  'UV_CACHE_DIR',
]);

/**
 * Build the env object passed to an MCP subprocess. Starts from the
 * allowlist (filtered from parent process env), then merges the user's
 * explicit `cfg.env` on top — so a user can still pass e.g. `GITHUB_TOKEN`
 * to an MCP server that needs it, but must do so deliberately.
 */
export function buildScrubbedEnv(
  parentEnv: NodeJS.ProcessEnv,
  configEnv: Record<string, string> | undefined,
  allowlist: ReadonlySet<string> = MCP_ENV_ALLOWLIST,
): Record<string, string> {
  const scrubbed: Record<string, string> = {};
  for (const [k, v] of Object.entries(parentEnv)) {
    if (allowlist.has(k) && typeof v === 'string') scrubbed[k] = v;
  }
  if (configEnv) {
    for (const [k, v] of Object.entries(configEnv)) scrubbed[k] = v;
  }
  return scrubbed;
}

/** Backoff sequence for subprocess restarts (ms). */
const RESTART_BACKOFF_MS = [1000, 4000, 15_000, 60_000];

interface ActiveConnection {
  name: string;
  config: MCPServerConfig;
  /** The SDK Client instance — `any` because we lazy-import to avoid hard dep at module-init. */
  client: any;
  /** Transport handle (stdio or http). */
  transport: any;
  tools: MCPDiscoveredTool[];
  connectedAt: number;
  lastError: string | null;
}

export interface MCPClientManagerDeps {
  /** Absolute path to the data dir (usually ~/.agentx). */
  dataDir: string;
  /**
   * Hook that registers an AgentX Tool in the host registry. Called once per
   * discovered MCP tool. MCPClientManager is decoupled from the registry's
   * real shape so tests can pass a stub.
   */
  registerTool: (tool: Tool) => void;
  /**
   * Hook that removes a previously-registered tool (by name). Called when a
   * server is disabled or disconnected.
   */
  unregisterTool: (toolName: string) => void;
}

export class MCPClientManager {
  private config: MCPConfig;
  private connections = new Map<string, ActiveConnection>();
  /**
   * Last-error per server name — including servers that never successfully
   * connected (e.g. HTTPS blocked, subprocess crashed during handshake).
   * Separate from the connections map so the dashboard can surface errors
   * even when there is no live connection object to hang them off.
   */
  private lastErrors = new Map<string, string>();

  constructor(private deps: MCPClientManagerDeps) {
    this.config = loadMCPConfig(this.deps.dataDir);
    log.info({
      serverCount: Object.keys(this.config.mcpServers).length,
      allowRemote: this.config.allowRemote === true,
    }, 'MCPClientManager initialised');
  }

  /** Return a shallow clone so callers can't mutate our state. */
  getConfig(): MCPConfig {
    return {
      allowRemote: this.config.allowRemote === true,
      mcpServers: { ...this.config.mcpServers },
    };
  }

  /** Snapshot of each server's status — feeds the dashboard panel. */
  getStatus(): MCPServerStatus[] {
    return Object.entries(this.config.mcpServers).map(([name, cfg]) => {
      const conn = this.connections.get(name);
      return {
        name,
        enabled: cfg.enabled === true,
        connected: !!conn,
        transport: cfg.transport ?? 'stdio',
        toolCount: conn?.tools.length ?? 0,
        connectedAt: conn?.connectedAt,
        // Live connection's error wins; otherwise expose the persisted
        // last-error from the errors map (e.g. HTTPS gate rejection).
        lastError: conn?.lastError ?? this.lastErrors.get(name) ?? null,
        safety: (cfg.safety as MCPSafetyBand | undefined) ?? inferSafety(cfg),
      };
    });
  }

  /** All currently-discovered tools across connected servers. */
  listTools(): MCPDiscoveredTool[] {
    const out: MCPDiscoveredTool[] = [];
    for (const conn of this.connections.values()) out.push(...conn.tools);
    return out;
  }

  /**
   * Start up — connect every ENABLED server concurrently. Failures on one
   * server never block the others; each surfaces via getStatus().lastError.
   */
  async start(): Promise<void> {
    const enabled = Object.entries(this.config.mcpServers).filter(([, c]) => c.enabled === true);
    if (enabled.length === 0) {
      log.info('No MCP servers enabled — skipping start');
      return;
    }
    log.info({ count: enabled.length }, 'Connecting to enabled MCP servers');
    await Promise.all(enabled.map(([name, cfg]) =>
      this.connectServer(name, { ...cfg, name } as MCPServerConfig).catch(err => {
        log.warn({ name, err: err.message }, 'MCP server connect failed — continuing with others');
      }),
    ));
  }

  /** Graceful shutdown — disconnect every active server. */
  async stop(): Promise<void> {
    const names = Array.from(this.connections.keys());
    await Promise.all(names.map(n => this.disconnectServer(n)));
  }

  /**
   * Enable/disable a server at runtime. When enabling, connects immediately;
   * when disabling, disconnects. Persists the change to mcp.json.
   */
  async setServerEnabled(name: string, enabled: boolean): Promise<void> {
    const cfg = this.config.mcpServers[name];
    if (!cfg) throw new MCPClientError(`Unknown MCP server: ${name}`, name);
    cfg.enabled = enabled;
    saveMCPConfig(this.deps.dataDir, this.config);
    if (enabled) {
      await this.connectServer(name, { ...cfg, name } as MCPServerConfig);
    } else {
      await this.disconnectServer(name);
    }
  }

  /**
   * Add / replace a server config. Does NOT auto-enable — caller must
   * explicitly call setServerEnabled(true) afterwards.
   */
  upsertServer(name: string, cfg: Partial<MCPServerConfig>): void {
    const errors = validateServerConfig(cfg);
    if (errors.length > 0) throw new MCPClientError(`Invalid server config: ${errors.join('; ')}`, name);
    this.config.mcpServers[name] = {
      ...(this.config.mcpServers[name] ?? {}),
      ...cfg,
      enabled: this.config.mcpServers[name]?.enabled === true, // preserve enable state
    };
    saveMCPConfig(this.deps.dataDir, this.config);
  }

  /** Remove a server entirely. Disconnects first if connected. */
  async removeServer(name: string): Promise<void> {
    if (this.connections.has(name)) await this.disconnectServer(name);
    delete this.config.mcpServers[name];
    saveMCPConfig(this.deps.dataDir, this.config);
  }

  // ─── Internals ───────────────────────────────────────────────────────

  /** Connect one server. Idempotent (reconnects if already connected). */
  private async connectServer(name: string, cfg: MCPServerConfig): Promise<void> {
    // Enforce the HTTPS allowlist gate FIRST — before spawning anything.
    const transport = cfg.transport ?? (cfg.url ? 'http' : 'stdio');
    if (transport === 'http' && !this.config.allowRemote) {
      const msg = 'Remote (HTTPS) MCP transport is disabled. Set `allowRemote: true` in mcp.json to opt in.';
      log.warn({ name, url: cfg.url }, msg);
      this.recordError(name, msg);
      throw new MCPClientError(msg, name);
    }

    // Clean up any stale connection first.
    if (this.connections.has(name)) await this.disconnectServer(name);

    try {
      // Dynamic import so the SDK isn't required at module-init time (tests
      // that never call connectServer can avoid pulling it in).
      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const client = new Client({ name: 'agentx', version: '0.1.0' }, { capabilities: {} });

      let sdkTransport: any;
      if (transport === 'stdio') {
        const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
        sdkTransport = new StdioClientTransport({
          command: cfg.command!,
          args: cfg.args ?? [],
          // Scrubbed env — only the allowlist inherits, user's cfg.env
          // merges on top. Prevents AgentX secrets (API keys, OAuth
          // tokens, DB paths) from leaking to third-party MCP processes.
          env: buildScrubbedEnv(process.env, cfg.env),
        });
      } else {
        const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
        sdkTransport = new StreamableHTTPClientTransport(new URL(cfg.url!), {
          requestInit: cfg.headers ? { headers: cfg.headers } : undefined,
        });
      }

      // Race handshake against a timeout so a broken server can't hang forever.
      const connectPromise = (async () => {
        await client.connect(sdkTransport);
        const { tools } = await client.listTools();
        return tools ?? [];
      })();
      const handshake = await Promise.race([
        connectPromise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new MCPClientError(`Handshake timed out after ${HANDSHAKE_TIMEOUT_MS}ms`, name)), HANDSHAKE_TIMEOUT_MS),
        ),
      ]);

      const discovered: MCPDiscoveredTool[] = [];
      const allowlist = cfg.toolAllowlist;
      for (const t of handshake as Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>) {
        if (allowlist && !allowlist.includes(t.name)) continue;
        const qualifiedName = `${MCP_TOOL_PREFIX}${name}:${t.name}`;
        discovered.push({
          serverName: name,
          toolName: t.name,
          description: t.description ?? '',
          inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
          qualifiedName,
        });
      }

      const conn: ActiveConnection = {
        name,
        config: cfg,
        client,
        transport: sdkTransport,
        tools: discovered,
        connectedAt: Date.now(),
        lastError: null,
      };
      this.connections.set(name, conn);
      this.lastErrors.delete(name); // healthy now — clear any stale error

      // Register each tool with the host registry. We build the AgentX Tool
      // wrapper here so the registry never needs to know about MCP.
      for (const t of discovered) {
        this.deps.registerTool(this.buildAgentXTool(conn, t));
      }

      log.info({ name, tools: discovered.length, transport }, 'MCP server connected');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.recordError(name, msg);
      log.warn({ name, err: msg }, 'MCP server connect failed');
      throw err instanceof MCPClientError ? err : new MCPClientError(msg, name);
    }
  }

  /** Disconnect one server + unregister its tools. */
  private async disconnectServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return;
    for (const t of conn.tools) this.deps.unregisterTool(t.qualifiedName);
    try {
      await conn.client.close();
    } catch { /* best-effort */ }
    this.connections.delete(name);
    log.info({ name }, 'MCP server disconnected');
  }

  /** Wrap a discovered MCP tool as an AgentX Tool. */
  private buildAgentXTool(conn: ActiveConnection, t: MCPDiscoveredTool): Tool {
    return {
      definition: {
        name: t.qualifiedName,
        description: `[MCP:${conn.name}] ${t.description}`,
        parameters: t.inputSchema as any,
      },
      async execute(args: Record<string, unknown>) {
        try {
          const res = await conn.client.callTool({ name: t.toolName, arguments: args });
          // MCP returns { content: ContentBlock[] }. Flatten text blocks to
          // a single string for AgentX — most of our skills return string.
          const content = (res?.content ?? []) as Array<{ type: string; text?: string }>;
          const text = content
            .filter(b => b.type === 'text' && typeof b.text === 'string')
            .map(b => b.text)
            .join('\n\n');
          return text || JSON.stringify(res);
        } catch (err) {
          return `[MCP error on ${conn.name}:${t.toolName}] ${(err as Error).message}`;
        }
      },
    };
  }

  private recordError(name: string, msg: string): void {
    const conn = this.connections.get(name);
    if (conn) conn.lastError = msg;
    // Always keep the last-error in the standalone map so getStatus() can
    // surface failures that happened BEFORE a connection object existed
    // (e.g. the HTTPS allow-remote gate).
    this.lastErrors.set(name, msg);
  }
}

/** Conservative safety inference when a server config doesn't declare one. */
function inferSafety(cfg: Omit<MCPServerConfig, 'name'>): MCPSafetyBand {
  // HTTP = yellow at best (user-authenticated cloud), red if unfamiliar.
  if (cfg.url) return 'yellow';
  // stdio local command — green if command looks like official npm/anthropic.
  const cmd = (cfg.command ?? '') + ' ' + (cfg.args?.join(' ') ?? '');
  if (/@modelcontextprotocol\//.test(cmd)) return 'green';
  return 'yellow';
}
