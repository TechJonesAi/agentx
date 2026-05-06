/**
 * LLM Model Registry — Tracks registered models and their capabilities.
 * Supports capability-based lookup and Ollama model discovery.
 */

import { createLogger } from '../logger.js';

const log = createLogger('llm:registry');

export type RoutingMode = 'LOCAL_ONLY' | 'COMBINATION' | 'SUBSCRIPTION_ONLY';
export type ModelCapability = 'text' | 'code' | 'reasoning' | 'vision' | 'speech';
export type ModelSpecialization = string;
export type PrivacyLevel = 'local' | 'cloud';

export interface RegisteredModel {
  id: string;
  provider: string;
  capabilities: ModelCapability[];
  privacyLevel: PrivacyLevel;
}

export interface OllamaModelEntry {
  id: string;
  name: string;
  size: number;
}

export const CAPABILITY_CHAINS: Record<ModelCapability, ModelCapability[]> = {
  text: ['text'],
  code: ['code', 'text'],
  reasoning: ['reasoning', 'code', 'text'],
  vision: ['vision'],
  speech: ['speech'],
};

/**
 * Known model → capability mappings.
 * Used to auto-assign capabilities when models are discovered from Ollama.
 */
const MODEL_CAPABILITY_MAP: Record<string, ModelCapability[]> = {
  'qwen3-coder:30b': ['code', 'text'],
  'qwen2.5-coder:32b': ['code', 'text'],
  'codestral:22b': ['code', 'text'],
  'deepseek-coder-v2:16b': ['code', 'text'],
  'llama3.1:70b-32k': ['reasoning', 'code', 'text'],
  'llama3.1:70b': ['reasoning', 'code', 'text'],
  // New (April 2026) — tool-call specialist from Salesforce research.
  // BFCL-leader open weights; shines on function-call formatting + parallel
  // tool calls. Good escalation target for the `code` chain when
  // tool-use misses are detected.
  'robbiemu/Salesforce_Llama-xLAM-2:8b-fc-r-q5_K_M': ['code', 'text'],
  // New (April 2026) — Meta's Llama 3.3 70B (instruct, q4_K_M). 405B-class
  // quality at 70B, native parallel-call format. Replaces llama3.1:70b-32k
  // as the reasoning primary.
  'llama3.3:70b-instruct-q4_K_M': ['reasoning', 'code', 'text'],
  // New (April 2026) — Qwen3 30B-A3B MoE instruct (July 2025 release, q4).
  // 256k context, A3B active params → fast planner. Replaces qwen3:14b.
  'qwen3:30b-a3b-instruct-2507-q4_K_M': ['text', 'reasoning'],
  'qwen3:14b': ['text', 'reasoning'],
  'llama3.1:8b': ['text'],
  'qwen3-vl:32b': ['vision', 'text'],
};

export class LLMModelRegistry {
  private models: RegisteredModel[] = [];

  seedFromConfig(_providers: Record<string, unknown>): void {
    // Minimal: just mark that we have providers
  }

  register(model: RegisteredModel): void {
    // Deduplicate by id
    const existing = this.models.findIndex(m => m.id === model.id);
    if (existing >= 0) {
      this.models[existing] = model;
    } else {
      this.models.push(model);
    }
    log.debug({ id: model.id, capabilities: model.capabilities }, 'Model registered');
  }

  list(): RegisteredModel[] {
    return this.models;
  }

  getModels(): RegisteredModel[] {
    return this.models;
  }

  async discoverOllamaModels(): Promise<void> {
    // Stub — no-op discovery
  }

  seedFromOllamaModels(models: OllamaModelEntry[]): void {
    for (const m of models) {
      const capabilities = MODEL_CAPABILITY_MAP[m.name] ?? inferCapabilities(m.name);
      this.register({
        id: m.name,
        provider: 'ollama',
        capabilities,
        privacyLevel: 'local',
      });
    }
    log.info({ count: models.length }, 'Seeded models from Ollama');
  }

  getModelsByCapability(capability: ModelCapability): RegisteredModel[] {
    return this.models.filter(m => m.capabilities.includes(capability));
  }
}

/**
 * Infer capabilities from model name when not in the known map.
 */
function inferCapabilities(name: string): ModelCapability[] {
  const lower = name.toLowerCase();
  if (lower.includes('coder') || lower.includes('codestral') || lower.includes('deepseek-coder')) {
    return ['code', 'text'];
  }
  if (lower.includes('vl') || lower.includes('vision')) {
    return ['vision', 'text'];
  }
  if (/\b(70b|72b|110b)\b/.test(lower)) {
    return ['reasoning', 'code', 'text'];
  }
  return ['text'];
}
