/**
 * OpenTelemetry GenAI instrumentation.
 *
 * Gives AgentX standards-compliant traces for every LLM call, tool call, and
 * subagent run. Attributes follow OpenTelemetry's GenAI semantic conventions
 * (gen_ai.* — see https://opentelemetry.io/docs/specs/semconv/gen-ai/) so
 * traces can be read by any OTel-aware backend (Phoenix, LangSmith,
 * Braintrust, Weave, Jaeger, Datadog, etc.) without custom parsers.
 *
 * DESIGN PRINCIPLES:
 *   - OFF BY DEFAULT. Until the user enables `features.otelTracing` in
 *     Settings, initialisation is skipped and the helper functions are
 *     no-op passthroughs — zero runtime cost.
 *   - PRIVACY-FIRST. No full message content in spans by default — only
 *     metadata (model, token counts, tool names, durations). A separate
 *     `features.otelContentTracing` flag opts-in to content capture, which
 *     is sometimes useful for debugging but also more privacy-sensitive.
 *   - LOCAL-FIRST EXPORT. If the user turns tracing on without setting
 *     OTEL_EXPORTER_OTLP_ENDPOINT, spans are held in-process and never
 *     leave. Only an explicit endpoint (typically http://localhost:6006
 *     for Arize Phoenix) triggers export — and even then, local-only
 *     unless the endpoint is remote (which the user would have deliberately
 *     configured).
 *   - NEVER CRASHES. If OTel init fails, the helpers degrade to no-ops.
 */

import { createLogger } from '../logger.js';

const log = createLogger('observability:otel');

/** Env var that enables an OTLP HTTP exporter. Usually http://localhost:6006/v1/traces for Phoenix. */
export const OTEL_ENDPOINT_ENV = 'OTEL_EXPORTER_OTLP_ENDPOINT';

/** Service name attribute used on every emitted span. */
const SERVICE_NAME = 'agentx';

/** Internal state. When `enabled=false`, every helper is a no-op. */
interface OtelState {
  enabled: boolean;
  contentTracing: boolean;
  tracer: any | null;
  sdk: any | null;
}

const state: OtelState = {
  enabled: false,
  contentTracing: false,
  tracer: null,
  sdk: null,
};

export interface OtelInitOptions {
  /** Master switch. When false, init does nothing and helpers are no-ops. */
  enabled: boolean;
  /** Whether to include full message / tool argument content in spans. */
  contentTracing?: boolean;
  /** OTLP endpoint. Falls back to $OTEL_EXPORTER_OTLP_ENDPOINT, else no exporter. */
  endpoint?: string;
}

/**
 * Initialise the SDK. Idempotent — repeat calls are cheap when the flags
 * don't change, and trigger clean shutdown + re-init when they do. Safe to
 * call on every config update.
 */
export async function initOtel(options: OtelInitOptions): Promise<void> {
  // Short-circuit when disabled: tear down if previously running.
  if (!options.enabled) {
    if (state.sdk) {
      try { await state.sdk.shutdown(); } catch { /* */ }
    }
    state.enabled = false;
    state.sdk = null;
    state.tracer = null;
    return;
  }

  // Already running with the same content-tracing flag — nothing to do.
  if (state.enabled && state.contentTracing === (options.contentTracing === true)) return;

  // Shut down previous instance before re-initing.
  if (state.sdk) {
    try { await state.sdk.shutdown(); } catch { /* */ }
    state.sdk = null;
  }

  try {
    // Lazy imports keep the module weight out of the hot path when disabled.
    const { NodeSDK } = await import('@opentelemetry/sdk-node');
    const apiModule = await import('@opentelemetry/api');

    const endpoint = options.endpoint ?? process.env[OTEL_ENDPOINT_ENV];
    let traceExporter: any;
    if (endpoint) {
      const { OTLPTraceExporter } = await import('@opentelemetry/exporter-trace-otlp-http');
      traceExporter = new OTLPTraceExporter({ url: endpoint });
      log.info({ endpoint }, 'OTel: OTLP HTTP exporter configured');
    } else {
      // No exporter — spans are created, attributes are set, but nothing
      // leaves the process. Zero data exposure.
      log.info('OTel: no exporter configured (spans held in-process, discarded on shutdown)');
    }

    // NodeSDK uses OTEL_SERVICE_NAME env var for service name, with sensible
    // defaults when omitted. We avoid passing a custom Resource object to
    // sidestep cross-package version-compat issues; service-name is a minor
    // attribute that doesn't affect trace correctness.
    process.env['OTEL_SERVICE_NAME'] = process.env['OTEL_SERVICE_NAME'] ?? SERVICE_NAME;

    const sdk = new NodeSDK({ traceExporter });
    sdk.start();

    state.sdk = sdk;
    state.tracer = apiModule.trace.getTracer('agentx');
    state.enabled = true;
    state.contentTracing = options.contentTracing === true;

    log.info({ contentTracing: state.contentTracing }, 'OTel instrumentation initialised');
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'OTel init failed — degrading to no-op');
    state.enabled = false;
    state.tracer = null;
    state.sdk = null;
  }
}

/** Shutdown hook for graceful server stop. Safe to call when never initialised. */
export async function shutdownOtel(): Promise<void> {
  if (state.sdk) {
    try { await state.sdk.shutdown(); } catch { /* */ }
  }
  state.enabled = false;
  state.sdk = null;
  state.tracer = null;
}

/** True when tracing is live. Helpers short-circuit when false. */
export function isOtelEnabled(): boolean {
  return state.enabled && !!state.tracer;
}

/**
 * Wrap an async function in a span. No-op (just runs the fn) when OTel is
 * disabled. Attributes follow gen_ai.* conventions where applicable.
 *
 * @param name       Span name (conventionally "<operation> <subject>" — e.g. "chat qwen3").
 * @param attrs      Initial attributes to set on the span.
 * @param fn         The async work to run.
 * @param finalAttrs Callback to add attributes AFTER the work finishes
 *                   (e.g. output token counts only known post-call).
 */
export async function withSpan<T>(
  name: string,
  attrs: Record<string, string | number | boolean | undefined>,
  fn: () => Promise<T>,
  finalAttrs?: (result: T) => Record<string, string | number | boolean | undefined>,
): Promise<T> {
  if (!state.enabled || !state.tracer) return fn();

  const tracer = state.tracer;
  return await tracer.startActiveSpan(name, async (span: any) => {
    try {
      for (const [k, v] of Object.entries(attrs)) {
        if (v !== undefined) span.setAttribute(k, v);
      }
      const result = await fn();
      if (finalAttrs) {
        for (const [k, v] of Object.entries(finalAttrs(result))) {
          if (v !== undefined) span.setAttribute(k, v);
        }
      }
      span.setStatus({ code: 1 }); // OK
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: 2, message: (err as Error).message }); // ERROR
      throw err;
    } finally {
      span.end();
    }
  });
}

/**
 * Thin convenience wrapper specifically for LLM calls. Emits gen_ai.* attrs
 * per the OpenTelemetry GenAI semantic conventions so the span is readable
 * by any OTel-aware backend.
 */
export async function withLLMSpan<T extends { content?: string; usage?: { inputTokens: number; outputTokens: number } }>(
  args: {
    system: string;              // gen_ai.system — "ollama" | "anthropic" | etc.
    model: string;               // gen_ai.request.model
    capability?: string;         // AgentX-specific — not in semconv
    operation?: string;          // gen_ai.operation.name — "chat" | "completion" | ...
    toolCount?: number;          // number of tools exposed to this call
    promptPreview?: string;      // captured only if contentTracing is on
  },
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    `${args.operation ?? 'chat'} ${args.model}`,
    {
      'gen_ai.system': args.system,
      'gen_ai.request.model': args.model,
      'gen_ai.operation.name': args.operation ?? 'chat',
      'agentx.capability': args.capability,
      'agentx.tool_count': args.toolCount,
      ...(state.contentTracing && args.promptPreview
        ? { 'gen_ai.prompt': args.promptPreview.slice(0, 2000) }
        : {}),
    },
    fn,
    (result) => ({
      'gen_ai.usage.input_tokens': result.usage?.inputTokens,
      'gen_ai.usage.output_tokens': result.usage?.outputTokens,
      'gen_ai.response.content_length': result.content?.length,
    }),
  );
}

/** Convenience wrapper for tool execution. */
export async function withToolSpan<T>(
  args: {
    toolName: string;
    argsPreview?: string;
    serverName?: string;  // for MCP tools
  },
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    `tool ${args.toolName}`,
    {
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': args.toolName,
      'agentx.mcp_server': args.serverName,
      ...(state.contentTracing && args.argsPreview
        ? { 'gen_ai.tool.call.arguments': args.argsPreview.slice(0, 1000) }
        : {}),
    },
    fn,
  );
}

/** Convenience wrapper for subagent runs. */
export async function withSubagentSpan<T extends { iterations: number; toolCalls: unknown[]; summary: string }>(
  args: { name: string; model?: string; capability?: string },
  fn: () => Promise<T>,
): Promise<T> {
  return withSpan(
    `subagent ${args.name}`,
    {
      'agentx.subagent.name': args.name,
      'gen_ai.request.model': args.model,
      'agentx.capability': args.capability,
    },
    fn,
    (result) => ({
      'agentx.subagent.iterations': result.iterations,
      'agentx.subagent.tool_call_count': result.toolCalls.length,
      'agentx.subagent.summary_length': result.summary.length,
    }),
  );
}
