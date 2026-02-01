import { describe, it, expect, vi } from 'vitest';
import { BaseLLMProvider } from '../../src/llm/base.js';
import type { LLMRequestOptions, LLMResponse, StreamCallbacks } from '../../src/types.js';

/**
 * Tests for LLM provider abstraction layer.
 * Uses a mock provider to verify the base class contract without hitting real APIs.
 */

class MockProvider extends BaseLLMProvider {
  readonly name = 'mock';
  private responses: LLMResponse[];
  private callIndex = 0;

  constructor(responses: LLMResponse[]) {
    super();
    this.responses = responses;
  }

  async complete(_options: LLMRequestOptions): Promise<LLMResponse> {
    const response = this.responses[this.callIndex % this.responses.length]!;
    this.callIndex++;
    return response;
  }

  isConfigured(): boolean {
    return true;
  }
}

describe('BaseLLMProvider', () => {
  it('implements complete() contract', async () => {
    const provider = new MockProvider([
      { content: 'Hello!', finishReason: 'stop' },
    ]);

    const response = await provider.complete({
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    });

    expect(response.content).toBe('Hello!');
    expect(response.finishReason).toBe('stop');
  });

  it('completeStream() falls back to non-streaming when not overridden', async () => {
    const provider = new MockProvider([
      { content: 'Streamed response', finishReason: 'stop' },
    ]);

    const tokens: string[] = [];
    let completed = false;

    const callbacks: StreamCallbacks = {
      onToken: (token) => tokens.push(token),
      onComplete: () => { completed = true; },
    };

    const response = await provider.completeStream({
      messages: [{ role: 'user', content: 'Hi', timestamp: Date.now() }],
    }, callbacks);

    expect(response.content).toBe('Streamed response');
    // Base class fallback sends full content as one token
    expect(tokens).toEqual(['Streamed response']);
    expect(completed).toBe(true);
  });

  it('handles tool calls in response', async () => {
    const provider = new MockProvider([{
      content: '',
      finishReason: 'tool_use',
      toolCalls: [{
        id: 'tc1',
        name: 'search',
        arguments: { query: 'weather' },
      }],
    }]);

    const response = await provider.complete({
      messages: [{ role: 'user', content: 'Search for weather', timestamp: Date.now() }],
    });

    expect(response.finishReason).toBe('tool_use');
    expect(response.toolCalls).toHaveLength(1);
    expect(response.toolCalls![0]!.name).toBe('search');
  });

  it('handles multiple response turns', async () => {
    const provider = new MockProvider([
      { content: '', finishReason: 'tool_use', toolCalls: [{ id: 'tc1', name: 'search', arguments: {} }] },
      { content: 'The weather is sunny.', finishReason: 'stop' },
    ]);

    const first = await provider.complete({
      messages: [{ role: 'user', content: 'Weather?', timestamp: Date.now() }],
    });
    expect(first.finishReason).toBe('tool_use');

    const second = await provider.complete({
      messages: [
        { role: 'user', content: 'Weather?', timestamp: Date.now() },
        { role: 'assistant', content: '', toolCalls: first.toolCalls, timestamp: Date.now() },
        { role: 'tool', content: 'Sunny, 72F', toolCallId: 'tc1', timestamp: Date.now() },
      ],
    });
    expect(second.content).toBe('The weather is sunny.');
    expect(second.finishReason).toBe('stop');
  });
});
