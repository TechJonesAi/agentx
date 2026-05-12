/**
 * Routing config — persisted slice of the runtime model-routing policy.
 *
 * Stored at `~/.agentx/routing.json` (separate from the main config.{yaml,json}
 * so the UI can write it without rewriting the whole config). This file is
 * read on demand by `GET /api/models/routing` and written by `POST /api/models/routing`
 * via Strategy-3 — no `agent.ts` instantiation needed.
 *
 * The shape mirrors `RoutingPolicyConfig` but is serialisable JSON.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../logger.js';
import {
  type RoutingPolicyConfig,
  DEFAULT_ROUTING_POLICY_CONFIG,
} from './routing-policy.js';
import type { RoutingMode } from './model-registry.js';

const log = createLogger('llm:routing-config');

export const ROUTING_CONFIG_FILENAME = 'routing.json';

const ALLOWED_MODES: ReadonlyArray<RoutingMode> = ['LOCAL_ONLY', 'COMBINATION', 'SUBSCRIPTION_ONLY'];

/** Load the routing config, returning defaults when the file is missing/bad. */
export function loadRoutingConfig(dataDir: string): RoutingPolicyConfig {
  const configPath = path.join(dataDir, ROUTING_CONFIG_FILENAME);
  if (!fs.existsSync(configPath)) {
    return { ...DEFAULT_ROUTING_POLICY_CONFIG };
  }
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<RoutingPolicyConfig>;
    return {
      ...DEFAULT_ROUTING_POLICY_CONFIG,
      ...parsed,
      // Defensive copy
      capabilityPins: parsed.capabilityPins ? { ...parsed.capabilityPins } : undefined,
    };
  } catch (err) {
    log.warn({ err: (err as Error).message, configPath }, 'Failed to parse routing.json — using defaults');
    return { ...DEFAULT_ROUTING_POLICY_CONFIG };
  }
}

/** Persist atomically (tmp + rename). */
export function saveRoutingConfig(dataDir: string, config: RoutingPolicyConfig): void {
  const configPath = path.join(dataDir, ROUTING_CONFIG_FILENAME);
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${configPath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmp, configPath);
  log.info({ configPath }, 'Routing config saved');
}

export interface RoutingConfigValidation {
  ok: boolean;
  errors: string[];
  /** Normalised, safe-to-persist value (only set when ok). */
  value?: RoutingPolicyConfig;
}

/**
 * Validate + normalise a candidate routing config from untrusted input
 * (e.g. POST body). Unknown fields are dropped; numeric fields are clamped
 * to sensible ranges; the `mode` enum is required.
 */
export function validateRoutingConfig(input: unknown): RoutingConfigValidation {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') {
    return { ok: false, errors: ['body must be a JSON object'] };
  }
  const obj = input as Record<string, unknown>;

  // mode (required)
  const mode = obj['mode'];
  if (typeof mode !== 'string' || !ALLOWED_MODES.includes(mode as RoutingMode)) {
    errors.push(`mode must be one of: ${ALLOWED_MODES.join(', ')}`);
  }

  // capabilityPins (optional object<string, string>)
  let capabilityPins: Record<string, string> | undefined;
  if (obj['capabilityPins'] !== undefined) {
    const cp = obj['capabilityPins'];
    if (!cp || typeof cp !== 'object' || Array.isArray(cp)) {
      errors.push('capabilityPins must be an object of {capability: modelId}');
    } else {
      capabilityPins = {};
      for (const [k, v] of Object.entries(cp as Record<string, unknown>)) {
        if (typeof v === 'string' && v.trim().length > 0) {
          capabilityPins[k] = v.trim();
        }
      }
    }
  }

  // forceModel (optional string|null)
  let forceModel: string | null | undefined;
  if (obj['forceModel'] !== undefined) {
    const fm = obj['forceModel'];
    if (fm === null || fm === '' || fm === 'auto') forceModel = null;
    else if (typeof fm === 'string') forceModel = fm.trim();
    else errors.push('forceModel must be a string or null');
  }

  // numeric clamps
  function num(field: string, min: number, max: number): number | undefined {
    const v = obj[field];
    if (v === undefined) return undefined;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`${field} must be a finite number`);
      return undefined;
    }
    return Math.max(min, Math.min(max, v));
  }
  const maxLocalFailuresBeforeCloud = num('maxLocalFailuresBeforeCloud', 1, 100);
  const latencySensitiveThresholdMs = num('latencySensitiveThresholdMs', 50, 60_000);
  const contextOverflowTokens = num('contextOverflowTokens', 1_000, 1_000_000);

  // booleans
  let allowCloudForLatencySensitiveTasks: boolean | undefined;
  if (obj['allowCloudForLatencySensitiveTasks'] !== undefined) {
    if (typeof obj['allowCloudForLatencySensitiveTasks'] !== 'boolean') {
      errors.push('allowCloudForLatencySensitiveTasks must be boolean');
    } else {
      allowCloudForLatencySensitiveTasks = obj['allowCloudForLatencySensitiveTasks'] as boolean;
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const value: RoutingPolicyConfig = {
    mode: mode as RoutingMode,
  };
  if (capabilityPins) value.capabilityPins = capabilityPins;
  if (forceModel !== undefined) value.forceModel = forceModel;
  if (maxLocalFailuresBeforeCloud !== undefined) value.maxLocalFailuresBeforeCloud = maxLocalFailuresBeforeCloud;
  if (latencySensitiveThresholdMs !== undefined) value.latencySensitiveThresholdMs = latencySensitiveThresholdMs;
  if (contextOverflowTokens !== undefined) value.contextOverflowTokens = contextOverflowTokens;
  if (allowCloudForLatencySensitiveTasks !== undefined) {
    value.allowCloudForLatencySensitiveTasks = allowCloudForLatencySensitiveTasks;
  }

  return { ok: true, errors: [], value };
}

/**
 * Probe the local Ollama server for installed models. Returns an empty list
 * (and reachable=false) when Ollama isn't running — never throws.
 *
 * `host` defaults to `OLLAMA_HOST` env or `http://127.0.0.1:11434`.
 */
export interface OllamaProbeResult {
  reachable: boolean;
  models: Array<{ name: string; size?: number }>;
  host: string;
}

export async function probeOllamaModels(opts: { host?: string; timeoutMs?: number } = {}): Promise<OllamaProbeResult> {
  const host = opts.host ?? process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';
  const timeoutMs = opts.timeoutMs ?? 5000;
  try {
    const resp = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!resp.ok) return { reachable: false, models: [], host };
    const data = await resp.json() as { models?: Array<{ name?: string; size?: number }> };
    const models = (data?.models ?? [])
      .filter((m): m is { name: string; size?: number } => typeof m?.name === 'string')
      .map((m) => ({ name: m.name, size: typeof m.size === 'number' ? m.size : undefined }));
    return { reachable: true, models, host };
  } catch {
    return { reachable: false, models: [], host };
  }
}
