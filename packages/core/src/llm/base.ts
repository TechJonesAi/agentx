import type { LLMRequestOptions, LLMResponse, StreamCallbacks } from '../types.js';

export abstract class BaseLLMProvider {
  abstract readonly name: string;

  abstract complete(options: LLMRequestOptions): Promise<LLMResponse>;

  /**
   * Streaming completion — calls onToken for each text chunk.
   * Default implementation falls back to non-streaming complete().
   */
  async completeStream(options: LLMRequestOptions, callbacks: StreamCallbacks): Promise<LLMResponse> {
    // Default: fall back to non-streaming
    const response = await this.complete(options);
    if (callbacks.onToken && response.content) {
      callbacks.onToken(response.content);
    }
    if (callbacks.onComplete) {
      callbacks.onComplete(response);
    }
    return response;
  }

  abstract isConfigured(): boolean;
}
