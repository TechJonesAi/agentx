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

  return deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, fileConfig as unknown as Record<string, unknown>) as unknown as AgentConfig;
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
