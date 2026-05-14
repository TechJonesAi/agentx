import type { LLMProvider } from '../types.js';
import type { AgentConfig } from '../types.js';
import { BaseLLMProvider } from './base.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import { resolveOllamaModel } from './resolve-ollama-model.js';

export { BaseLLMProvider, AnthropicProvider, OpenAIProvider, OllamaProvider };
export { resolveOllamaModel } from './resolve-ollama-model.js';
export type { OllamaModelResolution } from './resolve-ollama-model.js';

export function createProvider(providerName: LLMProvider, config: AgentConfig): BaseLLMProvider {
  // Batch A2 — Private-memory-first / localOnly enforcement.
  // When localOnly=true, cloud providers refuse to initialise. The agent
  // either succeeds with a local provider (ollama) or fails honestly at
  // construction time. We DO NOT silently substitute providers.
  if (config.agent.localOnly === true && (providerName === 'anthropic' || providerName === 'openai')) {
    throw new Error(
      `localOnly is enabled — refusing to initialise cloud provider "${providerName}". ` +
      `Set agent.defaultProvider="ollama" or AGENT_DEFAULT_PROVIDER=ollama. ` +
      `(Set agent.localOnly=false / AGENTX_LOCAL_ONLY=false to permit cloud providers.)`,
    );
  }
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
      // Resolve model name through the documented priority order
      // (OLLAMA_MODEL env → routing.json forceModel → config → default).
      // This is the ONLY behaviour change in createProvider for ollama;
      // anthropic/openai branches are untouched.
      const pc = config.providers.ollama;
      const resolved = resolveOllamaModel(pc?.model);
      return new OllamaProvider(resolved.model, pc?.baseUrl);
    }
    default:
      throw new Error(`Unknown LLM provider: ${providerName}`);
  }
}
