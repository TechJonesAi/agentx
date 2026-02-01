import { BaseLLMProvider } from './base.js';
import { createLogger } from '../logger.js';
import type { LLMRequestOptions, LLMResponse, Message, ToolDefinition, StreamCallbacks } from '../types.js';

const log = createLogger('llm:ollama');

interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

interface OllamaChatResponse {
  message: { role: string; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  prompt_eval_count?: number;
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

  async complete(options: LLMRequestOptions): Promise<LLMResponse> {
    const messages = this.convertMessages(options.messages, options.systemPrompt);

    log.debug({ messageCount: messages.length, model: this.model }, 'Sending request to Ollama');

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as OllamaChatResponse;

    return {
      content: data.message.content,
      finishReason: 'stop',
      usage: data.eval_count ? {
        inputTokens: data.prompt_eval_count ?? 0,
        outputTokens: data.eval_count,
      } : undefined,
    };
  }

  async completeStream(options: LLMRequestOptions, callbacks: StreamCallbacks): Promise<LLMResponse> {
    const messages = this.convertMessages(options.messages, options.systemPrompt);

    log.debug({ messageCount: messages.length, model: this.model }, 'Starting streaming request to Ollama');

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    let content = '';
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
          } catch {
            // Skip malformed lines
          }
        }
      }
    }

    const result: LLMResponse = {
      content,
      finishReason: 'stop',
    };

    if (callbacks.onComplete) {
      callbacks.onComplete(result);
    }

    return result;
  }

  private convertMessages(messages: Message[], systemPrompt?: string): OllamaChatMessage[] {
    const result: OllamaChatMessage[] = [];

    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    for (const msg of messages) {
      if (msg.role === 'tool') {
        result.push({ role: 'user', content: `[Tool Result]: ${msg.content}` });
      } else if (msg.role === 'system' || msg.role === 'user' || msg.role === 'assistant') {
        result.push({ role: msg.role, content: msg.content });
      }
    }

    return result;
  }
}
