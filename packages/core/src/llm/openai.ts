import OpenAI from 'openai';
import { BaseLLMProvider } from './base.js';
import { createLogger } from '../logger.js';
import type { LLMRequestOptions, LLMResponse, Message, ToolDefinition, StreamCallbacks, ToolCall } from '../types.js';

const log = createLogger('llm:openai');

export class OpenAIProvider extends BaseLLMProvider {
  readonly name = 'openai';
  private client: OpenAI | null = null;
  private model: string;
  private maxTokens: number;

  constructor(model?: string, maxTokens?: number) {
    super();
    this.model = model ?? 'gpt-4o';
    this.maxTokens = maxTokens ?? 4096;
  }

  isConfigured(): boolean {
    return !!process.env['OPENAI_API_KEY'];
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI();
    }
    return this.client;
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const client = this.getClient();

    const messages = this.convertMessages(options.messages, options.systemPrompt);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    log.debug({ messageCount: messages.length }, 'Sending request to OpenAI');

    const response = await client.chat.completions.create({
      model: this.model,
      max_tokens: options.maxTokens ?? this.maxTokens,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    return this.parseResponse(response);
  }

  async completeStream(options: LLMRequestOptions, callbacks: StreamCallbacks): Promise<LLMResponse> {
    const client = this.getClient();

    const messages = this.convertMessages(options.messages, options.systemPrompt);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    log.debug({ messageCount: messages.length }, 'Starting streaming request to OpenAI');

    const stream = await client.chat.completions.create({
      model: this.model,
      max_tokens: options.maxTokens ?? this.maxTokens,
      messages,
      stream: true,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    let content = '';
    const toolCallAccumulator = new Map<number, { id: string; name: string; args: string }>();

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta;
      if (!delta) continue;

      if (delta.content) {
        content += delta.content;
        if (callbacks.onToken) {
          callbacks.onToken(delta.content);
        }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = toolCallAccumulator.get(tc.index);
          if (existing) {
            if (tc.function?.arguments) {
              existing.args += tc.function.arguments;
            }
          } else {
            toolCallAccumulator.set(tc.index, {
              id: tc.id ?? '',
              name: tc.function?.name ?? '',
              args: tc.function?.arguments ?? '',
            });
          }
        }
      }
    }

    const toolCalls: ToolCall[] = [];
    for (const [, tc] of toolCallAccumulator) {
      const toolCall: ToolCall = {
        id: tc.id,
        name: tc.name,
        arguments: JSON.parse(tc.args || '{}') as Record<string, unknown>,
      };
      toolCalls.push(toolCall);
      if (callbacks.onToolCall) {
        callbacks.onToolCall(toolCall);
      }
    }

    const response: LLMResponse = {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: toolCalls.length > 0 ? 'tool_use' : 'stop',
    };

    if (callbacks.onComplete) {
      callbacks.onComplete(response);
    }

    return response;
  }

  private convertMessages(
    messages: Message[],
    systemPrompt?: string,
  ): OpenAI.ChatCompletionMessageParam[] {
    const result: OpenAI.ChatCompletionMessageParam[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'system') {
        result.push({ role: 'system', content: msg.content });
      } else if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId ?? '',
          content: msg.content,
        });
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          })),
        });
      } else {
        result.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): OpenAI.ChatCompletionTool[] {
    return tools.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  private parseResponse(response: OpenAI.ChatCompletion): LLMResponse {
    const choice = response.choices[0];
    if (!choice) {
      return { content: '', finishReason: 'error' };
    }

    const msg = choice.message;
    const toolCalls = msg.tool_calls?.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: JSON.parse(tc.function.arguments) as Record<string, unknown>,
    }));

    const finishReason = choice.finish_reason === 'tool_calls' ? 'tool_use' as const
      : choice.finish_reason === 'length' ? 'max_tokens' as const
      : 'stop' as const;

    return {
      content: msg.content ?? '',
      toolCalls: toolCalls?.length ? toolCalls : undefined,
      usage: response.usage ? {
        inputTokens: response.usage.prompt_tokens,
        outputTokens: response.usage.completion_tokens,
      } : undefined,
      finishReason,
    };
  }
}
