import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse as parseYaml } from 'yaml';
import { config as loadDotenv } from 'dotenv';
import type { AgentConfig } from './types.js';

const DEFAULT_CONFIG: AgentConfig = {
  agent: {
    name: 'AgentX',
    defaultProvider: 'anthropic',
    model: 'claude-sonnet-4-20250514',
  },
  providers: {
    anthropic: { model: 'claude-sonnet-4-20250514', maxTokens: 4096 },
    openai: { model: 'gpt-4o', maxTokens: 4096 },
    ollama: { model: 'llama3', baseUrl: 'http://localhost:11434' },
  },
  memory: {
    maxConversationHistory: 100,
    summarizeAfter: 50,
    embeddingProvider: 'local',
  },
  sessions: {
    persistToDisk: true,
    ttlMinutes: 1440,
    dmScope: 'main',
    mainKey: 'main',
    identityLinks: {},
    reset: { mode: 'idle', idleMinutes: 120 },
    resetByType: {
      dm: { mode: 'idle', idleMinutes: 240 },
      group: { mode: 'idle', idleMinutes: 120 },
      thread: { mode: 'daily', atHour: 4 },
    },
    resetTriggers: ['/new', '/reset'],
    sendPolicy: {
      rules: [],
      default: 'allow',
    },
    pruning: {
      enabled: true,
      maxToolResultAge: 30,
      keepLastNToolResults: 5,
    },
    compaction: {
      enabled: true,
      threshold: 0.8,
      autoFlushMemory: true,
    },
    store: '~/.agentx/agents/{agentId}/sessions/sessions.json',
  },
  skills: {
    directory: path.join(os.homedir(), '.agentx', 'skills'),
    autoReload: true,
  },
  browser: {
    headless: true,
    timeout: 30000,
  },
  voice: {
    ttsProvider: 'elevenlabs',
    sttProvider: 'whisper',
    whisperModel: 'base',
  },
  scheduler: {
    enabled: false,
    heartbeatIntervalMinutes: 60,
  },
  security: {
    sandboxShell: false,
    shellPermissionLevel: 'ask-confirm',
    maxShellTimeout: 30000,
    encryptStorage: false,
    auditLog: true,
    auditRetentionDays: 90,
    localAuth: false,
    autoLockMinutes: 30,
    multiUserMode: false,
    requireOwnerApproval: true,
    ownerPlatformId: '',
  },
  health: {
    enabled: false,
    port: 9090,
  },
};

export function resolveDataDir(): string {
  const envDir = process.env['DATA_DIR'];
  if (envDir) {
    return envDir.replace(/^~/, os.homedir());
  }
  return path.join(os.homedir(), '.agentx');
}

export function loadConfig(configPath?: string): AgentConfig {
  loadDotenv();

  let fileConfig: Partial<AgentConfig> = {};

  const paths = configPath
    ? [configPath]
    : [
        path.join(process.cwd(), 'config', 'default.yaml'),
        path.join(process.cwd(), 'config', 'default.json'),
        path.join(resolveDataDir(), 'config.yaml'),
        path.join(resolveDataDir(), 'config.json'),
      ];

  for (const p of paths) {
    if (fs.existsSync(p)) {
      const raw = fs.readFileSync(p, 'utf-8');
      if (p.endsWith('.yaml') || p.endsWith('.yml')) {
        fileConfig = parseYaml(raw) as Partial<AgentConfig>;
      } else {
        fileConfig = JSON.parse(raw) as Partial<AgentConfig>;
      }
      break;
    }
  }

  const merged = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, fileConfig as unknown as Record<string, unknown>) as unknown as AgentConfig;
  return applyEnvOverrides(merged);
}

/**
 * R8: parse a string env value as a boolean. Recognised forms (case-insensitive,
 * trimmed): true | 1 | yes | on  → true; false | 0 | no | off → false.
 * Anything else (including empty, whitespace, "maybe") returns undefined —
 * the caller treats undefined as "no override, use config value" so invalid
 * env values fail closed: a feature that's `false` in config stays `false`.
 */
export function parseBoolEnv(raw: string | undefined): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  const v = String(raw).toLowerCase().trim();
  if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
  if (v === 'false' || v === '0' || v === 'no' || v === 'off') return false;
  return undefined;
}

/**
 * R8: apply environment-variable overrides for selected feature flags.
 *   - AGENT_RETRIEVAL_ENABLED        → agent.retrieval.enabled
 *   - AGENT_ENTITY_INDEXING_ENABLED  → agent.entityIndexing.enabled
 * Invalid values are ignored (config-file value wins).
 */
export function applyEnvOverrides(config: AgentConfig): AgentConfig {
  // AGENT_DEFAULT_PROVIDER — env override for agent.defaultProvider so
  // users can switch to local Ollama without editing config.yaml.
  // Accepted values: 'anthropic' | 'openai' | 'ollama'. Other values
  // are ignored (config-file value wins).
  const providerEnv = process.env['AGENT_DEFAULT_PROVIDER'];
  if (providerEnv === 'anthropic' || providerEnv === 'openai' || providerEnv === 'ollama') {
    config.agent.defaultProvider = providerEnv;
  }
  const retrievalEnv = parseBoolEnv(process.env['AGENT_RETRIEVAL_ENABLED']);
  if (retrievalEnv !== undefined) {
    if (!config.agent.retrieval) config.agent.retrieval = { enabled: false };
    config.agent.retrieval.enabled = retrievalEnv;
  }
  const entityEnv = parseBoolEnv(process.env['AGENT_ENTITY_INDEXING_ENABLED']);
  if (entityEnv !== undefined) {
    if (!config.agent.entityIndexing) config.agent.entityIndexing = { enabled: false };
    config.agent.entityIndexing.enabled = entityEnv;
  }
  // Batch A2 — Private-memory-first enforcement flag.
  // AGENTX_LOCAL_ONLY=true → cloud providers + network-class tools rejected.
  const localOnlyEnv = parseBoolEnv(process.env['AGENTX_LOCAL_ONLY']);
  if (localOnlyEnv !== undefined) {
    config.agent.localOnly = localOnlyEnv;
  }
  return config;
}

function deepMerge(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    const sourceVal = source[key];
    const targetVal = target[key];
    if (
      sourceVal &&
      typeof sourceVal === 'object' &&
      !Array.isArray(sourceVal) &&
      targetVal &&
      typeof targetVal === 'object' &&
      !Array.isArray(targetVal)
    ) {
      result[key] = deepMerge(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else if (sourceVal !== undefined) {
      result[key] = sourceVal;
    }
  }
  return result;
}

export function ensureDataDir(): string {
  const dir = resolveDataDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}
