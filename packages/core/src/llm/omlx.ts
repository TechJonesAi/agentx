/**
 * OmlxProvider — Apple MLX local inference provider (OpenAI-compatible).
 *
 * Runs ALONGSIDE Ollama, never as a replacement. Routes only when explicit
 * evidence shows oMLX wins for a task category (see ProviderBenchmarkStore
 * + ModelRoutingEngine integration).
 *
 * Endpoint resolution:
 *   - AGENTX_OMLX_ENDPOINT env var (default http://localhost:8080)
 *
 * Hard rule: localhost-only.
 *   The constructor validates the URL hostname is one of
 *   localhost / 127.0.0.1 / ::1 / 0.0.0.0 — any other value throws
 *   immediately so a misconfiguration cannot silently leak to a remote
 *   inference endpoint. This is the same guarantee localOnly mode
 *   gives elsewhere, hard-coded into the provider itself so it's
 *   impossible to bypass via runtime settings.
 *
 * API shape: OpenAI Chat Completions
 *   POST /v1/chat/completions   { model, messages, stream, tools? }
 *
 * The implementation deliberately mirrors the OllamaProvider so the rest
 * of the runtime treats both interchangeably.
 */
import { BaseLLMProvider } from './base.js';
import type { LLMRequestOptions, LLMResponse, StreamCallbacks, Message, ToolDefinition, ToolCall } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('llm:omlx');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0']);

export interface OmlxOptions {
  endpoint?: string;
  model?: string;
}

export class OmlxProvider extends BaseLLMProvider {
  readonly name = 'omlx';
  private endpoint: string;
  private model: string;

  constructor(opts: OmlxOptions = {}) {
    super();
    this.endpoint = (opts.endpoint ?? process.env['AGENTX_OMLX_ENDPOINT'] ?? 'http://localhost:8080').replace(/\/+$/, '');
    this.model = opts.model ?? process.env['AGENTX_OMLX_MODEL'] ?? 'mlx-community/Llama-3-8B-Instruct-4bit';
    this.assertLocalhostOnly(this.endpoint);
  }

  /** Throws if the endpoint hostname is not on the localhost allow-list.
   *  Exported as a static so tests can exercise it without instantiating
   *  the provider. */
  static assertLocalhostOnly(endpoint: string): void {
    let host: string;
    try {
      const u = new URL(endpoint);
      // Node's URL strips brackets from hostname for some IPv6 forms but
      // leaves them in for others. Normalize.
      host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    } catch (e) {
      throw new Error(`OmlxProvider: invalid endpoint URL '${endpoint}': ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!LOCAL_HOSTS.has(host)) {
      throw new Error(
        `OmlxProvider: endpoint '${endpoint}' has non-local host '${host}'. ` +
        `Only ${[...LOCAL_HOSTS].join(', ')} are permitted. ` +
        `Set AGENTX_OMLX_ENDPOINT to a localhost address.`,
      );
    }
  }

  /** Instance shim that calls the static. Kept for ergonomics. */
  private assertLocalhostOnly(endpoint: string): void {
    OmlxProvider.assertLocalhostOnly(endpoint);
  }

  isConfigured(): boolean {
    // Provider is configured the moment an endpoint is set. Whether the
    // server is reachable is a HealthMonitor concern.
    return !!this.endpoint;
  }

  getEndpoint(): string { return this.endpoint; }
  getModel(): string { return this.model; }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    return this._call(options, false, undefined);
  }

  async completeStream(options: LLMRequestOptions, callbacks: StreamCallbacks): Promise<LLMResponse> {
    return this._call(options, true, callbacks);
  }

  private async _call(
    options: LLMRequestOptions,
    stream: boolean,
    callbacks: StreamCallbacks | undefined,
  ): Promise<LLMResponse> {
    const activeModel = options.model && options.model.trim().length > 0 ? options.model : this.model;
    const messages = this.convertMessages(options.messages, options.systemPrompt);
    const tools = (options.tools && options.tools.length > 0) ? this.convertTools(options.tools) : undefined;

    const body: Record<string, unknown> = {
      model: activeModel,
      messages,
      stream,
    };
    if (typeof options.maxTokens === 'number') body['max_tokens'] = options.maxTokens;
    if (typeof options.temperature === 'number') body['temperature'] = options.temperature;
    if (tools) body['tools'] = tools;

    log.debug({ endpoint: this.endpoint, model: activeModel, stream, tools: !!tools }, 'oMLX request');

    if (!stream) {
      const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`oMLX request failed: ${response.status} ${response.statusText}`);
      }
      const data = (await response.json()) as OpenAIChatResponse;
      return this.parseResponse(data);
    }

    // Streaming path (SSE)
    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify(body),
    });
    if (!response.ok || !response.body) {
      throw new Error(`oMLX stream failed: ${response.status} ${response.statusText}`);
    }
    return this.consumeStream(response.body, callbacks);
  }

  private convertMessages(messages: Message[], systemPrompt?: string): Array<Record<string, unknown>> {
    const out: Array<Record<string, unknown>> = [];
    if (systemPrompt) out.push({ role: 'system', content: systemPrompt });
    for (const m of messages) {
      if (m.role === 'tool') {
        out.push({ role: 'tool', content: m.content, tool_call_id: m.toolCallId });
      } else if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
        out.push({
          role: 'assistant',
          content: m.content || '',
          tool_calls: m.toolCalls.map((t) => ({
            id: t.id,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.arguments) },
          })),
        });
      } else {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }

  private convertTools(tools: ToolDefinition[]): Array<Record<string, unknown>> {
    return tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }

  private parseResponse(data: OpenAIChatResponse): LLMResponse {
    const choice = data.choices?.[0];
    if (!choice) {
      return { content: '', finishReason: 'stop' };
    }
    const toolCalls: ToolCall[] = (choice.message?.tool_calls ?? []).map((tc) => {
      let args: Record<string, unknown> = {};
      try { args = JSON.parse(tc.function.arguments); } catch { /* best effort */ }
      return { id: tc.id, name: tc.function.name, arguments: args };
    });
    return {
      content: choice.message?.content ?? '',
      finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.usage ? {
        inputTokens: data.usage.prompt_tokens ?? 0,
        outputTokens: data.usage.completion_tokens ?? 0,
      } : undefined,
    };
  }

  private async consumeStream(stream: ReadableStream<Uint8Array>, callbacks: StreamCallbacks | undefined): Promise<LLMResponse> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    const toolCallAcc: Map<number, { id: string; name: string; args: string }> = new Map();
    let inputTokens = 0;
    let outputTokens = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let lineEnd;
        while ((lineEnd = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, lineEnd).trim();
          buffer = buffer.slice(lineEnd + 1);
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const ev = JSON.parse(payload) as OpenAIStreamChunk;
            const delta = ev.choices?.[0]?.delta;
            if (delta?.content) {
              content += delta.content;
              if (callbacks?.onToken) callbacks.onToken(delta.content);
            }
            if (delta?.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                const acc = toolCallAcc.get(idx) ?? { id: '', name: '', args: '' };
                if (tc.id) acc.id = tc.id;
                if (tc.function?.name) acc.name = tc.function.name;
                if (tc.function?.arguments) acc.args += tc.function.arguments;
                toolCallAcc.set(idx, acc);
              }
            }
            if (ev.usage) {
              inputTokens = ev.usage.prompt_tokens ?? 0;
              outputTokens = ev.usage.completion_tokens ?? 0;
            }
          } catch {
            // Ignore malformed SSE frames
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ToolCall[] = [...toolCallAcc.values()].map((t) => {
      let args: Record<string, unknown> = {};
      try { args = t.args ? JSON.parse(t.args) : {}; } catch { /* */ }
      return { id: t.id || `omlx-tc-${Math.random().toString(36).slice(2)}`, name: t.name, arguments: args };
    });

    const final: LLMResponse = {
      content,
      finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      ...(inputTokens || outputTokens ? { usage: { inputTokens, outputTokens } } : {}),
    };
    if (callbacks?.onComplete) callbacks.onComplete(final);
    return final;
  }
}

// ── Wire-format types (OpenAI-compatible) ────────────────────────────────

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{
        index?: number;
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}
