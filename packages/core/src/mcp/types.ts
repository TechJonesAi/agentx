/**
 * MCP integration — local types.
 *
 * AgentX talks to external MCP servers (Anthropic's open protocol) so the
 * user can plug in pre-built tools without writing skills. Everything here
 * is CLIENT-side: AgentX is the client, each configured server is a
 * separate subprocess we speak JSON-RPC to over stdio.
 *
 * Privacy posture (enforced in MCPClientManager):
 *   - Transport: stdio by default. HTTPS/SSE is blocked unless
 *     `allowRemote: true` is set at the top of mcp.json AND the server
 *     has `transport: "http"` explicitly.
 *   - Per-server enable flag — nothing auto-connects.
 *   - Subprocess isolation — each server runs as its own child process
 *     with no access to AgentX's Keychain, memory DB, or config files.
 *   - No credential forwarding — AgentX never passes its own secrets
 *     to a server. Servers get only the env vars declared in their config.
 */

/** How we talk to the server. v1 only supports stdio; http is a future flag. */
export type MCPTransport = 'stdio' | 'http';

/** Safety classification — drives UI badge colour + whether confirmation required. */
export type MCPSafetyBand = 'green' | 'yellow' | 'red';

/** Configuration for a single MCP server, loaded from ~/.agentx/mcp.json. */
export interface MCPServerConfig {
  /** Stable identifier — used as the config key + in telemetry. */
  name: string;
  /** Human-readable one-liner shown in the dashboard. */
  description?: string;
  /** Transport. Defaults to stdio. HTTPS requires `allowRemote` at root. */
  transport?: MCPTransport;
  /** Command to spawn (stdio) — e.g. "npx", "docker", "python3". */
  command?: string;
  /** Arguments for the command. */
  args?: string[];
  /** Environment variables to pass to the server subprocess. */
  env?: Record<string, string>;
  /** URL for http transport (future). */
  url?: string;
  /** HTTP headers (future — typically auth). */
  headers?: Record<string, string>;
  /** Is this server enabled? Default false — must be explicitly turned on. */
  enabled?: boolean;
  /** Safety classification surfaced in the UI. Self-declared; UI validates. */
  safety?: MCPSafetyBand;
  /**
   * Optional per-tool allowlist. When set, only these tool names are exposed
   * to the agent even if the server advertises more. Lets you enable a server
   * but limit the blast radius.
   */
  toolAllowlist?: string[];
}

/** Top-level mcp.json shape. */
export interface MCPConfig {
  /** Declared servers, keyed by name. */
  mcpServers: Record<string, Omit<MCPServerConfig, 'name'>>;
  /**
   * Opt-in flag that unlocks HTTPS/SSE transports. Default false so
   * misconfiguration can't accidentally expose the agent to the network.
   */
  allowRemote?: boolean;
}

/** Runtime state of a connected server. */
export interface MCPServerStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  transport: MCPTransport;
  toolCount: number;
  /** When the current connection was established. */
  connectedAt?: number;
  /** Last error message if any. Null when healthy. */
  lastError?: string | null;
  safety: MCPSafetyBand;
}

/** A tool advertised by a connected server. */
export interface MCPDiscoveredTool {
  /** Server this tool belongs to. */
  serverName: string;
  /** Tool name as advertised by the server — used verbatim in JSON-RPC calls. */
  toolName: string;
  /** Tool description from the server. */
  description: string;
  /** JSON Schema for the tool's arguments. */
  inputSchema: Record<string, unknown>;
  /**
   * Qualified name AgentX uses internally: `mcp:<server>:<tool>`. Prevents
   * collisions between servers that happen to advertise the same tool name,
   * and makes every MCP-sourced tool easy to spot in audit logs / telemetry.
   */
  qualifiedName: string;
}

/** Errors thrown by MCP client code. */
export class MCPClientError extends Error {
  constructor(message: string, public readonly serverName?: string) {
    super(message);
    this.name = 'MCPClientError';
  }
}
