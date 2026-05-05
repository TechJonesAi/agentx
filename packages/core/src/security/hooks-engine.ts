/**
 * HooksEngine — declarative pre/post tool-call policies.
 *
 * Lets you express safety rules as data instead of code, e.g.
 *
 *   rules:
 *     - name: block path traversal
 *       on: before_tool
 *       match: { tool: "save_file" }
 *       when: 'args.filename.includes("..")'
 *       action: deny
 *
 *     - name: confirm dangerous shell
 *       on: before_tool
 *       match: { tool: "shell" }
 *       when: '/\brm -rf\b/.test(args.command)'
 *       action: warn
 *
 *     - name: audit MCP calls
 *       on: after_tool
 *       match: { tool: "mcp:*" }
 *       action: log
 *
 * DESIGN:
 *   - NO BYPASS of existing security checks. Hooks run ALONGSIDE the current
 *     permission managers, shell sandbox, device-control gates, etc. They
 *     can only ADD denials — never loosen. Defence in depth.
 *   - LOCAL + PRIVATE. Policies live in `~/.agentx/policies.yaml` or
 *     `policies.json`. Rule evaluation is pure JS; no network, no LLM.
 *   - FAIL-OPEN SYNTACTICALLY / FAIL-CLOSED SEMANTICALLY. A rule that
 *     crashes during evaluation is logged and SKIPPED, so a broken rule
 *     doesn't brick tool use. But an explicit `action: deny` is enforced
 *     strictly: the tool does not execute.
 *   - OFF BY DEFAULT. Empty policy file = zero behavioural change from
 *     today. Rules are purely opt-in.
 *
 * `when` expressions are evaluated in a restricted sandbox: they get
 * `args` (the tool arguments object), `tool` (tool name), and a small set
 * of helpers. No `require`, no `eval`, no file system access. We use the
 * Function constructor with a minimal scope.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('security:hooks');

/** When the rule fires during a tool call. */
export type HookPhase = 'before_tool' | 'after_tool';

/** What happens when the rule matches. */
export type HookAction = 'allow' | 'deny' | 'log' | 'warn';

/** A single declarative rule. */
export interface HookRule {
  /** Human name for logging. */
  name: string;
  /** `before_tool` fires pre-execution; `after_tool` fires post-execution. */
  on: HookPhase;
  /** Matcher — currently just tool name with optional wildcard suffix. */
  match: { tool: string };
  /** Optional JS expression evaluated with {args, tool, result?} in scope. */
  when?: string;
  /** Resulting action when matched + `when` is truthy. */
  action: HookAction;
  /** Optional explanation shown in denial / warning messages. */
  reason?: string;
  /** Set to true to temporarily disable the rule without deleting it. */
  disabled?: boolean;
}

export interface HooksPolicy {
  /** Rules evaluated in declaration order. */
  rules: HookRule[];
}

export interface HookContext {
  tool: string;
  args: Record<string, unknown>;
  /** Present only on after_tool — the raw string returned by the tool. */
  result?: string;
}

export interface HookDecision {
  /** Was at least one rule matched during this phase? */
  matched: boolean;
  /** All rules that matched + what they did. */
  firings: Array<{ rule: string; action: HookAction; reason?: string }>;
  /** True when ANY matched rule action was `deny`. */
  denied: boolean;
  /** Reason string from the denying rule (first deny wins). */
  denyReason?: string;
}

/** Where we look for the policy file. First found wins. */
const POLICY_FILENAMES = ['policies.yaml', 'policies.yml', 'policies.json'];

export class HooksEngine {
  private policy: HooksPolicy = { rules: [] };
  private policyPath: string | null = null;
  private lastLoadError: string | null = null;

  /**
   * Construct from a dataDir. The engine auto-loads whichever policy file
   * exists at that path. Absent / empty files → empty ruleset (no-op).
   */
  constructor(dataDir: string | null) {
    if (!dataDir) return;
    this.policyPath = this.resolvePolicyPath(dataDir);
    this.reload();
  }

  /** Re-read the policy file from disk. Safe to call at runtime. */
  reload(): void {
    if (!this.policyPath || !fs.existsSync(this.policyPath)) {
      this.policy = { rules: [] };
      return;
    }
    try {
      const raw = fs.readFileSync(this.policyPath, 'utf-8');
      this.policy = this.parsePolicy(raw, this.policyPath);
      this.lastLoadError = null;
      log.info({ ruleCount: this.policy.rules.length, path: this.policyPath }, 'Hooks policy loaded');
    } catch (err) {
      this.lastLoadError = (err as Error).message;
      log.warn({ err: this.lastLoadError, path: this.policyPath }, 'Hooks policy load failed — falling back to empty ruleset');
      this.policy = { rules: [] };
    }
  }

  /** Return a copy of the current rule list for UI display. */
  listRules(): HookRule[] {
    return this.policy.rules.map(r => ({ ...r }));
  }

  /** Last load error or null when policy loaded cleanly. */
  getLastLoadError(): string | null {
    return this.lastLoadError;
  }

  /** True when at least one non-disabled rule exists — cheap check for callers. */
  hasRules(): boolean {
    return this.policy.rules.some(r => !r.disabled);
  }

  /**
   * Evaluate all rules for a given phase. Returns the aggregate decision —
   * the caller handles the `denied` case (skipping tool execution) and the
   * `firings` list (logging + audit).
   */
  evaluate(phase: HookPhase, ctx: HookContext): HookDecision {
    const decision: HookDecision = { matched: false, firings: [], denied: false };
    for (const rule of this.policy.rules) {
      if (rule.disabled) continue;
      if (rule.on !== phase) continue;
      if (!this.matchTool(rule.match.tool, ctx.tool)) continue;

      let matched: boolean;
      if (rule.when) {
        matched = this.evaluateWhen(rule.when, ctx);
      } else {
        matched = true;
      }
      if (!matched) continue;

      decision.matched = true;
      decision.firings.push({ rule: rule.name, action: rule.action, reason: rule.reason });
      if (rule.action === 'deny' && !decision.denied) {
        decision.denied = true;
        decision.denyReason = rule.reason ?? `Blocked by policy: ${rule.name}`;
      }
    }
    return decision;
  }

  // ─── Internals ───────────────────────────────────────────────────────

  private resolvePolicyPath(dataDir: string): string {
    for (const fname of POLICY_FILENAMES) {
      const p = path.join(dataDir, fname);
      if (fs.existsSync(p)) return p;
    }
    // Default: json file, may not exist yet.
    return path.join(dataDir, 'policies.json');
  }

  private parsePolicy(raw: string, filePath: string): HooksPolicy {
    // JSON path is easy.
    if (filePath.endsWith('.json')) {
      const data = JSON.parse(raw);
      return this.normalizePolicy(data);
    }
    // YAML path — use the same minimal YAML parser the rest of AgentX uses
    // (see config.ts). To avoid pulling a new dep we only support a subset:
    // top-level `rules:` list, hyphen-indented dicts, scalar values.
    return this.normalizePolicy(this.parseSimpleYaml(raw));
  }

  /**
   * Tiny YAML-subset parser. Sufficient for a flat list of objects with
   * scalar/quoted-string/boolean leaves. Anything fancier → user should use
   * JSON.
   */
  private parseSimpleYaml(text: string): any {
    const out: any = {};
    const lines = text.split(/\r?\n/);
    let currentList: any[] | null = null;
    let currentObj: any = null;
    const push = (obj: any) => { if (currentList) currentList.push(obj); };
    for (let rawLine of lines) {
      const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
      if (!line.trim()) continue;

      // Top-level `rules:` opens a list.
      const topListMatch = /^([a-zA-Z_][\w-]*):\s*$/.exec(line);
      if (topListMatch && line[0] !== ' ') {
        out[topListMatch[1]] = [];
        currentList = out[topListMatch[1]];
        currentObj = null;
        continue;
      }

      // `- key: value` or `- key:` starts a new object in the current list.
      const newItemMatch = /^- ([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line.trim().startsWith('- ') ? line.trim() : '');
      if (newItemMatch) {
        currentObj = {};
        push(currentObj);
        this.assignYamlValue(currentObj, newItemMatch[1], newItemMatch[2]);
        continue;
      }

      // Continuation line `    key: value` on the current object.
      const keyValMatch = /^\s+([a-zA-Z_][\w-]*):\s*(.*)$/.exec(line);
      if (keyValMatch && currentObj) {
        this.assignYamlValue(currentObj, keyValMatch[1], keyValMatch[2]);
        continue;
      }
    }
    return out;
  }

  private assignYamlValue(obj: any, key: string, rawValue: string) {
    const v = rawValue.trim();
    if (v === '') { obj[key] = {}; return; }
    if (v === 'true') { obj[key] = true; return; }
    if (v === 'false') { obj[key] = false; return; }
    if (/^-?\d+(?:\.\d+)?$/.test(v)) { obj[key] = Number(v); return; }
    // Strip surrounding quotes if present.
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      obj[key] = v.slice(1, -1);
      return;
    }
    // Inline map `{tool: save_file}` — a tiny subset.
    if (v.startsWith('{') && v.endsWith('}')) {
      const inner: any = {};
      for (const part of v.slice(1, -1).split(',')) {
        const [kk, vv] = part.split(':').map(s => s.trim());
        if (kk) inner[kk] = this.coerceScalar(vv);
      }
      obj[key] = inner;
      return;
    }
    obj[key] = v;
  }

  private coerceScalar(raw: string | undefined): unknown {
    if (raw === undefined) return undefined;
    const v = raw.trim();
    if (v === 'true') return true;
    if (v === 'false') return false;
    if (/^-?\d+(?:\.\d+)?$/.test(v)) return Number(v);
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      return v.slice(1, -1);
    }
    return v;
  }

  private normalizePolicy(data: any): HooksPolicy {
    if (!data || typeof data !== 'object') return { rules: [] };
    const raw = Array.isArray(data.rules) ? data.rules : [];
    const rules: HookRule[] = [];
    for (const r of raw) {
      if (!r || typeof r !== 'object') continue;
      if (typeof r.name !== 'string' || !r.name) continue;
      if (r.on !== 'before_tool' && r.on !== 'after_tool') continue;
      if (!r.match || typeof r.match.tool !== 'string') continue;
      if (!['allow', 'deny', 'log', 'warn'].includes(r.action)) continue;
      rules.push({
        name: r.name,
        on: r.on,
        match: { tool: r.match.tool },
        when: typeof r.when === 'string' ? r.when : undefined,
        action: r.action,
        reason: typeof r.reason === 'string' ? r.reason : undefined,
        disabled: r.disabled === true,
      });
    }
    return { rules };
  }

  private matchTool(pattern: string, toolName: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith(':*')) {
      // Namespace wildcard e.g. "mcp:*" matches "mcp:time:get_current_time".
      const prefix = pattern.slice(0, -1);
      return toolName.startsWith(prefix);
    }
    if (pattern.endsWith('*')) {
      return toolName.startsWith(pattern.slice(0, -1));
    }
    return pattern === toolName;
  }

  /**
   * Evaluate a `when` expression in a narrow sandbox.
   *
   * Functions made via the Function constructor are invoked in the GLOBAL
   * scope, which in Node.js means identifiers like `process`, `global`,
   * `globalThis`, `console`, `Buffer`, and the timer functions ARE visible
   * to naive expressions. To close that gap we declare those names as
   * formal parameters and pass `undefined` — JavaScript then resolves the
   * identifier against the parameter binding first, shadowing the global.
   *
   * `require` is module-scoped (not a true global) and is never visible
   * inside a dynamic Function anyway, but we shadow it defensively.
   *
   * Evaluation errors are logged and treated as "not matching" so a broken
   * expression can't wedge tool use.
   */
  private evaluateWhen(expr: string, ctx: HookContext): boolean {
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      const fn = new Function(
        'args', 'tool', 'result',
        // Shadowed — always undefined inside the expression:
        'process', 'require', 'global', 'globalThis',
        'console', 'Buffer', 'setImmediate', 'clearImmediate',
        'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
        `"use strict"; return (${expr});`,
      );
      const v = fn(ctx.args ?? {}, ctx.tool, ctx.result);
      return !!v;
    } catch (err) {
      log.warn({ expr, err: (err as Error).message }, 'Hook `when` expression failed — rule not matched');
      return false;
    }
  }
}
