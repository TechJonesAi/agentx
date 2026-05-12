/**
 * BuilderV2 Adapter — bridges the dashboard's /api/builder/run requests
 * to the BuilderV2 pipeline.
 *
 * Design (additive, no agent.ts changes):
 *   1. Build a Builder2LLM shim using createProvider() from @agentx/core,
 *      driven by the live agent config. This gives BuilderV2 access to
 *      whichever provider the user has selected (anthropic / openai /
 *      ollama) without coupling to agent.provider (which has no public
 *      getter).
 *   2. Define `runBuild()` that instantiates BuilderV2, runs the build,
 *      and persists the resulting BuildSession's generated files as
 *      rows in `build_artifacts`. The agentx.db schema already has the
 *      table (verified pre-batch).
 *   3. Tests inject a mock `Builder2LLM` via `setBuilderLlmForTesting()`
 *      so CI doesn't need a live LLM.
 *
 * Worktree: builds land under /Users/darrenjones/Projects/AGENTX_APPS
 * by default (per FEEDBACK memory). Override with `workspace` field.
 *
 * Note: when the chosen provider can't authenticate (missing API key),
 * the build will throw inside BuilderV2.build() and the queue surfaces
 * the failure with the categorised error string. We do NOT pre-fail
 * the route — the queue gives us the build id + status path so the UI
 * can surface the failure honestly.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { createLogger, createProvider } from '@agentx/core';
import type { Builder2LLM, BuildSession } from '@agentx/builder-v2';
import { BuilderV2 } from '@agentx/builder-v2';

const log = createLogger('web:builder-adapter');

/** Default workspace root — per user memory, all builds go here. */
export const DEFAULT_WORKSPACE_ROOT = path.join(os.homedir(), 'Projects', 'AGENTX_APPS');

let testLlmOverride: Builder2LLM | null = null;

/** TEST ONLY — install a mock Builder2LLM. */
export function setBuilderLlmForTesting(llm: Builder2LLM): void {
  testLlmOverride = llm;
}
/** TEST ONLY — clear the mock. */
export function clearBuilderLlmForTesting(): void {
  testLlmOverride = null;
}

interface AgentLike {
  getConfig(): {
    agent: { defaultProvider: string; model?: string };
    providers?: Record<string, { model?: string; baseUrl?: string; maxTokens?: number }>;
  };
  getDatabase?: () => DbHandle;
}

interface DbHandle {
  prepare(sql: string): { run(...a: unknown[]): { changes?: number } };
  exec?(sql: string): void;
}

/**
 * Construct a Builder2LLM bound to the agent's current provider.
 * Calls createProvider() per build (cheap — providers are thin wrappers).
 */
function buildLlmFromAgent(agent: AgentLike): Builder2LLM {
  if (testLlmOverride) return testLlmOverride;
  const cfg = agent.getConfig();
  const providerId = cfg.agent.defaultProvider as 'anthropic' | 'openai' | 'ollama';
  const provider = createProvider(providerId, cfg as never);
  return {
    async complete(request) {
      const messages = request.messages.map((m) => ({
        role: m.role as 'user' | 'assistant' | 'system',
        content: m.content,
        timestamp: Date.now(),
      }));
      try {
        const resp = await provider.complete({
          messages,
          systemPrompt: request.systemPrompt,
          maxTokens: request.maxTokens,
          temperature: request.temperature,
        });
        return {
          content: resp.content,
          finishReason: (resp.finishReason === 'max_tokens' ? 'length' : 'stop') as 'stop' | 'length' | 'error',
        };
      } catch (err) {
        return {
          content: '',
          finishReason: 'error',
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

export interface RunBuildOptions {
  appName?: string;
  prompt: string;
  platform?: string;
  workspace?: string;
  /** Optional caller-supplied session id. When provided, the adapter
   *  uses it as both the BuildSession id and the build_artifacts.build_id
   *  so the dashboard can correlate the queue id with persisted artifacts. */
  sessionId?: string;
}

export interface BuildRunResult {
  sessionId: string;
  appName: string;
  workspace: string;
  status: BuildSession['status'];
  generatedFileCount: number;
  artifactCount: number;
  startedAt: number;
  completedAt: number;
  durationMs: number;
  /** Compact log tail (last 50 entries) */
  logs: Array<{ ts: number; level: string; stage: string; message: string }>;
  /** Final result from BuildValidator if any */
  buildOk?: boolean;
  buildErrors?: string[];
}

/**
 * Run a single build via BuilderV2 and persist generated files +
 * artifact rows. Returns a compact summary suitable for the dashboard.
 */
export async function runBuild(agent: AgentLike, opts: RunBuildOptions): Promise<BuildRunResult> {
  const sessionId = opts.sessionId ?? `build-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const appName = (opts.appName ?? '').trim() || `app-${sessionId.slice(-8)}`;
  const workspaceRoot = opts.workspace?.trim() || DEFAULT_WORKSPACE_ROOT;
  const workspace = path.join(workspaceRoot, `${sessionId}-${appName.replace(/[^A-Za-z0-9._-]/g, '_')}`);

  if (!fs.existsSync(workspace)) {
    fs.mkdirSync(workspace, { recursive: true });
  }

  log.info({ sessionId, appName, workspace }, 'Starting BuilderV2 run');

  const llm = buildLlmFromAgent(agent);
  const builder = new BuilderV2(llm, workspace);
  const startedAt = Date.now();
  const session = await builder.build(opts.prompt, appName, opts.platform);
  const completedAt = Date.now();

  // Persist generated files to workspace.
  let writtenCount = 0;
  for (const [relPath, file] of session.generatedFiles.entries()) {
    try {
      const absPath = path.join(workspace, relPath);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      const content = (file as { content?: string }).content ?? '';
      fs.writeFileSync(absPath, content, 'utf-8');
      writtenCount++;
    } catch (err) {
      log.warn({ err: (err as Error).message, relPath }, 'Failed to write generated file');
    }
  }

  // Persist artifact rows when DB is available.
  let artifactCount = 0;
  const db = agent.getDatabase?.();
  if (db) {
    try {
      const stmt = db.prepare(
        `INSERT INTO build_artifacts (id, build_id, type, path, size_bytes, hash, version, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ts = Date.now();
      for (const [relPath, file] of session.generatedFiles.entries()) {
        try {
          const content = (file as { content?: string }).content ?? '';
          const buf = Buffer.from(content, 'utf-8');
          const hash = crypto.createHash('sha256').update(buf).digest('hex');
          stmt.run(
            `${sessionId}-${artifactCount}-${crypto.randomBytes(3).toString('hex')}`,
            sessionId,
            'file',
            path.join(workspace, relPath),
            buf.length,
            hash,
            1,
            ts,
          );
          artifactCount++;
        } catch (err) {
          log.warn({ err: (err as Error).message, relPath }, 'Failed to insert build_artifact');
        }
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'build_artifacts insert prepare failed; skipping');
    }
  }

  return {
    sessionId,
    appName,
    workspace,
    status: session.status,
    generatedFileCount: writtenCount,
    artifactCount,
    startedAt,
    completedAt,
    durationMs: completedAt - startedAt,
    logs: session.logs.slice(-50).map((l) => ({
      ts: l.timestamp, level: l.level, stage: l.stage, message: l.message,
    })),
    buildOk: session.result?.success,
    buildErrors: session.result?.errors?.map((e) => typeof e === 'string' ? e : JSON.stringify(e)),
  };
}
