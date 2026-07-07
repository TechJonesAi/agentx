import { BaseLLMProvider } from './base.js';
import { createLogger } from '../logger.js';
import type { LLMRequestOptions, LLMResponse, Message, ToolCall, ToolDefinition, StreamCallbacks } from '../types.js';

const log = createLogger('llm:ollama');

/**
 * Native Ollama tool calling — OPT-IN feature ported from claude/kind-poitras.
 *
 * Enable by setting:
 *   AGENTX_OLLAMA_TOOL_CALLING=true
 *
 * When the flag is OFF (default), behaviour is byte-equivalent to the
 * pre-import OllamaProvider:
 *   - no `tools` field is sent in the request body
 *   - no `tool_calls` are parsed from responses
 *   - timeouts are unchanged (default fetch behaviour)
 *   - tool-role messages are coerced to user-role with "[Tool Result]:" prefix
 *     (legacy compatibility)
 *
 * When the flag is ON:
 *   - `options.tools` is converted to Ollama's OpenAI-compatible format
 *     and passed in the request body
 *   - Adaptive timeouts: large models (70B+) get 5min, medium (30B+) get
 *     2–3min, small models 60–120s. Necessary because tool-call requests
 *     often have higher latency than plain chat.
 *   - Response `tool_calls` are parsed (native format) OR extracted from
 *     mixed-content JSON (fallback for models like qwen2.5-coder that
 *     emit tool calls as text)
 *   - Tool-role messages are emitted with role='tool' (Ollama native)
 *   - Assistant messages with toolCalls are re-emitted with tool_calls
 *     so multi-turn tool chains have context
 *
 * Rollback: unset AGENTX_OLLAMA_TOOL_CALLING. The flag is read on every
 * complete()/completeStream() call so changes take effect immediately
 * without restarting the agent.
 */
function isToolCallingEnabled(): boolean {
  const v = process.env['AGENTX_OLLAMA_TOOL_CALLING'];
  if (!v) return false;
  const lower = v.toLowerCase().trim();
  return lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on';
}

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: Array<{
    id?: string;
    function: { name: string; arguments: Record<string, unknown>; index?: number };
  }>;
}

interface OllamaChatResponse {
  message: {
    role: string;
    content: string;
    tool_calls?: Array<{
      id?: string;
      function: { name: string; arguments: Record<string, unknown>; index?: number };
    }>;
  };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
}

interface OllamaToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export class OllamaProvider extends BaseLLMProvider {
  readonly name = 'ollama';
  private baseUrl: string;
  private model: string;

  constructor(model?: string, baseUrl?: string) {
    super();
    this.model = model ?? 'llama3';
    this.baseUrl = baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
  }

  isConfigured(): boolean {
    return true; // Ollama just needs to be running locally
  }

  getModel(): string {
    return this.model;
  }

  /**
   * Context window per request. Ollama's server-side default is tiny (2-4k
   * tokens) — long chats were silently truncated from the front, so the
   * model "forgot" earlier turns and its own prior output. 16k is
   * comfortable for every fleet model on this machine's RAM;
   * AGENTX_OLLAMA_NUM_CTX overrides.
   */
  private getNumCtx(): number {
    const env = Number(process.env['AGENTX_OLLAMA_NUM_CTX']);
    return Number.isFinite(env) && env >= 2048 ? env : 16384;
  }

  /**
   * Adaptive timeout per model size — only applied when tool calling is
   * enabled. Plain chat (flag off) uses the default fetch timeout to
   * preserve historical behaviour.
   */
  private getModelTimeout(hasTools: boolean): number {
    const lower = this.model.toLowerCase();
    if (/\b(70b|65b|72b|110b)\b/.test(lower)) return 300_000;
    if (/\b(30b|32b|34b)\b/.test(lower)) return hasTools ? 180_000 : 120_000;
    return hasTools ? 120_000 : 60_000;
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const toolsEnabled = isToolCallingEnabled();
    const messages = this.convertMessages(options.messages, options.systemPrompt, toolsEnabled);
    // Batch 3: per-call model override. Thread-safe — no provider state mutated.
    const activeModel = options.model && options.model.trim().length > 0 ? options.model : this.model;

    log.debug({
      messageCount: messages.length, model: activeModel, toolsEnabled,
      overridden: activeModel !== this.model,
    }, 'Sending request to Ollama');

    const tools = toolsEnabled ? this.convertTools(options.tools) : [];

    const body: Record<string, unknown> = {
      model: activeModel,
      messages,
      stream: false,
      options: { num_ctx: this.getNumCtx() },
      // Keep models resident between messages — Ollama's 5-minute default
      // unload meant a 20-40GB cold reload mid-conversation.
      keep_alive: process.env['AGENTX_OLLAMA_KEEP_ALIVE'] ?? '30m',
    };
    if (tools.length > 0) {
      body.tools = tools;
    }

    // Adaptive timeout only when the new behaviour is opted in. Legacy
    // path keeps default fetch behaviour to avoid any regression.
    let response: Response;
    if (toolsEnabled) {
      const controller = new AbortController();
      const timeoutMs = this.getModelTimeout(tools.length > 0);
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      log.debug({ model: this.model, timeoutMs, hasTools: tools.length > 0 }, 'Adaptive timeout configured');
      try {
        response = await fetch(`${this.baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }
    } else {
      response = await fetch(`${this.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    }

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaChatResponse;

    // Legacy path: no tool-call parsing.
    if (!toolsEnabled) {
      return {
        content: data.message.content,
        finishReason: 'stop',
        usage: data.eval_count ? {
          inputTokens: data.prompt_eval_count ?? 0,
          outputTokens: data.eval_count,
        } : undefined,
      };
    }

    // Opt-in path: parse tool calls from response.
    const toolCalls = this.parseToolCalls(data);
    const content = toolCalls.length > 0 ? '' : (data.message.content ?? '');
    return {
      content,
      finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: data.eval_count ? {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count,
      } : undefined,
    };
  }

  async completeStream(options: LLMRequestOptions, callbacks: StreamCallbacks): Promise<LLMResponse> {
    const toolsEnabled = isToolCallingEnabled();
    const messages = this.convertMessages(options.messages, options.systemPrompt, toolsEnabled);
    // Batch 3: per-call model override. Thread-safe — no provider state mutated.
    const activeModel = options.model && options.model.trim().length > 0 ? options.model : this.model;

    log.debug({
      messageCount: messages.length, model: activeModel, toolsEnabled,
      overridden: activeModel !== this.model,
    }, 'Starting streaming request to Ollama');

    const tools = toolsEnabled ? this.convertTools(options.tools) : [];

    const body: Record<string, unknown> = {
      model: activeModel,
      messages,
      stream: true,
      options: { num_ctx: this.getNumCtx() },
      // Keep models resident between messages — Ollama's 5-minute default
      // unload meant a 20-40GB cold reload mid-conversation.
      keep_alive: process.env['AGENTX_OLLAMA_KEEP_ALIVE'] ?? '30m',
    };
    if (tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    let content = '';
    const aggregatedToolCalls: Array<{
      id?: string; function: { name: string; arguments: Record<string, unknown> };
    }> = [];
    const reader = response.body?.getReader();
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const chunk = JSON.parse(line) as OllamaChatResponse;
            if (chunk.message?.content) {
              content += chunk.message.content;
              if (callbacks.onToken) {
                callbacks.onToken(chunk.message.content);
              }
            }
            // Aggregate tool_calls only when opted in.
            if (toolsEnabled && chunk.message?.tool_calls?.length) {
              for (const tc of chunk.message.tool_calls) {
                aggregatedToolCalls.push(tc);
              }
            }
          } catch {
            // Skip malformed lines
          }
        }
      }
    }

    let toolCalls: ToolCall[] = [];
    if (toolsEnabled && aggregatedToolCalls.length > 0) {
      let callId = 0;
      toolCalls = aggregatedToolCalls.map((tc) => ({
        id: tc.id ?? `call_${Date.now()}_${callId++}`,
        name: tc.function.name,
        arguments: tc.function.arguments ?? {},
      }));
    }

    // Fallback: some Ollama models (qwen2.5-coder, llama 3, etc.) emit
    // tool calls as JSON-in-content during streaming instead of via the
    // native `tool_calls` field. The non-streaming path already handles
    // this via parseToolCalls(); replicate that for the streaming path
    // so the agent's dispatch loop actually fires when the model wants
    // a tool.
    if (toolsEnabled && toolCalls.length === 0 && content.trim().length > 0) {
      const extracted = this.extractToolCallsFromContent(content.trim(), 0);
      if (extracted.length > 0) {
        toolCalls = extracted;
        log.debug({ count: toolCalls.length, format: 'json-in-content-stream' }, 'Parsed streaming tool calls from content');
      }
    }

    const result: LLMResponse = {
      content: toolCalls.length > 0 ? '' : content,
      finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };

    if (callbacks.onComplete) {
      callbacks.onComplete(result);
    }

    return result;
  }

  private convertMessages(
    messages: Message[], systemPrompt?: string, toolsEnabled = false,
  ): OllamaChatMessage[] {
    const result: OllamaChatMessage[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'tool') {
        if (toolsEnabled) {
          // Native tool-role passthrough (Ollama supports role='tool' when
          // tool calling is enabled).
          result.push({ role: 'tool', content: msg.content });
        } else {
          // Legacy fallback — coerce to user message for models without
          // tool-call awareness. Preserves pre-import behaviour exactly.
          result.push({ role: 'user', content: `[Tool Result]: ${msg.content}` });
        }
      } else if (toolsEnabled && msg.role === 'assistant' && msg.toolCalls?.length) {
        result.push({
          role: 'assistant',
          content: msg.content || '',
          tool_calls: msg.toolCalls.map((tc) => ({
            function: { name: tc.name, arguments: tc.arguments },
          })),
        });
      } else if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
        result.push({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }

  /** Tool definitions are only converted when AGENTX_OLLAMA_TOOL_CALLING=true. */
  private convertTools(tools?: ToolDefinition[]): OllamaToolDef[] {
    if (!tools || tools.length === 0) return [];
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: t.parameters ?? { type: 'object', properties: {} },
      },
    }));
  }

  /**
   * Parse tool calls from a complete Ollama response. Handles two formats:
   *   1. Native `tool_calls` array (qwen3, llama3.1+, etc.)
   *   2. JSON-in-content fallback for models that emit tool calls as text
   */
  private parseToolCalls(data: OllamaChatResponse): ToolCall[] {
    const toolCalls: ToolCall[] = [];
    let callId = 0;

    // Format 1: native tool_calls
    if (data.message.tool_calls && data.message.tool_calls.length > 0) {
      for (const tc of data.message.tool_calls) {
        toolCalls.push({
          id: tc.id ?? `call_${Date.now()}_${callId++}`,
          name: tc.function.name,
          arguments: tc.function.arguments ?? {},
        });
      }
      if (toolCalls.length > 0) {
        log.debug({ count: toolCalls.length, format: 'native' }, 'Parsed native tool calls');
        return toolCalls;
      }
    }

    // Format 2: JSON-in-content fallback
    const content = (data.message.content ?? '').trim();
    if (content) {
      const extracted = this.extractToolCallsFromContent(content, callId);
      if (extracted.length > 0) {
        log.debug({ count: extracted.length, format: 'json-in-content' }, 'Parsed tool calls from content');
        return extracted;
      }
    }
    return toolCalls;
  }

  /**
   * Balanced-brace JSON extraction. Walks the string looking for top-level
   * `{…}` objects and tries to parse each as a `{name, arguments}` tool
   * call. Handles multiple concatenated objects and JSON embedded in text.
   */
  private extractToolCallsFromContent(content: string, startId: number): ToolCall[] {
    const calls: ToolCall[] = [];
    let callId = startId;

    // Format 2a: bare "tool_name {json args}" — some models (observed with
    // the fleet's instruct models) emit the tool name followed by the raw
    // argument object, with no {"name": …} wrapper. Only accepted when the
    // ENTIRE message is exactly that shape, so prose containing braces can
    // never be misparsed as a call.
    const bare = content.match(/^\s*([a-zA-Z_][\w.-]{1,63})\s*(\{[\s\S]*\})\s*$/);
    if (bare) {
      try {
        const args = JSON.parse(bare[2]!) as Record<string, unknown>;
        return [{
          id: `call_${Date.now()}_${callId++}`,
          name: bare[1]!,
          arguments: args,
        }];
      } catch { /* not valid JSON — fall through to brace scanning */ }
    }

    let i = 0;
    while (i < content.length) {
      const openIdx = content.indexOf('{', i);
      if (openIdx === -1) break;
      let depth = 0;
      let inString = false;
      let escape = false;
      let closeIdx = -1;
      for (let j = openIdx; j < content.length; j++) {
        const ch = content[j];
        if (escape) { escape = false; continue; }
        if (ch === '\\' && inString) { escape = true; continue; }
        if (ch === '"' && !escape) { inString = !inString; continue; }
        if (inString) continue;
        if (ch === '{') depth++;
        else if (ch === '}') {
          depth--;
          if (depth === 0) { closeIdx = j; break; }
        }
      }
      if (closeIdx === -1) break;
      const candidate = content.slice(openIdx, closeIdx + 1);
      i = closeIdx + 1;
      try {
        const parsed = JSON.parse(candidate) as { name?: string; arguments?: Record<string, unknown> };
        if (parsed.name && typeof parsed.name === 'string') {
          calls.push({
            id: `call_${Date.now()}_${callId++}`,
            name: parsed.name,
            arguments: parsed.arguments ?? {},
          });
        }
      } catch {
        // Not a valid tool call — skip
      }
    }
    return calls;
  }
}
