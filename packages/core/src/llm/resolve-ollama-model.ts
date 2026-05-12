/**
 * Resolve which Ollama model the OllamaProvider should target.
 *
 * Live audit (commit af871e6) caught that:
 *   - /api/agent/provider/status correctly probes routing.json `forceModel`
 *     and reports the installed model
 *   - but the OllamaProvider was constructed with config.providers.ollama.model
 *     which is "llama3" in config/default.yaml — NOT installed on the user's
 *     box (13 other Ollama models are installed)
 *   - select-local-model wrote forceModel:"qwen2.5-coder:32b" to routing.json
 *     but the chat path never read it
 *
 * Resolution order (highest priority first):
 *   1. OLLAMA_MODEL env var — single explicit override for runtime use
 *   2. routing.json `forceModel` — persisted user pick from
 *      /api/agent/provider/select-local-model (Strategy 3)
 *   3. config.providers.ollama.model — the value declared in
 *      config/default.yaml or ~/.agentx/config.yaml
 *   4. 'llama3' — final fallback (preserves pre-resolver default)
 *
 * The resolver is pure — it reads env + filesystem once, no caching, no
 * side effects, no auto-download. When called by createProvider() during
 * Agent construction, it picks whichever model is actually configured by
 * the most explicit signal.
 *
 * NOTE: this resolver does NOT verify that the chosen model is installed
 * on Ollama. Use `/api/agent/provider/status` for liveness + presence
 * checks. Resolution is a config-layer concern; install-state checks live
 * in the route layer where they can do an http probe.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import { resolveDataDir } from '../config.js';

const log = createLogger('llm:resolve-ollama-model');

export interface OllamaModelResolution {
  model: string;
  /** Where the value came from — for logging and diagnostics. */
  source: 'env' | 'routing.json' | 'config' | 'default';
}

/**
 * Resolve the Ollama model name using the documented priority order.
 *
 * @param configModel  The model configured in config.providers.ollama.model
 *                     (from the yaml/json config file load).
 * @param opts.dataDir Override for tests; defaults to resolveDataDir()
 *                     so production picks up ~/.agentx/routing.json.
 */
export function resolveOllamaModel(
  configModel?: string,
  opts: { dataDir?: string } = {},
): OllamaModelResolution {
  // 1. env override
  const envModel = process.env['OLLAMA_MODEL'];
  if (typeof envModel === 'string' && envModel.trim().length > 0) {
    return { model: envModel.trim(), source: 'env' };
  }

  // 2. routing.json forceModel
  const dataDir = opts.dataDir ?? resolveDataDir();
  const routingPath = path.join(dataDir, 'routing.json');
  if (fs.existsSync(routingPath)) {
    try {
      const raw = fs.readFileSync(routingPath, 'utf-8');
      const parsed = JSON.parse(raw) as { forceModel?: string };
      if (typeof parsed.forceModel === 'string' && parsed.forceModel.trim().length > 0) {
        const fm = parsed.forceModel.trim();
        log.info({ model: fm, source: 'routing.json' },
          'Ollama model overridden by routing.json forceModel');
        return { model: fm, source: 'routing.json' };
      }
    } catch (err) {
      log.warn({ err: (err as Error).message, routingPath },
        'Failed to parse routing.json — falling back to config');
    }
  }

  // 3. config model
  if (typeof configModel === 'string' && configModel.trim().length > 0) {
    return { model: configModel.trim(), source: 'config' };
  }

  // 4. final fallback — preserves the OllamaProvider's pre-resolver default
  return { model: 'llama3', source: 'default' };
}
