import type { LLMProvider } from '../types.js';
import type { AgentConfig } from '../types.js';
import { BaseLLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';

export { BaseLLMProvider, AnthropicProvider, OpenAIProvider, OllamaProvider };

export function createProvider(providerName: LLMProvider, config: AgentConfig): BaseLLMProvider {
  switch (providerName) {
    case 'anthropic': {
      const pc = config.providers.anthropic;
      return new AnthropicProvider(pc?.model, pc?.maxTokens);
    }
    case 'openai': {
      const pc = config.providers.openai;
      return new OpenAIProvider(pc?.model, pc?.maxTokens);
    }
    case 'ollama': {
      const pc = config.providers.ollama;
      return new OllamaProvider(pc?.model, pc?.baseUrl);
    }
    default:
      throw new Error(`Unknown LLM provider: ${providerName}`);
  }
}
