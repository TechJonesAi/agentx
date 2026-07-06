// ---------------------------------------------------------------------------
// P12-4 — Tool Forge: AgentX drafts, stores, and (after HUMAN approval)
// runs its own tools.
//
// Lifecycle:
//   draft    → the LLM (or the user) proposes a tool: name, description,
//              JSON-schema params, and a pure-compute JS function body.
//              Stored as status='pending'. NEVER executable in this state.
//   approve  → a human approves by name → status='approved' → registered
//              live into the ToolRegistry. Boot re-registers approved
//              tools automatically.
//   disable  → manual, or automatic after 3 consecutive runtime failures.
//              Unregistered immediately.
//
// SECURITY MODEL (v1 — deliberately narrow):
//   • Tools are PURE COMPUTE: the source is the body of `function(args)`
//     executed inside `node:vm` with an EMPTY sandbox — no require, no
//     process, no fs, no network, no timers. Math/JSON/String/etc. are
//     realm built-ins and available; nothing host-side is exposed.
//   • Defence-in-depth: a static deny-list rejects sources mentioning
//     require/import/process/eval/Function/fetch/… at DRAFT time, so a
//     malicious draft is refused before it is even stored.
//   • 1000 ms hard timeout per run; output capped at 8 KB.
//   • Every run is logged to custom_tool_runs with outcome + latency.
//
// This covers the "small local utilities" scope (deadline calculators,
// date math, text/number transforms). File / network / shell tools stay
// out of the forge — those belong to MCP servers with their own review.
// ---------------------------------------------------------------------------

import vm from 'node:vm';
import type BetterSqlite3 from 'better-sqlite3';
import { createLogger } from '../logger.js';
import type { Tool, ToolContext, ToolDefinition } from '../types.js';
import type { ToolRegistry } from './registry.js';

const log = createLogger('tools:forge');

export type CustomToolStatus = 'pending' | 'approved' | 'disabled';

export interface CustomToolRow {
  id: number;
  name: string;
  description: string;
  params_schema_json: string;
  source_code: string;
  status: CustomToolStatus;
  created_by: string;
  run_count: number;
  success_count: number;
  consecutive_failures: number;
  created_at: string;
  approved_at: string | null;
  disabled_reason: string | null;
}

export interface DraftToolInput {
  name: string;
  description: string;
  /** JSON-schema (object) for the tool's parameters. */
  paramsSchema: Record<string, unknown>;
  /** Body of `function(args) { ... }` — pure compute, must `return`. */
  sourceCode: string;
  createdBy?: string;
}

export interface DraftResult {
  ok: boolean;
  error?: string;
  name?: string;
}

const NAME_RX = /^[a-z][a-z0-9_]{2,40}$/;

/** Static deny-list — rejected at draft time, before storage. */
const FORBIDDEN_TOKENS = [
  'require', 'import', 'process', 'child_process', 'eval', 'Function(',
  'new Function', 'fetch', 'XMLHttpRequest', 'globalThis', 'constructor[',
  'constructor(', '__proto__', 'fs.', 'Deno', 'Bun', 'WebSocket',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
];

const MAX_SOURCE_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 8_192;
const RUN_TIMEOUT_MS = 1_000;
const AUTO_DISABLE_AFTER = 3;

export class ToolForge {
  constructor(
    private db: BetterSqlite3.Database,
    private registry: ToolRegistry,
  ) {
    this.ensureSchema();
  }

  private ensureSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS custom_tools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        params_schema_json TEXT NOT NULL,
        source_code TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_by TEXT NOT NULL DEFAULT 'agent',
        run_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        approved_at TEXT,
        disabled_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_custom_tools_status ON custom_tools(status);

      CREATE TABLE IF NOT EXISTS custom_tool_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tool_name TEXT NOT NULL,
        args_json TEXT,
        ok INTEGER NOT NULL,
        output_head TEXT,
        error TEXT,
        latency_ms INTEGER,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_custom_tool_runs_name ON custom_tool_runs(tool_name);
    `);
  }

  /* ── Draft ───────────────────────────────────────────────────────── */

  draftTool(input: DraftToolInput): DraftResult {
    try {
      const name = (input.name ?? '').trim();
      if (!NAME_RX.test(name)) {
        return { ok: false, error: 'invalid name: use lowercase letters, digits, underscores (3-41 chars, starts with a letter)' };
      }
      if (!input.description || input.description.trim().length < 10) {
        return { ok: false, error: 'description too short (min 10 chars)' };
      }
      const source = (input.sourceCode ?? '').trim();
      if (source.length === 0 || source.length > MAX_SOURCE_CHARS) {
        return { ok: false, error: `source must be 1..${MAX_SOURCE_CHARS} chars` };
      }
      for (const tok of FORBIDDEN_TOKENS) {
        if (source.includes(tok)) {
          return { ok: false, error: `forbidden token in source: ${tok}` };
        }
      }
      if (!/\breturn\b/.test(source)) {
        return { ok: false, error: 'source must return a value' };
      }
      // Syntax check inside the sandbox (compile only — never runs user args).
      try {
        new vm.Script(`(function(args){ ${source} })`);
      } catch (synErr) {
        return { ok: false, error: `syntax error: ${synErr instanceof Error ? synErr.message : String(synErr)}` };
      }
      let schemaJson: string;
      try {
        schemaJson = JSON.stringify(input.paramsSchema ?? { type: 'object', properties: {} });
      } catch {
        return { ok: false, error: 'paramsSchema is not serialisable' };
      }
      this.db
        .prepare(`
          INSERT INTO custom_tools (name, description, params_schema_json, source_code, status, created_by)
          VALUES (?, ?, ?, ?, 'pending', ?)
          ON CONFLICT(name) DO UPDATE SET
            description = excluded.description,
            params_schema_json = excluded.params_schema_json,
            source_code = excluded.source_code,
            status = 'pending',
            approved_at = NULL,
            disabled_reason = NULL,
            consecutive_failures = 0
        `)
        .run(name, input.description.trim(), schemaJson, source, input.createdBy ?? 'agent');
      // Re-drafting an approved tool demotes it to pending — unregister.
      try { this.registry.unregister(name); } catch { /* not registered */ }
      log.info({ name, createdBy: input.createdBy ?? 'agent' }, 'P12-4: tool drafted (pending approval)');
      return { ok: true, name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /* ── Approve / disable ───────────────────────────────────────────── */

  approveTool(name: string): { ok: boolean; error?: string } {
    const row = this.getTool(name);
    if (!row) return { ok: false, error: 'tool not found' };
    if (row.status === 'approved') return { ok: true };
    this.db
      .prepare(`UPDATE custom_tools SET status='approved', approved_at=CURRENT_TIMESTAMP, disabled_reason=NULL, consecutive_failures=0 WHERE name=?`)
      .run(name);
    const fresh = this.getTool(name)!;
    this.registry.register(this.buildRegistryTool(fresh));
    log.info({ name }, 'P12-4: tool APPROVED and registered live');
    return { ok: true };
  }

  disableTool(name: string, reason: string): { ok: boolean; error?: string } {
    const row = this.getTool(name);
    if (!row) return { ok: false, error: 'tool not found' };
    this.db
      .prepare(`UPDATE custom_tools SET status='disabled', disabled_reason=? WHERE name=?`)
      .run(reason.slice(0, 300), name);
    try { this.registry.unregister(name); } catch { /* */ }
    log.warn({ name, reason }, 'P12-4: tool disabled');
    return { ok: true };
  }

  /** Register every approved tool (called at agent boot). */
  loadApprovedTools(): number {
    try {
      const rows = this.db
        .prepare(`SELECT * FROM custom_tools WHERE status='approved'`)
        .all() as CustomToolRow[];
      for (const row of rows) {
        this.registry.register(this.buildRegistryTool(row));
      }
      if (rows.length > 0) {
        log.info({ count: rows.length, names: rows.map((r) => r.name) }, 'P12-4: approved custom tools registered at boot');
      }
      return rows.length;
    } catch (err) {
      log.warn({ err: err instanceof Error ? err.message : String(err) }, 'loadApprovedTools failed');
      return 0;
    }
  }

  /* ── Sandbox execution ───────────────────────────────────────────── */

  private buildRegistryTool(row: CustomToolRow): Tool {
    const definition: ToolDefinition = {
      name: row.name,
      description: `[custom] ${row.description}`,
      parameters: this.safeParseSchema(row.params_schema_json),
    };
    return {
      definition,
      execute: async (args: Record<string, unknown>, _context: ToolContext): Promise<string> => {
        return this.runSandboxed(row.name, args);
      },
    };
  }

  private safeParseSchema(json: string): Record<string, unknown> {
    try { return JSON.parse(json) as Record<string, unknown>; }
    catch { return { type: 'object', properties: {} }; }
  }

  /** Execute the named tool inside the empty vm sandbox. */
  runSandboxed(name: string, args: Record<string, unknown>): string {
    const row = this.getTool(name);
    if (!row) return `Error: custom tool '${name}' not found`;
    if (row.status !== 'approved') return `Error: custom tool '${name}' is ${row.status} — not executable`;

    const start = Date.now();
    let ok = false;
    let outputStr = '';
    let errorStr: string | null = null;
    try {
      // Clone args through JSON so no host-realm objects leak into the
      // sandbox (functions, prototypes, buffers are all stripped).
      const safeArgs = JSON.parse(JSON.stringify(args ?? {}));
      const sandbox = { args: safeArgs, result: undefined as unknown };
      const script = new vm.Script(`result = (function(args){ ${row.source_code} })(args)`);
      script.runInNewContext(sandbox, { timeout: RUN_TIMEOUT_MS });
      const value = sandbox.result;
      outputStr = typeof value === 'string' ? value : JSON.stringify(value);
      if (outputStr === undefined) outputStr = 'undefined';
      outputStr = String(outputStr).slice(0, MAX_OUTPUT_CHARS);
      ok = true;
    } catch (err) {
      errorStr = err instanceof Error ? err.message : String(err);
      outputStr = `Error: ${errorStr}`;
    }
    const latency = Date.now() - start;

    // Provenance + auto-disable
    try {
      this.db
        .prepare(`INSERT INTO custom_tool_runs (tool_name, args_json, ok, output_head, error, latency_ms) VALUES (?, ?, ?, ?, ?, ?)`)
        .run(name, JSON.stringify(args ?? {}).slice(0, 2000), ok ? 1 : 0, outputStr.slice(0, 300), errorStr, latency);
      if (ok) {
        this.db
          .prepare(`UPDATE custom_tools SET run_count=run_count+1, success_count=success_count+1, consecutive_failures=0 WHERE name=?`)
          .run(name);
      } else {
        this.db
          .prepare(`UPDATE custom_tools SET run_count=run_count+1, consecutive_failures=consecutive_failures+1 WHERE name=?`)
          .run(name);
        const fresh = this.getTool(name);
        if (fresh && fresh.consecutive_failures >= AUTO_DISABLE_AFTER) {
          this.disableTool(name, `auto-disabled after ${fresh.consecutive_failures} consecutive failures (last: ${errorStr ?? 'unknown'})`);
        }
      }
    } catch { /* provenance is best-effort */ }

    return outputStr;
  }

  /* ── Introspection ───────────────────────────────────────────────── */

  getTool(name: string): CustomToolRow | null {
    try {
      return (this.db.prepare('SELECT * FROM custom_tools WHERE name = ?').get(name) as CustomToolRow | undefined) ?? null;
    } catch { return null; }
  }

  listTools(status?: CustomToolStatus): CustomToolRow[] {
    try {
      if (status) {
        return this.db.prepare('SELECT * FROM custom_tools WHERE status = ? ORDER BY id DESC').all(status) as CustomToolRow[];
      }
      return this.db.prepare('SELECT * FROM custom_tools ORDER BY id DESC').all() as CustomToolRow[];
    } catch { return []; }
  }

  getStats(): { pending: number; approved: number; disabled: number; totalRuns: number } {
    try {
      const s = this.db
        .prepare(`
          SELECT
            SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) AS p,
            SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS a,
            SUM(CASE WHEN status='disabled' THEN 1 ELSE 0 END) AS d,
            COALESCE(SUM(run_count),0) AS r
          FROM custom_tools
        `)
        .get() as { p: number | null; a: number | null; d: number | null; r: number };
      return { pending: s.p ?? 0, approved: s.a ?? 0, disabled: s.d ?? 0, totalRuns: s.r };
    } catch {
      return { pending: 0, approved: 0, disabled: 0, totalRuns: 0 };
    }
  }
}

/* ── Built-in forge-facing tools (LLM can draft; humans approve) ────── */

/**
 * `forge_tool` — lets the MODEL propose a new tool mid-conversation.
 * The draft is stored pending; nothing becomes executable without the
 * human approval step. This is the "store new tools" capability with
 * the human firmly in the loop.
 */
export function buildForgeDraftTool(forge: ToolForge): Tool {
  return {
    definition: {
      name: 'forge_tool',
      description:
        'Draft a NEW custom utility tool (pure computation only — no file, network, or shell access). ' +
        'The draft is stored as PENDING and requires human approval before it can ever run. ' +
        'sourceCode is the body of `function(args){...}` and must return a value.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'snake_case tool name, e.g. deadline_calculator' },
          description: { type: 'string', description: 'what the tool does (min 10 chars)' },
          paramsSchema: { type: 'object', description: 'JSON schema for the tool arguments' },
          sourceCode: { type: 'string', description: 'body of function(args){...}; pure compute; must return' },
        },
        required: ['name', 'description', 'sourceCode'],
      },
    },
    execute: async (args) => {
      const r = forge.draftTool({
        name: String(args['name'] ?? ''),
        description: String(args['description'] ?? ''),
        paramsSchema: (args['paramsSchema'] as Record<string, unknown>) ?? { type: 'object', properties: {} },
        sourceCode: String(args['sourceCode'] ?? ''),
        createdBy: 'llm',
      });
      return r.ok
        ? `Tool '${r.name}' drafted and stored as PENDING. A human must approve it before it can run.`
        : `Draft rejected: ${r.error}`;
    },
  };
}

/** `list_custom_tools` — introspection for the model + user. */
export function buildForgeListTool(forge: ToolForge): Tool {
  return {
    definition: {
      name: 'list_custom_tools',
      description: 'List custom forged tools with their status (pending / approved / disabled) and run stats.',
      parameters: { type: 'object', properties: { status: { type: 'string', description: 'optional filter: pending | approved | disabled' } } },
    },
    execute: async (args) => {
      const status = args['status'] as CustomToolStatus | undefined;
      const rows = forge.listTools(status && ['pending', 'approved', 'disabled'].includes(status) ? status : undefined);
      if (rows.length === 0) return 'No custom tools.';
      return rows
        .map((r) => `${r.name} [${r.status}] — ${r.description.slice(0, 80)} (runs: ${r.run_count}, ok: ${r.success_count})`)
        .join('\n');
    },
  };
}
