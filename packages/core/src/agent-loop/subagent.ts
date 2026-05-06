/**
 * Subagent — isolated, scoped agent-in-an-agent primitive.
 *
 * Modelled on Claude Code's subagent pattern: spawn a short-lived worker
 * with its own system prompt, tool allowlist, and model choice. The worker
 * runs in a FORKED context — its conversation history is not shared with
 * the parent Agent — and returns a summary when it finishes.
 *
 * Why this exists:
 *   1. Context hygiene — long research / document-retrieval tasks eat
 *      parent-context tokens. A subagent keeps those turns in its own bubble
 *      and hands back only the distilled answer.
 *   2. Task-specialised routing — you can force a subagent to use a specific
 *      model for its capability (e.g. `llama3.3:70b` for a reasoning task,
 *      `xlam-2` for a tool-heavy task) without touching global routing.
 *   3. Safety scoping — restrict which tools a sub-task can invoke, so a
 *      "research" subagent can't accidentally run shell commands, and a
 *      "file edit" subagent can't call web_search.
 *
 * DESIGN CONSTRAINTS (don't break anything):
 *   - ADDITIVE ONLY. This file adds a new primitive. It DOES NOT modify the
 *     Agent chat loop, ModelFabric, ToolRegistry, conversation memory, or
 *     any other existing code path. Callers opt in by instantiating.
 *   - 100% LOCAL. Uses the parent's existing ModelFabric — no new providers,
 *     no new network calls, no new external services, no new API keys.
 *     The subagent routes through the same LOCAL_ONLY / COMBINATION /
 *     SUBSCRIPTION_ONLY mode the parent is configured for.
 *   - NO AGENTX STATE POLLUTION. Subagent conversation memory is a plain
 *     local array inside the run — it is never written to the parent's
 *     ConversationMemory, never stored in SQLite, never indexed.
 *   - FAIL CLOSED. Unknown tools in the allowlist → tool simply not
 *     available to the subagent. Errors during execution → captured in the
 *     SubagentResult, never thrown up to the caller unless fatal.
 *
 * NOT IN SCOPE FOR THIS PASS:
 *   - Loading subagents from Markdown files (Claude Code's skills format).
 *     That's a follow-up; this ships as a programmatic API only.
 *   - Dashboard UI / API endpoints. The primitive is callable by any code
 *     that holds the Agent instance — integration surfaces land later.
 */

import { createLogger } from '../logger.js';
import type { Message, Tool, ToolCall, ToolResult, ToolDefinition } from '../types.js';
import { eventBus } from './event-bus.js';
import { withSubagentSpan, withToolSpan } from '../observability/otel.js';

const log = createLogger('subagent');

/** Cap on subagent step count. A runaway tool loop can't use unlimited steps. */
const DEFAULT_MAX_ITERATIONS = 10;

/** Default max-tokens per underlying completion inside the subagent. */
const DEFAULT_MAX_TOKENS = 4096;

export interface SubagentConfig {
  /** Short kebab-case identifier used in logs + events. Helps you find runs. */
  name: string;
  /**
   * System prompt that scopes the subagent's behaviour. Kept separate from
   * the parent's system prompt — a subagent is a clean slate.
   */
  systemPrompt: string;
  /**
   * Allowlist of tool names the subagent may invoke. Any tool registered in
   * the parent ToolRegistry that is NOT in this list is filtered out before
   * being presented to the model. Omit to grant no tools.
   */
  toolNames?: string[];
  /**
   * Optional forced model. Equivalent to setting a per-subagent capability
   * pin without touching global routing config. Falls back to capability-
   * based routing when omitted.
   */
  model?: string;
  /** Routing capability hint. Defaults to 'text'. */
  capability?: string;
  /** Task-category hint for personalisation / BuildIntelligence bias. */
  taskCategory?: string;
  /** Hard cap on steps (each step = one LLM call + optional tool execution). */
  maxIterations?: number;
  /** Max-tokens per LLM call. Default 4096. */
  maxTokensPerCall?: number;
}

export interface SubagentToolEvent {
  toolName: string;
  argsPreview: string;
  durationMs: number;
  status: 'completed' | 'failed';
  result: string;
}

export interface SubagentResult {
  /** The subagent's final text answer to be returned to the parent. */
  summary: string;
  /** Every tool invocation made during the run, in order. */
  toolCalls: ToolCall[];
  /** Tool execution outcomes. Same length/order as toolCalls. */
  toolEvents: SubagentToolEvent[];
  /** Number of LLM round-trips (i.e. completion calls) executed. */
  iterations: number;
  /** Wall-clock duration of the whole run. */
  durationMs: number;
  /** Last-used model reported by the fabric (diagnostic). */
  modelUsed: string | null;
  /** Set when the subagent aborted abnormally (max-iters, tool exec error, etc.). */
  error?: string;
}

/**
 * Minimal shape of the ModelFabric the subagent needs. Declared as an
 * interface so tests can pass a stub without pulling in the real fabric.
 */
export interface SubagentFabricAdapter {
  completeWithMessages(
    options: { messages: Message[]; systemPrompt?: string; tools?: ToolDefinition[]; maxTokens?: number },
    capability?: string,
    taskCategory?: string,
    preferredModel?: string,
  ): Promise<{
    content: string;
    toolCalls?: ToolCall[];
    usage?: { inputTokens: number; outputTokens: number };
    finishReason: string;
  }>;
  getLastUsedModel(): string | null;
}

/** Minimal shape of the ToolRegistry the subagent needs. */
export interface SubagentRegistryAdapter {
  /** Look up a tool by name. Returns undefined if not registered. */
  get(name: string): Tool | undefined;
  /** List definitions of all registered tools (for filtering by allowlist). */
  getDefinitions(): ToolDefinition[];
}

export interface SubagentDeps {
  fabric: SubagentFabricAdapter;
  registry: SubagentRegistryAdapter;
}

/**
 * The primitive itself. Stateless across runs — construct per-task, or
 * reuse across runs if the config + allowlist are stable.
 */
export class Subagent {
  constructor(
    private config: SubagentConfig,
    private deps: SubagentDeps,
  ) {
    if (!config.name || typeof config.name !== 'string') {
      throw new Error('Subagent: `name` is required');
    }
    if (!config.systemPrompt || typeof config.systemPrompt !== 'string') {
      throw new Error('Subagent: `systemPrompt` is required');
    }
  }

  /**
   * Execute one subagent run. Returns the final summary + full call log.
   * Never throws for normal failure conditions (max-iters, tool exec error,
   * unknown tool) — those land in `SubagentResult.error`. Only throws if the
   * underlying fabric itself blows up in an unrecoverable way.
   */
  async run(userPrompt: string): Promise<SubagentResult> {
    // OTel span around the whole subagent run (no-op when tracing disabled).
    return withSubagentSpan(
      { name: this.config.name, model: this.config.model, capability: this.config.capability },
      () => this._runInner(userPrompt),
    );
  }

  private async _runInner(userPrompt: string): Promise<SubagentResult> {
    const started = Date.now();
    const maxIters = this.config.maxIterations ?? DEFAULT_MAX_ITERATIONS;
    const capability = this.config.capability ?? 'text';
    const maxTokens = this.config.maxTokensPerCall ?? DEFAULT_MAX_TOKENS;

    // ── Scoped tool list (allowlist intersect registry) ──────────────
    // Unknown names are silently dropped: we prefer "tool quietly unavailable
    // to this subagent" over "unknown tool crashes the run".
    const allowlist = Array.isArray(this.config.toolNames) ? this.config.toolNames : [];
    const allowSet = new Set(allowlist);
    const scopedTools: ToolDefinition[] = allowlist.length === 0
      ? []
      : this.deps.registry.getDefinitions().filter(def => allowSet.has(def.name));

    // ── Forked conversation history ──────────────────────────────────
    // Local array; never touches the parent Agent's ConversationMemory.
    const messages: Message[] = [
      { role: 'user', content: userPrompt, timestamp: started },
    ];

    const toolCalls: ToolCall[] = [];
    const toolEvents: SubagentToolEvent[] = [];
    let iterations = 0;
    let finalSummary = '';
    let error: string | undefined;

    eventBus.emit('subagent.started', {
      name: this.config.name,
      userPromptPreview: userPrompt.slice(0, 200),
      toolCount: scopedTools.length,
      model: this.config.model ?? null,
      capability,
      timestamp: started,
    } as any);

    try {
      while (iterations < maxIters) {
        iterations++;
        const response = await this.deps.fabric.completeWithMessages(
          {
            messages,
            systemPrompt: this.config.systemPrompt,
            tools: scopedTools.length > 0 ? scopedTools : undefined,
            maxTokens,
          },
          capability,
          this.config.taskCategory,
          this.config.model,
        );

        // Record the assistant turn in the forked history so follow-up calls
        // see the same conversation the model just produced.
        messages.push({
          role: 'assistant',
          content: response.content ?? '',
          toolCalls: response.toolCalls,
          timestamp: Date.now(),
        });

        if (!response.toolCalls || response.toolCalls.length === 0) {
          finalSummary = response.content ?? '';
          break;
        }

        // Execute each tool the model asked for, collecting events.
        for (const tc of response.toolCalls) {
          toolCalls.push(tc);
          const toolStart = Date.now();

          // Enforce the allowlist at execution time too (defence-in-depth:
          // a model that ignores the `tools:` filter still can't run a
          // disallowed tool).
          if (!allowSet.has(tc.name)) {
            const msg = `Tool '${tc.name}' is not in this subagent's allowlist.`;
            toolEvents.push({ toolName: tc.name, argsPreview: '', durationMs: 0, status: 'failed', result: msg });
            messages.push({
              role: 'tool',
              content: msg,
              toolCallId: tc.id,
              timestamp: Date.now(),
            });
            continue;
          }

          const tool = this.deps.registry.get(tc.name);
          if (!tool) {
            const msg = `Tool '${tc.name}' is not registered.`;
            toolEvents.push({ toolName: tc.name, argsPreview: '', durationMs: 0, status: 'failed', result: msg });
            messages.push({
              role: 'tool',
              content: msg,
              toolCallId: tc.id,
              timestamp: Date.now(),
            });
            continue;
          }

          let result: string;
          let status: 'completed' | 'failed' = 'completed';
          try {
            // NOTE: we don't wire AuditLogger here — the parent Agent's
            // ToolRegistry hook would normally do that, but this subagent
            // calls tools directly to keep the primitive pure. If you want
            // audit logging, pass an instrumented registry adapter.
            // Tool call wrapped in an OTel span (no-op when tracing off).
            result = await withToolSpan(
              { toolName: tc.name, argsPreview: JSON.stringify(tc.arguments ?? {}) },
              () => tool.execute(tc.arguments as Record<string, unknown>, {
                sessionId: `subagent:${this.config.name}`,
                agent: null as any,
              } as any),
            );
          } catch (err) {
            status = 'failed';
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          const toolResult: ToolResult = { toolCallId: tc.id, content: result };
          messages.push({
            role: 'tool',
            content: result,
            toolCallId: tc.id,
            timestamp: Date.now(),
          });

          const argsPreview = JSON.stringify(tc.arguments ?? {}).slice(0, 200);
          toolEvents.push({
            toolName: tc.name,
            argsPreview,
            durationMs: Date.now() - toolStart,
            status,
            result: typeof toolResult.content === 'string' ? toolResult.content.slice(0, 500) : '',
          });

          eventBus.emit('subagent.tool_call', {
            name: this.config.name,
            tool: tc.name,
            status,
            durationMs: Date.now() - toolStart,
          } as any);
        }
      }

      if (iterations >= maxIters && !finalSummary) {
        error = `Subagent exceeded maxIterations (${maxIters}) without producing a final answer`;
        // Best-effort summary: last assistant message content if any.
        const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant');
        finalSummary = lastAssistant?.content ?? '';
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      log.warn({ name: this.config.name, err: error }, 'Subagent run aborted');
    }

    const durationMs = Date.now() - started;
    const result: SubagentResult = {
      summary: finalSummary,
      toolCalls,
      toolEvents,
      iterations,
      durationMs,
      modelUsed: this.deps.fabric.getLastUsedModel?.() ?? null,
      error,
    };

    eventBus.emit('subagent.completed', {
      name: this.config.name,
      iterations,
      durationMs,
      toolCallCount: toolCalls.length,
      error: error ?? null,
      timestamp: Date.now(),
    } as any);

    return result;
  }
}
