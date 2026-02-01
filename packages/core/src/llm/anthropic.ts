import Anthropic from '@anthropic-ai/sdk';
import { BaseLLMProvider } from './base.js';
import { createLogger } from '../logger.js';
import type { LLMRequestOptions, LLMResponse, Message, ToolDefinition, StreamCallbacks } from '../types.js';

const log = createLogger('llm:anthropic');

export class AnthropicProvider extends BaseLLMProvider {
  readonly name = 'anthropic';
  private client: Anthropic | null = null;
  private model: string;
  private maxTokens: number;

  constructor(model?: string, maxTokens?: number) {
    super();
    this.model = model ?? 'claude-sonnet-4-20250514';
    this.maxTokens = maxTokens ?? 4096;
  }

  isConfigured(): boolean {
    return !!process.env['ANTHROPIC_API_KEY'];
  }

  private getClient(): Anthropic {
    if (!this.client) {
      this.client = new Anthropic();
    }
    return this.client;
  }

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const client = this.getClient();

    const messages = this.convertMessages(options.messages);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    log.debug({ messageCount: messages.length }, 'Sending request to Anthropic');

    const response = await client.messages.create({
      model: this.model,
      max_tokens: options.maxTokens ?? this.maxTokens,
      system: options.systemPrompt ?? '',
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    return this.parseResponse(response);
  }

  async completeStream(options: LLMRequestOptions, callbacks: StreamCallbacks): Promise<LLMResponse> {
    const client = this.getClient();

    const messages = this.convertMessages(options.messages);
    const tools = options.tools ? this.convertTools(options.tools) : undefined;

    log.debug({ messageCount: messages.length }, 'Starting streaming request to Anthropic');

    const stream = client.messages.stream({
      model: this.model,
      max_tokens: options.maxTokens ?? this.maxTokens,
      system: options.systemPrompt ?? '',
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
    });

    stream.on('text', (text) => {
      if (callbacks.onToken) {
        callbacks.onToken(text);
      }
    });

    const finalMessage = await stream.finalMessage();
    const response = this.parseResponse(finalMessage);

    if (response.toolCalls) {
      for (const tc of response.toolCalls) {
        if (callbacks.onToolCall) {
          callbacks.onToolCall(tc);
        }
      }
    }

    if (callbacks.onComplete) {
      callbacks.onComplete(response);
    }

    return response;
  }

  private convertMessages(messages: Message[]): Anthropic.MessageParam[] {
    const result: Anthropic.MessageParam[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') continue;

      if (msg.role === 'tool') {
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId ?? '',
              content: msg.content,
            },
          ],
        });
      } else if (msg.role === 'assistant' && msg.toolCalls?.length) {
        const content: Anthropic.ContentBlockParam[] = [];
        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }
        for (const tc of msg.toolCalls) {
          content.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        result.push({ role: 'assistant', content });
      } else {
        result.push({
          role: msg.role as 'user' | 'assistant',
          content: msg.content,
        });
      }
    }

    return result;
  }

  private convertTools(tools: ToolDefinition[]): Anthropic.Tool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool['input_schema'],
    }));
  }

  private parseResponse(response: Anthropic.Message): LLMResponse {
    let content = '';
    const toolCalls: LLMResponse['toolCalls'] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        content += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: block.input as Record<string, unknown>,
        });
      }
    }

    const finishReason = response.stop_reason === 'tool_use' ? 'tool_use' as const
      : response.stop_reason === 'max_tokens' ? 'max_tokens' as const
      : 'stop' as const;

    return {
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
      finishReason,
    };
  }
}
