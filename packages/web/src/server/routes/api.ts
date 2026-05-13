/**
 * REST API routes for the AgentX Web UI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import type { Agent } from '@agentx/core';
import { createLogger } from '@agentx/core';
import { tryUnsupportedSpaShim, unknownEndpointEnvelope } from './spa-shims.js';
import { createTtsRouter, type TtsRouter } from '../tts/index.js';
import {
  listMemoryItems,
  getMemoryDetail,
  deleteMemoryItem,
  bulkDeleteMemoryItems,
} from './memory-control-center.js';
import { getMemoryDbHandle, getMemoryDbDiagnostics } from './memory-db.js';
import { getCognitiveServices, getCognitiveDiagnostics } from '../cognitive-adapter.js';
import { parseMultipartBody, MultipartError } from '../multipart.js';
import {
  ingestUploadedDocument,
  loadMCPConfig,
  saveMCPConfig,
  validateServerConfig,
  resolveDataDir,
  loadRoutingConfig,
  saveRoutingConfig,
  validateRoutingConfig,
  probeOllamaModels,
  analyzeImageBuffer,
  extractTextFromUpload,
  resolveOllamaModel,
  syncCognitiveToRetrieval,
  runCognitiveMemoryMigrations,
  type MCPServerConfig,
} from '@agentx/core';

/**
 * Tier 2 batch B helpers — body-size-capped JSON parser + name validator.
 * Kept local to the MCP write handlers; do not modify the global parseBody
 * because other routes don't need this specific shape today.
 */
const MCP_BODY_MAX_BYTES = 32 * 1024;
const MCP_NAME_REGEX = /^[A-Za-z0-9_.-]{1,64}$/;
const MCP_ALLOWED_FIELDS = new Set([
  'command', 'args', 'url', 'transport', 'env', 'headers',
  'description', 'safety', 'toolAllowlist', 'enabled',
]);

function readJsonCapped(req: http.IncomingMessage, maxBytes: number): Promise<{ body: Record<string, unknown>; error?: string }> {
  return new Promise((resolve) => {
    const ct = String(req.headers['content-type'] ?? '');
    if (!/application\/json/i.test(ct)) {
      resolve({ body: {}, error: 'content-type must be application/json' });
      return;
    }
    const chunks: Buffer[] = [];
    let total = 0;
    let oversize = false;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        oversize = true;
        try { req.destroy(); } catch { /* ignore */ }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (oversize) { resolve({ body: {}, error: `body too large: > ${maxBytes} bytes` }); return; }
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw) { resolve({ body: {} }); return; }
      try { resolve({ body: JSON.parse(raw) as Record<string, unknown> }); }
      catch { resolve({ body: {}, error: 'invalid JSON body' }); }
    });
    req.on('error', () => resolve({ body: {}, error: 'request stream error' }));
  });
}

const log = createLogger('web:api');

/**
 * Lazy-init TTS router. Same pattern as agent's lazy getters: first call
 * constructs from the default provider list, subsequent calls reuse.
 * Wrapped in a closure inside createApiRouter so it doesn't leak across
 * router instances during tests.
 */

interface ApiRouter {
  handle: (method: string, url: string, req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>;
}

/** Optional voice caller for Twilio webhook handling. */
export interface VoiceCallerLike {
  updateCallStatus(callSid: string, status: string): void;
  buildGatherResponse(agentReply: string): string;
  getAudioDir(): string;
}

function parseBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function parseFormBody(req: http.IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', () => {
      try {
        const params = new URLSearchParams(body);
        const result: Record<string, string> = {};
        for (const [key, value] of params) {
          result[key] = value;
        }
        resolve(result);
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// categoriseChatError lives in a sibling file so web tests can import it
// without tripping vitest's @agentx/core alias.
import { categoriseChatError } from '../chat-error.js';
export { categoriseChatError };

function sendTwiml(res: http.ServerResponse, twiml: string): void {
  res.writeHead(200, { 'Content-Type': 'text/xml' });
  res.end(twiml);
}

export interface ApiRouterOptions {
  voiceCaller?: VoiceCallerLike;
  authToken?: string;
}

export function createApiRouter(agent: Agent, options: ApiRouterOptions = {}): ApiRouter {
  const { voiceCaller, authToken } = options;

  // Lazy TTS router — instantiated on first /api/tts/* request. The provider
  // list is fixed (qwen3, lovevoice, naturalreader, speechma); each provider
  // self-checks isEnabled() so missing API keys cleanly disable that provider.
  let ttsRouter: TtsRouter | null = null;
  const getTtsRouter = (): TtsRouter => {
    if (!ttsRouter) ttsRouter = createTtsRouter();
    return ttsRouter;
  };

  return {
    async handle(method: string, url: string, req: http.IncomingMessage, res: http.ServerResponse) {
      const route = url.replace(/\?.*$/, ''); // strip query string

      // ─── Auth check (skip for health and voice webhooks) ────────────
      if (authToken && !route.startsWith('/voice/') && route !== '/api/health') {
        const auth = req.headers['authorization'];
        if (auth !== `Bearer ${authToken}`) {
          sendJson(res, 401, { error: 'Unauthorized' });
          return;
        }
      }

      try {
        // ─── Health ──────────────────────────────────────────────────────
        if (route === '/api/health' && method === 'GET') {
          sendJson(res, 200, { ok: true, timestamp: new Date().toISOString() });
          return;
        }

        // ─── Providers (R+: provider availability for UI/diagnostics) ──
        if (route === '/api/providers' && method === 'GET') {
          const config = agent.getConfig();
          const active = config.agent.defaultProvider;
          const activeModel = config.agent.model;
          const providers = [
            {
              id: 'anthropic',
              label: 'Anthropic Claude (cloud, paid)',
              configured: !!process.env['ANTHROPIC_API_KEY'],
              configuredVia: 'ANTHROPIC_API_KEY env',
              defaultModel: config.providers.anthropic?.model ?? 'claude-sonnet-4-20250514',
            },
            {
              id: 'openai',
              label: 'OpenAI (cloud, paid)',
              configured: !!process.env['OPENAI_API_KEY'],
              configuredVia: 'OPENAI_API_KEY env',
              defaultModel: config.providers.openai?.model ?? 'gpt-4o',
            },
            {
              id: 'ollama',
              label: 'Ollama (local, free)',
              configured: true,
              configuredVia: 'baseUrl in config (no API key required)',
              defaultModel: config.providers.ollama?.model ?? 'llama3',
            },
          ];
          sendJson(res, 200, {
            active,
            activeModel,
            providers,
            switchInstructions:
              "To switch providers: set agent.defaultProvider in config/default.yaml (or DATA_DIR/config.yaml) and restart the server. To remain free, set defaultProvider: ollama with a model name your local Ollama serves.",
          });
          return;
        }

        // ─── Status ──────────────────────────────────────────────────────
        if (route === '/api/status' && method === 'GET') {
          const config = agent.getConfig();
          sendJson(res, 200, {
            running: true,
            agentName: config.agent.name,
            model: config.agent.model,
            activeSessions: agent.getSessionManager().listActive().length,
            integrations: [],
          });
          return;
        }

        // GET /api/agent/provider/status — surfaces the active LLM provider
        // and whether it can answer chat requests right now. Used by the
        // Chat sidebar to show "Ollama ready" / "Anthropic key missing"
        // without polling.
        if (route === '/api/agent/provider/status' && method === 'GET') {
          try {
            const config = agent.getConfig();
            const providerId = config.agent.defaultProvider;
            // For Ollama, use the same resolver the OllamaProvider does so
            // status and live provider report the same model. For Anthropic/
            // OpenAI keep the per-provider heuristic.
            const providerModel = config.providers?.[providerId]?.model ?? null;
            const agentModel = config.agent.model ?? null;
            const matchesProvider =
              !agentModel ? false :
              providerId === 'anthropic' ? /^claude/i.test(agentModel) :
              providerId === 'openai'    ? /^(gpt|o\d)/i.test(agentModel) :
              providerId === 'ollama'    ? !/^claude|^gpt|^o\d/i.test(agentModel) :
              false;
            let configuredModel = matchesProvider ? agentModel : (providerModel ?? agentModel);
            let resolutionSource: 'env' | 'routing.json' | 'config' | 'default' | undefined;
            if (providerId === 'ollama') {
              const resolved = resolveOllamaModel(configuredModel ?? undefined);
              configuredModel = resolved.model;
              resolutionSource = resolved.source;
            }

            interface ProviderStatusResponse {
              provider: string;
              model: string | null;
              configuredModel?: string | null;
              ready: boolean;
              reason?: string;
              hint?: string;
              availableModels?: Array<{ name: string; size?: number }>;
              recommendedModel?: string | null;
              installedCount?: number;
              /** Where the configured model name was resolved from. */
              resolutionSource?: 'env' | 'routing.json' | 'config' | 'default';
            }
            const out: ProviderStatusResponse = {
              provider: providerId,
              model: configuredModel,
              ready: false,
              ...(resolutionSource ? { resolutionSource } : {}),
            };

            if (providerId === 'anthropic') {
              out.ready = !!process.env['ANTHROPIC_API_KEY'];
              if (!out.ready) {
                out.reason = 'ANTHROPIC_API_KEY not set';
                out.hint = 'Set AGENT_DEFAULT_PROVIDER=ollama (and start Ollama) to use a local model without an API key.';
              }
            } else if (providerId === 'openai') {
              out.ready = !!process.env['OPENAI_API_KEY'];
              if (!out.ready) {
                out.reason = 'OPENAI_API_KEY not set';
                out.hint = 'Set AGENT_DEFAULT_PROVIDER=ollama (and start Ollama) to use a local model without an API key.';
              }
            } else if (providerId === 'ollama') {
              // Probe Ollama liveness + enumerate installed models. 3s budget.
              const host = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';
              let installed: Array<{ name: string; size?: number }> = [];
              let live = false;
              try {
                const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(3000) });
                if (r.ok) {
                  live = true;
                  const j = (await r.json().catch(() => ({}))) as { models?: Array<{ name?: string; size?: number }> };
                  installed = (j?.models ?? [])
                    .filter((m): m is { name: string; size?: number } => typeof m?.name === 'string')
                    .map((m) => ({ name: m.name, size: typeof m.size === 'number' ? m.size : undefined }));
                } else {
                  out.reason = `Ollama returned HTTP ${r.status}`;
                }
              } catch (err) {
                out.reason = `Ollama unreachable: ${err instanceof Error ? err.message : String(err)}`;
              }

              out.availableModels = installed;
              out.installedCount = installed.length;
              out.configuredModel = configuredModel;

              if (!live) {
                out.ready = false;
                out.hint = 'Start Ollama (e.g. `ollama serve`) or set OLLAMA_HOST to a reachable instance.';
              } else if (installed.length === 0) {
                out.ready = false;
                out.reason = 'Ollama is running but no models are installed.';
                out.hint = 'Pull a model, e.g. `ollama pull qwen2.5-coder:32b` or `ollama pull llama3.1:8b`.';
              } else {
                // Verify the configured model is installed. Accept either an
                // exact match or a prefix match (Ollama tags carry size
                // suffixes like ":32b", ":70b-instruct-q4_K_M"). Case-
                // insensitive compare but return the original-case tag
                // from the installed list.
                const wantedLower = (configuredModel ?? '').toLowerCase();
                const exactMatchEntry = installed.find((m) => m.name.toLowerCase() === wantedLower);
                const prefixMatchEntry = wantedLower
                  ? installed.find((m) => m.name.toLowerCase().startsWith(wantedLower + ':'))
                  : undefined;
                const exactMatch = !!exactMatchEntry;
                const prefixMatch = prefixMatchEntry?.name;
                const present = exactMatch || !!prefixMatch;

                // Recommendation: prefer coding/reasoning models when present.
                // Walk a priority list of prefix patterns; pick the first
                // installed model whose name starts with one of them.
                const preferenceRegexes: RegExp[] = [
                  /^qwen2\.5-coder/i,
                  /^qwen3-coder/i,
                  /^qwen2\.5/i,
                  /^qwen3/i,
                  /^llama3\.3/i,
                  /^llama3\.1/i,
                  /^deepseek-coder/i,
                  /^deepseek/i,
                  /^codestral/i,
                  /^mistral/i,
                  /^llama3/i,
                  /^gemma/i,
                ];
                let recommended: string | null = null;
                for (const rx of preferenceRegexes) {
                  const hit = installed.find((m) => rx.test(m.name));
                  if (hit) { recommended = hit.name; break; }
                }
                // Fallback — any installed model.
                if (!recommended && installed[0]) recommended = installed[0].name;
                out.recommendedModel = recommended;

                if (present) {
                  out.ready = true;
                  out.model = exactMatch ? exactMatchEntry!.name : prefixMatch!;
                } else {
                  out.ready = false;
                  out.reason = `Configured model '${configuredModel ?? '(none)'}' is not installed on Ollama (${installed.length} model${installed.length === 1 ? '' : 's'} available).`;
                  out.hint = recommended
                    ? `Use the installed '${recommended}' (POST /api/agent/provider/select-local-model {"model":"${recommended}"}) or pull the configured model with \`ollama pull ${configuredModel}\`.`
                    : `Pull the configured model with \`ollama pull ${configuredModel}\`.`;
                }
              }
            }

            sendJson(res, 200, out);
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // POST /api/agent/provider/select-local-model
        //   Body: { "model": "<ollama-model-name>" }
        //   Verifies the model exists on Ollama, then persists it as the
        //   `forceModel` in routing.json. Does NOT modify agent.defaultProvider
        //   or rewrite ~/.agentx/config.yaml. The agent picks up forceModel
        //   on next chat call via the routing-config path (Strategy 3).
        //
        // Safe-by-design:
        //   - Only writes to ~/.agentx/routing.json
        //   - Refuses if the model isn't listed in /api/tags
        //   - 32 KB body cap (readJsonCapped)
        //   - Never restarts the agent or rewrites the main config
        if (route === '/api/agent/provider/select-local-model' && method === 'POST') {
          const { body, error } = await readJsonCapped(req, 32 * 1024);
          if (error) { sendJson(res, 400, { error }); return; }
          const wanted = typeof body['model'] === 'string' ? (body['model'] as string).trim() : '';
          if (!wanted) { sendJson(res, 400, { error: 'model field is required' }); return; }
          // Verify against live Ollama tags
          const host = process.env['OLLAMA_HOST'] ?? 'http://127.0.0.1:11434';
          let installed: string[] = [];
          try {
            const r = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(5000) });
            if (!r.ok) { sendJson(res, 502, { error: `Ollama returned HTTP ${r.status}` }); return; }
            const j = (await r.json().catch(() => ({}))) as { models?: Array<{ name?: string }> };
            installed = (j?.models ?? []).map((m) => m?.name ?? '').filter(Boolean);
          } catch (err) {
            sendJson(res, 502, { error: `Ollama unreachable: ${err instanceof Error ? err.message : String(err)}` });
            return;
          }
          if (!installed.includes(wanted)) {
            sendJson(res, 400, {
              error: `Model '${wanted}' is not installed on Ollama.`,
              availableModels: installed,
            });
            return;
          }
          // Persist as routing forceModel via Strategy 3 (no agent.ts touch).
          try {
            const dataDir = resolveDataDir();
            const current = loadRoutingConfig(dataDir);
            const next = { ...current, forceModel: wanted };
            saveRoutingConfig(dataDir, next);
            sendJson(res, 200, { ok: true, model: wanted, persistedTo: 'routing.json forceModel' });
          } catch (err) {
            sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
          }
          return;
        }

        // ─── Chat ────────────────────────────────────────────────────────
        if (route === '/api/chat' && method === 'POST') {
          const body = await parseBody(req);
          const message = body['message'] as string;
          const sessionId = body['sessionId'] as string | undefined;

          if (!message) {
            sendJson(res, 400, { error: 'message is required' });
            return;
          }

          try {
            const response = await agent.chat(message, sessionId);
            // R3: surface retrieval metadata when the agent has it (flag on).
            const retrievalMeta = agent.getLastRetrievalMetadata?.() ?? null;
            sendJson(res, 200, {
              response,
              sessionId: sessionId ?? 'default',
              ...(retrievalMeta ? { retrieval: retrievalMeta } : {}),
            });
          } catch (chatErr) {
            const categorised = categoriseChatError(chatErr);
            // Full stack stays in server log via the existing log.error in
            // the outer route handler; the client gets the safe summary.
            log.error({ code: categorised.code, raw: categorised.raw }, 'chat() failed');
            sendJson(res, categorised.status, {
              error: categorised.userMessage,
              code: categorised.code,
            });
          }
          return;
        }

        // ─── Chat Stream (SSE) ──────────────────────────────────────────
        if (route === '/api/chat/stream' && method === 'POST') {
          const body = await parseBody(req);
          const message = body['message'] as string;
          const sessionId = body['sessionId'] as string | undefined;

          if (!message) {
            sendJson(res, 400, { error: 'message is required' });
            return;
          }

          // Set SSE headers
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
          });

          try {
            await agent.chatStream(message, {
              onRetrieval: (metadata) => {
                // R3: emit retrieval event BEFORE first token (only when flag is on)
                res.write(`data: ${JSON.stringify({ type: 'retrieval', retrieval: metadata })}\n\n`);
              },
              onToken: (token: string) => {
                res.write(`data: ${JSON.stringify({ type: 'token', content: token })}\n\n`);
              },
              onToolCall: (toolCall: { id: string; name: string; arguments: Record<string, unknown> }) => {
                res.write(`data: ${JSON.stringify({ type: 'tool', tool: toolCall.name, args: toolCall.arguments })}\n\n`);
              },
              onComplete: (response: { content: string }) => {
                res.write(`data: ${JSON.stringify({ type: 'done', content: response.content, sessionId: sessionId ?? 'default' })}\n\n`);
              },
              onError: (error: Error) => {
                res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
              },
            }, sessionId);
          } catch (error) {
            const categorised = categoriseChatError(error);
            log.error({ code: categorised.code, raw: categorised.raw }, 'chatStream() failed');
            res.write(`data: ${JSON.stringify({ type: 'error', code: categorised.code, message: categorised.userMessage })}\n\n`);
          }

          res.end();
          return;
        }

        // ─── R11: Chat Feedback ─────────────────────────────────────────
        if (route === '/api/chat/feedback' && method === 'POST') {
          let body: Record<string, unknown>;
          try {
            body = await parseBody(req);
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return;
          }
          try {
            const recordFn = (agent as unknown as { recordFeedback?: (p: unknown) => unknown }).recordFeedback;
            if (typeof recordFn !== 'function') {
              sendJson(res, 501, { error: 'Feedback not supported by this agent build' });
              return;
            }
            const record = recordFn.call(agent, body);
            sendJson(res, 200, { ok: true, feedback: record });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            sendJson(res, 400, { error: msg });
          }
          return;
        }

        // ─── Sessions ───────────────────────────────────────────────────
        if (route === '/api/sessions' && method === 'GET') {
          const store = agent.getSessionStore();
          if (store) {
            const entries = store.list();
            sendJson(res, 200, entries);
          } else {
            const sessions = agent.getSessionManager().listActive();
            sendJson(res, 200, sessions.map((s) => ({
              sessionId: s.id,
              sessionKey: s.id,
              updatedAt: new Date(s.updatedAt).toISOString(),
              channel: s.platform,
            })));
          }
          return;
        }

        if (route.startsWith('/api/sessions/') && method === 'DELETE') {
          const key = decodeURIComponent(route.slice('/api/sessions/'.length));
          agent.getSessionManager().resetSession(key);
          sendJson(res, 200, { deleted: true, key });
          return;
        }

        // ─── Dashboard stubs (shapes must match frontend destructuring) ─
        if (route === '/api/projects' && method === 'GET') {
          sendJson(res, 200, {
            activeProjects: 0, completedProjects: 0, totalProjects: 0,
            pendingTasks: 0, openIssues: 0, averageHealth: 0,
          });
          return;
        }

        if (route === '/api/tools' && method === 'GET') {
          // frontend expects a bare array
          const tools = agent.getToolRegistry().getDefinitions();
          sendJson(res, 200, tools.map((t) => ({
            name: t.name, enabled: true, category: 'Built-in',
          })));
          return;
        }

        if (route === '/api/build-memory/stats' && method === 'GET') {
          sendJson(res, 200, {
            recordedBuilds: 0, successfulPatterns: 0,
            failedPatterns: 0, enabled: false,
          });
          return;
        }

        if (route === '/api/builder/stats' && method === 'GET') {
          sendJson(res, 200, {
            totalBuilds: 0, successfulBuilds: 0, successRate: 0,
            lastBuildTime: 0,
            platformBreakdown: {
              ios: { total: 0, successful: 0 },
              web: { total: 0, successful: 0 },
            },
          });
          return;
        }

        if (route === '/api/workflows' && method === 'GET') {
          sendJson(res, 200, {
            totalWorkflows: 0, activeWorkflows: 0, completedWorkflows: 0,
            failedWorkflows: 0, averageExecutionTime: 0, successRate: 0,
          });
          return;
        }

        if (route === '/api/logs' && method === 'GET') {
          sendJson(res, 200, []);
          return;
        }

        if (route === '/api/cognitive/status' && method === 'GET') {
          sendJson(res, 200, { running: false, jobs: [] });
          return;
        }

        if (route === '/api/memory/gateway/health' && method === 'GET') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (route === '/api/memory/gateway/documents' && method === 'GET') {
          sendJson(res, 200, { documents: [] });
          return;
        }

        // ─── Skills ─────────────────────────────────────────────────────
        if (route === '/api/skills' && method === 'GET') {
          const tools = agent.getToolRegistry().getDefinitions();
          sendJson(res, 200, tools.map((t) => ({
            name: t.name,
            version: '0.1.0',
            description: t.description,
            enabled: true,
          })));
          return;
        }

        // ─── Config ─────────────────────────────────────────────────────
        if (route === '/api/config' && method === 'GET') {
          const config = agent.getConfig();
          sendJson(res, 200, {
            agent: config.agent,
            providers: Object.keys(config.providers),
            sessions: config.sessions,
          });
          return;
        }

        // ─── Voice Webhooks (Twilio) ────────────────────────────────────
        if (voiceCaller && route === '/voice/status' && method === 'POST') {
          const body = await parseFormBody(req);
          const callSid = body['CallSid'] ?? '';
          const callStatus = body['CallStatus'] ?? '';
          voiceCaller.updateCallStatus(callSid, callStatus);
          sendTwiml(res, '<Response/>');
          return;
        }

        if (voiceCaller && route === '/voice/gather' && method === 'POST') {
          const body = await parseFormBody(req);
          const speechResult = body['SpeechResult'] ?? '';
          log.info({ speechResult }, 'Received speech from caller');

          // Route speech through the agent
          const agentReply = await agent.chat(speechResult, 'voice-call');
          const twiml = voiceCaller.buildGatherResponse(agentReply);
          sendTwiml(res, twiml);
          return;
        }

        if (voiceCaller && route.startsWith('/voice/audio/') && method === 'GET') {
          const filename = decodeURIComponent(route.slice('/voice/audio/'.length));
          const audioPath = path.join(voiceCaller.getAudioDir(), filename);
          const safePath = path.resolve(audioPath);
          if (!safePath.startsWith(voiceCaller.getAudioDir())) {
            sendJson(res, 403, { error: 'Forbidden' });
            return;
          }
          if (fs.existsSync(safePath)) {
            res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
            fs.createReadStream(safePath).pipe(res);
            return;
          }
          sendJson(res, 404, { error: 'Audio file not found' });
          return;
        }

        // ─── Phase D-prep: routes backed by lifted-subsystem getters ────
        // Each block uses optional chaining + try/catch so a misconfigured
        // subsystem returns a clean JSON error rather than a 500.
        // Implementations call into the agent's eager-init or lazy
        // getters added in agent.ts merge rounds 1 + 2.

        // Logs page → LLM interaction history + system log buffer
        if (route === '/api/logs/llm-interactions' && method === 'GET') {
          try {
            // LLMInteractionLogger.tail(limit) — not .recent(). Earlier
            // route handler called a non-existent method; live audit
            // caught it returning {entries:[], error:"…not a function"}.
            const logger = (agent as unknown as { getLLMInteractionLogger?: () => { tail(n?: number): unknown[] } }).getLLMInteractionLogger?.();
            const entries = logger?.tail(200) ?? [];
            sendJson(res, 200, { entries });
          } catch (e) {
            sendJson(res, 200, { entries: [], error: String(e) });
          }
          return;
        }
        if (route === '/api/logs/system' && method === 'GET') {
          try {
            const buf = (agent as unknown as { getSystemLogBuffer?: () => { recent(n?: number): unknown } }).getSystemLogBuffer?.();
            const entries = buf?.recent(500) ?? [];
            sendJson(res, 200, { entries });
          } catch (e) {
            sendJson(res, 200, { entries: [], error: String(e) });
          }
          return;
        }

        // Automation page → policies + runs + kill-switch
        if (route === '/api/automation/policies' && method === 'GET') {
          try {
            const svc = (agent as unknown as { getAutomationPolicyService?: () => { listPolicies(): unknown[] } }).getAutomationPolicyService?.();
            sendJson(res, 200, { policies: svc?.listPolicies() ?? [] });
          } catch (e) {
            sendJson(res, 200, { policies: [], error: String(e) });
          }
          return;
        }
        if (route === '/api/automation/runs' && method === 'GET') {
          try {
            const store = (agent as unknown as { getAutomationRunStore?: () => { listRuns(): unknown[] } }).getAutomationRunStore?.();
            sendJson(res, 200, { runs: store?.listRuns?.() ?? [] });
          } catch (e) {
            sendJson(res, 200, { runs: [], error: String(e) });
          }
          return;
        }
        if (route === '/api/automation/kill-switch' && method === 'POST') {
          try {
            const eng = (agent as unknown as { getAutomationEngine?: () => { engageKillSwitch?: () => unknown } }).getAutomationEngine?.();
            eng?.engageKillSwitch?.();
            sendJson(res, 200, { ok: true, killSwitchEngaged: true });
          } catch (e) {
            sendJson(res, 503, { ok: false, error: String(e) });
          }
          return;
        }

        // Email page — status now reports both the ingestion service config
        // AND the runner's live state (running, lastRunAt, lastResult).
        if (route === '/api/email/status' && method === 'GET') {
          const svc = (agent as unknown as { getEmailIngestionService?: () => unknown | null }).getEmailIngestionService?.();
          const runner = (agent as unknown as { getEmailRunner?: () => { getStatus(): unknown } | null }).getEmailRunner?.();
          if (!svc) {
            sendJson(res, 200, {
              available: false,
              reason: 'Email ingestion not configured (no Keychain credential)',
              enabled: false,
              runner: runner?.getStatus?.() ?? null,
            });
            return;
          }
          try {
            const state = (svc as { getState?: () => unknown }).getState?.() ?? null;
            sendJson(res, 200, {
              available: true,
              enabled: process.env['AGENT_EMAIL_INGESTION_ENABLED'] === 'true',
              state,
              runner: runner?.getStatus?.() ?? null,
            });
          } catch (e) {
            sendJson(res, 200, { available: true, enabled: false, error: String(e) });
          }
          return;
        }

        // Run a single ingestion cycle now (sync; returns the result).
        if (route === '/api/email/run' && method === 'POST') {
          const runner = (agent as unknown as { getEmailRunner?: () => { runOnce(): Promise<unknown> } | null }).getEmailRunner?.();
          if (!runner) {
            sendJson(res, 503, { ok: false, error: 'Email runner not available (Keychain or config missing)' });
            return;
          }
          try {
            const result = await runner.runOnce();
            sendJson(res, 200, { ok: true, result });
          } catch (e) {
            sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Start the polling loop (background).
        if (route === '/api/email/start' && method === 'POST') {
          const runner = (agent as unknown as { getEmailRunner?: () => { start(ms?: number): void; getStatus(): unknown } | null }).getEmailRunner?.();
          if (!runner) {
            sendJson(res, 503, { ok: false, error: 'Email runner not available' });
            return;
          }
          try {
            const body = await parseBody(req).catch(() => ({}));
            const intervalMs = Number((body as { intervalMs?: unknown }).intervalMs ?? 60_000);
            runner.start(intervalMs);
            sendJson(res, 200, { ok: true, status: runner.getStatus() });
          } catch (e) {
            sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Stop the polling loop.
        if (route === '/api/email/stop' && method === 'POST') {
          const runner = (agent as unknown as { getEmailRunner?: () => { stop(): void; getStatus(): unknown } | null }).getEmailRunner?.();
          if (!runner) {
            sendJson(res, 503, { ok: false, error: 'Email runner not available' });
            return;
          }
          try {
            runner.stop();
            sendJson(res, 200, { ok: true, status: runner.getStatus() });
          } catch (e) {
            sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }
        if (route === '/api/email/allowlist' && method === 'GET') {
          const svc = (agent as unknown as { getEmailIngestionService?: () => unknown | null }).getEmailIngestionService?.();
          if (!svc) {
            sendJson(res, 200, { allowlist: [], available: false });
            return;
          }
          try {
            const list = (svc as { getAllowlist?: () => unknown[] }).getAllowlist?.() ?? [];
            sendJson(res, 200, { allowlist: list, available: true });
          } catch (e) {
            sendJson(res, 200, { allowlist: [], error: String(e) });
          }
          return;
        }
        if (route === '/api/email/test-connection' && method === 'POST') {
          const svc = (agent as unknown as { getEmailIngestionService?: () => unknown | null }).getEmailIngestionService?.();
          if (!svc) {
            sendJson(res, 503, { ok: false, error: 'Email ingestion not configured' });
            return;
          }
          try {
            const test = (svc as { testConnection?: () => Promise<unknown> }).testConnection;
            const result = test ? await test.call(svc) : { ok: false, error: 'testConnection not implemented' };
            sendJson(res, 200, result);
          } catch (e) {
            sendJson(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Validation lab → scenarios list + run controller status
        if (route === '/api/validation/scenarios' && method === 'GET') {
          try {
            const c = (agent as unknown as { getSelfImprovementController?: () => { listScenarios?: () => unknown[] } }).getSelfImprovementController?.();
            sendJson(res, 200, { scenarios: c?.listScenarios?.() ?? [] });
          } catch (e) {
            sendJson(res, 200, { scenarios: [], error: String(e) });
          }
          return;
        }
        if (route === '/api/validation/run' && method === 'POST') {
          try {
            const body = await parseBody(req).catch(() => ({}));
            const c = (agent as unknown as { getSelfImprovementController?: () => { runScenario?: (id: string) => Promise<unknown> } }).getSelfImprovementController?.();
            const id = String((body as Record<string, unknown>)['scenarioId'] ?? 'default');
            if (!c?.runScenario) {
              sendJson(res, 501, { available: false, reason: 'Validation controller not wired' });
              return;
            }
            const result = await c.runScenario(id);
            sendJson(res, 200, { ok: true, result });
          } catch (e) {
            sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Integrity / autonomy / hardening status — all read-only, safe
        if (route === '/api/integrity/status' && method === 'GET') {
          try {
            const ih = (agent as unknown as { getIntelligenceHardening?: () => { diagnostics?: () => unknown } }).getIntelligenceHardening?.();
            const diag = ih?.diagnostics?.() ?? null;
            sendJson(res, 200, { available: !!ih, hardening: diag });
          } catch (e) {
            sendJson(res, 200, { available: false, error: String(e) });
          }
          return;
        }
        if (route === '/api/autonomy/status' && method === 'GET') {
          try {
            const g = (agent as unknown as { getAutonomyGate?: () => { status?: () => unknown } }).getAutonomyGate?.();
            const status = g?.status?.() ?? null;
            sendJson(res, 200, { available: !!g, status });
          } catch (e) {
            sendJson(res, 200, { available: false, error: String(e) });
          }
          return;
        }

        // Stability — checkpoints + baselines (read-only)
        if (route === '/api/checkpoints' && method === 'GET') {
          try {
            const cm = (agent as unknown as { getCheckpointManager?: () => { list?: () => unknown[] } }).getCheckpointManager?.();
            sendJson(res, 200, { checkpoints: cm?.list?.() ?? [] });
          } catch (e) {
            sendJson(res, 200, { checkpoints: [], error: String(e) });
          }
          return;
        }
        if (route === '/api/baselines' && method === 'GET') {
          try {
            const br = (agent as unknown as { getBaselineRegistry?: () => { listFeatures?: () => unknown[] } }).getBaselineRegistry?.();
            sendJson(res, 200, { features: br?.listFeatures?.() ?? [] });
          } catch (e) {
            sendJson(res, 200, { features: [], error: String(e) });
          }
          return;
        }

        // Learning + adaptive intelligence stats
        if (route === '/api/learning/stats' && method === 'GET') {
          try {
            const le = (agent as unknown as { getLearningEngine?: () => { getStats?: () => unknown } }).getLearningEngine?.();
            sendJson(res, 200, le?.getStats?.() ?? { signals: 0 });
          } catch (e) {
            sendJson(res, 200, { signals: 0, error: String(e) });
          }
          return;
        }
        if (route === '/api/personal-intelligence/status' && method === 'GET') {
          try {
            const pi = (agent as unknown as { getPersonalIntelligence?: () => { status?: () => unknown } }).getPersonalIntelligence?.();
            sendJson(res, 200, pi?.status?.() ?? { available: !!pi });
          } catch (e) {
            sendJson(res, 200, { available: false, error: String(e) });
          }
          return;
        }
        if (route === '/api/adaptive/status' && method === 'GET') {
          try {
            const a = (agent as unknown as { getAdaptiveStatus?: () => { getReport?: () => unknown } }).getAdaptiveStatus?.();
            sendJson(res, 200, a?.getReport?.() ?? { subsystems: [] });
          } catch (e) {
            sendJson(res, 200, { subsystems: [], error: String(e) });
          }
          return;
        }

        // Multi-agent supervisor (BuilderV2)
        if (route === '/api/supervisor/status' && method === 'GET') {
          const sup = (agent as unknown as { getMultiAgentSupervisor?: () => unknown | null }).getMultiAgentSupervisor?.();
          if (!sup) {
            sendJson(res, 200, { available: false, reason: 'BuilderV2 feature flag is off' });
            return;
          }
          try {
            const status = (sup as { getStatus?: () => unknown }).getStatus?.() ?? null;
            sendJson(res, 200, { available: true, status });
          } catch (e) {
            sendJson(res, 200, { available: true, error: String(e) });
          }
          return;
        }

        // Build memory recent runs (read DB directly via agent.getDatabase())
        if (route === '/api/build-memory/recent' && method === 'GET') {
          try {
            const db = (agent as unknown as { getDatabase?: () => { prepare(s: string): { all(...a: unknown[]): unknown[] } } }).getDatabase?.();
            if (!db) {
              sendJson(res, 200, { recent: [] });
              return;
            }
            // Query is best-effort — table may not exist yet on a fresh DB
            try {
              const rows = db.prepare(`SELECT * FROM build_memory ORDER BY created_at DESC LIMIT 50`).all();
              sendJson(res, 200, { recent: rows });
            } catch {
              sendJson(res, 200, { recent: [] });
            }
          } catch (e) {
            sendJson(res, 200, { recent: [], error: String(e) });
          }
          return;
        }

        // ─── Phase D-prep round 2: more subsystem-backed routes ─────────
        // Same pattern as round 1: optional chaining + graceful degradation.

        // TTS — multi-provider router with fallback chain
        if (route === '/api/tts/health' && method === 'GET') {
          try {
            const summary = await getTtsRouter().healthSummary();
            sendJson(res, 200, summary);
          } catch (e) {
            sendJson(res, 200, { providers: [], healthy: 0, error: String(e) });
          }
          return;
        }
        if (route === '/api/tts/voices' && method === 'GET') {
          try {
            const voices = await getTtsRouter().listAllVoices();
            sendJson(res, 200, { voices });
          } catch (e) {
            sendJson(res, 200, { voices: [], error: String(e) });
          }
          return;
        }
        if (route === '/api/tts' && method === 'POST') {
          try {
            const body = await parseBody(req).catch(() => ({}));
            const text = String((body as Record<string, unknown>)['text'] ?? '');
            const voiceId = (body as Record<string, unknown>)['voiceId'] as string | undefined;
            const speed = (body as Record<string, unknown>)['speed'] as number | undefined;
            if (!text) { sendJson(res, 400, { error: 'text is required' }); return; }
            const result = await getTtsRouter().synthesize({ text, voiceId, speed });
            res.writeHead(200, {
              'Content-Type': result.contentType,
              'Content-Length': result.bytes.length,
              'X-Tts-Provider': result.providerId,
              'X-Tts-Voice': result.voiceId,
            });
            res.end(result.bytes);
          } catch (e) {
            sendJson(res, 503, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // MCP — read-only views (write/start/stop come later when route handlers
        // are wired into the lifecycle). Returns empty when no servers configured.
        if (route === '/api/mcp/servers' && method === 'GET') {
          try {
            const mcp = (agent as unknown as { getMCPClientManager?: () => { listServers?: () => unknown[] } | null }).getMCPClientManager?.();
            sendJson(res, 200, { servers: mcp?.listServers?.() ?? [], available: !!mcp });
          } catch (e) {
            sendJson(res, 200, { servers: [], available: false, error: String(e) });
          }
          return;
        }
        if (route === '/api/mcp/tools' && method === 'GET') {
          try {
            const mcp = (agent as unknown as { getMCPClientManager?: () => { listTools?: () => unknown[] } | null }).getMCPClientManager?.();
            sendJson(res, 200, { tools: mcp?.listTools?.() ?? [], available: !!mcp });
          } catch (e) {
            sendJson(res, 200, { tools: [], available: false, error: String(e) });
          }
          return;
        }

        // ─── Tier 2 batch B — MCP write routes (Strategy 3) ─────────────
        // These use route-level config-file access via loadMCPConfig /
        // saveMCPConfig — no agent.ts wiring, no boot-time MCP instance
        // required. When agent.getMCPClientManager() returns a live manager
        // we ALSO call its mutation methods so a running process stays in
        // sync; otherwise the new value takes effect on next restart.

        // PUT /api/mcp/allow-remote — opt in/out of HTTPS MCP transport.
        if (route === '/api/mcp/allow-remote' && method === 'PUT') {
          const parsed = await readJsonCapped(req, MCP_BODY_MAX_BYTES);
          if (parsed.error) { sendJson(res, 400, { error: parsed.error }); return; }
          const newValue = parsed.body['allowRemote'] === true;
          try {
            const dataDir = resolveDataDir();
            const cfg = loadMCPConfig(dataDir, { createIfMissing: true });
            cfg.allowRemote = newValue;
            saveMCPConfig(dataDir, cfg);
            // Manager (when wired) reads allowRemote once at construct, so
            // the running process won't pick up the new value without a
            // restart. Reflect that honestly in the response.
            sendJson(res, 200, { allowRemote: newValue, requiresRestart: true });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // PUT /api/mcp/servers/:name — upsert server config + optional toggle.
        // DELETE /api/mcp/servers/:name — remove a server.
        const mcpServerMatch = route.match(/^\/api\/mcp\/servers\/([^/]+)$/);
        if (mcpServerMatch && (method === 'PUT' || method === 'DELETE')) {
          const name = decodeURIComponent(mcpServerMatch[1]);
          // Defensive name validation — blocks `..`, slashes, unsafe chars.
          if (!MCP_NAME_REGEX.test(name)) {
            sendJson(res, 400, { error: `Invalid server name. Must match ${MCP_NAME_REGEX} (got "${name}")` });
            return;
          }
          const dataDir = resolveDataDir();
          const mgr = (agent as unknown as { getMCPClientManager?: () => {
            upsertServer(name: string, cfg: Partial<MCPServerConfig>): void;
            setServerEnabled(name: string, enabled: boolean): Promise<void>;
            removeServer(name: string): Promise<void>;
          } | null }).getMCPClientManager?.();

          if (method === 'DELETE') {
            try {
              const loaded = loadMCPConfig(dataDir, { createIfMissing: true });
              // Deep-clone the mcpServers map: loadMCPConfig returns a shallow
              // clone so mutating cfg.mcpServers also mutates DEFAULT_MCP_CONFIG.
              const cfg = { ...loaded, mcpServers: { ...loaded.mcpServers } };
              if (!cfg.mcpServers[name]) {
                sendJson(res, 404, { error: `Unknown MCP server: ${name}` });
                return;
              }
              delete cfg.mcpServers[name];
              saveMCPConfig(dataDir, cfg);
              if (mgr) { try { await mgr.removeServer(name); } catch (err) { log.warn({ err: String(err), name }, 'manager.removeServer failed (config still removed)'); } }
              sendJson(res, 200, { name, removed: true });
            } catch (e) {
              sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
            }
            return;
          }

          // PUT
          const parsed = await readJsonCapped(req, MCP_BODY_MAX_BYTES);
          if (parsed.error) { sendJson(res, 400, { error: parsed.error }); return; }
          const body = parsed.body;
          // Reject unknown fields (defense in depth — silly didn't do this).
          const unknown = Object.keys(body).filter((k) => !MCP_ALLOWED_FIELDS.has(k));
          if (unknown.length > 0) {
            sendJson(res, 400, { error: `Unknown fields rejected: ${unknown.join(', ')}. Allowed: ${[...MCP_ALLOWED_FIELDS].join(', ')}` });
            return;
          }
          const configFields = ['command', 'args', 'url', 'transport', 'env', 'headers', 'description', 'safety', 'toolAllowlist'] as const;
          const hasConfigFields = configFields.some((k) => k in body);
          const cfgPatch: Partial<MCPServerConfig> = {};
          for (const k of configFields) if (k in body) (cfgPatch as Record<string, unknown>)[k] = body[k];

          try {
            // 1. Validate before persisting (when caller is creating/updating fields).
            if (hasConfigFields) {
              const errors = validateServerConfig(cfgPatch);
              if (errors.length > 0) {
                sendJson(res, 400, { error: `Invalid server config: ${errors.join('; ')}` });
                return;
              }
            }
            // 2. Apply via the file (always works whether mgr is wired or not).
            //    Deep-clone mcpServers so we never mutate DEFAULT_MCP_CONFIG via
            //    the shallow clone returned by loadMCPConfig.
            const loaded = loadMCPConfig(dataDir, { createIfMissing: true });
            const cfg = { ...loaded, mcpServers: { ...loaded.mcpServers } };
            const existing = cfg.mcpServers[name];

            // Refuse enabled-toggle on unknown server BEFORE any mutation.
            if (typeof body['enabled'] === 'boolean' && !hasConfigFields && !existing) {
              sendJson(res, 400, { error: `Cannot toggle enabled on unknown server: ${name}. Send command/url first.` });
              return;
            }

            if (hasConfigFields) {
              cfg.mcpServers[name] = {
                ...(existing ?? {}),
                ...cfgPatch,
                enabled: existing?.enabled === true,
              };
            }
            if (typeof body['enabled'] === 'boolean') {
              cfg.mcpServers[name].enabled = body['enabled'] === true;
            }
            saveMCPConfig(dataDir, cfg);

            // 3. Sync the running manager when present.
            if (mgr) {
              try {
                if (hasConfigFields) mgr.upsertServer(name, cfgPatch);
                if (typeof body['enabled'] === 'boolean') {
                  await mgr.setServerEnabled(name, body['enabled']);
                }
              } catch (err) {
                log.warn({ err: String(err), name }, 'manager mutation failed (config still saved)');
              }
            }
            sendJson(res, 200, { name, ok: true });
          } catch (e) {
            sendJson(res, 400, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Agent loops — read-only dashboard surface (engine getter returns null
        // until a future phase wires AgentLoopEngine). Routes degrade to empty.
        if (route === '/api/agent-loops/active' && method === 'GET') {
          try {
            const e = (agent as unknown as { getAgentLoopEngine?: () => { getActiveLoops?: () => unknown[] } | null }).getAgentLoopEngine?.();
            sendJson(res, 200, { active: e?.getActiveLoops?.() ?? [], available: !!e });
          } catch (err) {
            sendJson(res, 200, { active: [], available: false, error: String(err) });
          }
          return;
        }
        if (route === '/api/agent-loops/history' && method === 'GET') {
          try {
            const e = (agent as unknown as { getAgentLoopEngine?: () => { getLoopHistory?: () => unknown[] } | null }).getAgentLoopEngine?.();
            sendJson(res, 200, { history: e?.getLoopHistory?.() ?? [], available: !!e });
          } catch (err) {
            sendJson(res, 200, { history: [], available: false, error: String(err) });
          }
          return;
        }
        if (route === '/api/agent-loops/dashboard' && method === 'GET') {
          try {
            const e = (agent as unknown as { getAgentLoopEngine?: () => { getStatistics?: () => unknown } | null }).getAgentLoopEngine?.();
            sendJson(res, 200, { stats: e?.getStatistics?.() ?? null, available: !!e });
          } catch (err) {
            sendJson(res, 200, { stats: null, available: false, error: String(err) });
          }
          return;
        }

        // BuilderV2 runs — backed by MultiAgentBuildSupervisor when enabled
        if (route === '/api/builder/runs' && method === 'GET') {
          // First try MultiAgentSupervisor (legacy path). Then fall back to
          // the BuildQueueManager state which the BuilderV2-backed
          // /api/builder/run path populates.
          const sup = (agent as unknown as { getMultiAgentSupervisor?: () => { listPlans?: () => unknown[] } | null }).getMultiAgentSupervisor?.();
          if (sup) {
            try {
              const plans = sup.listPlans?.() ?? [];
              if (Array.isArray(plans) && plans.length > 0) {
                sendJson(res, 200, { runs: plans, available: true });
                return;
              }
            } catch { /* fall through to queue */ }
          }
          type QueueLike = { getState(): {
            running: { id: string; appName: string; workspace: string; startedAt: number } | null;
            queued: Array<{ id: string; appName: string; workspace: string; queuedAt: number }>;
            completed: Array<{ id: string; appName: string; status: string; completedAt: number }>;
          } };
          const queue = (agent as unknown as { getBuildQueue?: () => QueueLike }).getBuildQueue?.();
          if (!queue) {
            sendJson(res, 200, { runs: [], available: false, reason: 'features.builderV2 is off' });
            return;
          }
          try {
            const state = queue.getState();
            const runs = [
              ...(state.running ? [{ ...state.running, status: 'running' }] : []),
              ...state.queued.map((q) => ({ ...q, status: 'queued', startedAt: q.queuedAt })),
              ...state.completed.map((c) => ({ ...c, startedAt: c.completedAt })),
            ];
            sendJson(res, 200, { runs, available: true });
          } catch (e) {
            sendJson(res, 200, { runs: [], available: true, error: String(e) });
          }
          return;
        }

        // Models page — list configured providers as a richer view than /api/providers
        if (route === '/api/models' && method === 'GET') {
          try {
            const cfg = agent.getConfig();
            const providers = cfg.providers as Record<string, { model?: string; baseUrl?: string; maxTokens?: number }> | undefined;
            const models = providers
              ? Object.entries(providers).map(([id, p]) => ({
                id,
                model: p?.model ?? null,
                baseUrl: p?.baseUrl ?? null,
                maxTokens: p?.maxTokens ?? null,
                active: id === cfg.agent.defaultProvider,
              }))
              : [];
            sendJson(res, 200, { active: cfg.agent.defaultProvider, models });
          } catch (e) {
            sendJson(res, 200, { active: null, models: [], error: String(e) });
          }
          return;
        }

        // Runtime config — read-only snapshot (writes deferred to a later phase
        // because they touch provider/model selection internals).
        if (route === '/api/runtime/config' && method === 'GET') {
          try {
            const cfg = agent.getConfig();
            sendJson(res, 200, {
              defaultProvider: cfg.agent.defaultProvider,
              model: (cfg.providers as Record<string, { model?: string }>)?.[cfg.agent.defaultProvider]?.model ?? null,
              features: cfg.features ?? {},
              retrieval: cfg.agent.retrieval ?? { enabled: false },
              entityIndexing: cfg.agent.entityIndexing ?? { enabled: false },
              intelligence: cfg.agent.intelligence ?? { enabled: false, observationOnly: true },
            });
          } catch (e) {
            sendJson(res, 500, { error: String(e) });
          }
          return;
        }

        // Health/integrity combo for the dashboard "system status" widget
        if (route === '/api/health/integrity' && method === 'GET') {
          try {
            const ih = (agent as unknown as { getIntelligenceHardening?: () => { diagnostics?: () => unknown } }).getIntelligenceHardening?.();
            const ag = (agent as unknown as { getAutonomyGate?: () => { status?: () => unknown } }).getAutonomyGate?.();
            sendJson(res, 200, {
              ok: true,
              hardening: ih?.diagnostics?.() ?? null,
              autonomy: ag?.status?.() ?? null,
            });
          } catch (e) {
            sendJson(res, 200, { ok: false, error: String(e) });
          }
          return;
        }

        // ─── Cognitive document routes (real DB-backed; SPA Cognitive page) ─
        // GET /api/cognitive/document/:id — returns the same MemoryDetail
        //   shape that /api/memory/control-center/:id returns; the Cognitive
        //   page expects this for individual documents.
        // POST /api/cognitive/search { q, type? } — runs the same listing
        //   used by gateway/query but exposed under the Cognitive namespace.
        // GET /api/memory/gateway/document/:id — alias for the gateway API.
        if (route.startsWith('/api/cognitive/document/') && method === 'GET') {
          try {
            const db = await getMemoryDbHandle(agent);
            if (!db) { sendJson(res, 503, { error: 'no database' }); return; }
            const rawId = decodeURIComponent(route.slice('/api/cognitive/document/'.length));
            const id = rawId.startsWith('doc:') || rawId.startsWith('note:') ? rawId : `doc:${rawId}`;
            const detail = getMemoryDetail(db, id);
            if (!detail) { sendJson(res, 404, { error: `not found: ${id}` }); return; }
            sendJson(res, 200, detail);
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }
        if (route.startsWith('/api/memory/gateway/document/') && method === 'GET') {
          try {
            const db = await getMemoryDbHandle(agent);
            if (!db) { sendJson(res, 503, { error: 'no database' }); return; }
            const rawId = decodeURIComponent(route.slice('/api/memory/gateway/document/'.length));
            const id = rawId.startsWith('doc:') || rawId.startsWith('note:') ? rawId : `doc:${rawId}`;
            const detail = getMemoryDetail(db, id);
            if (!detail) { sendJson(res, 404, { error: `not found: ${id}` }); return; }
            sendJson(res, 200, detail);
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }
        if (route === '/api/cognitive/search' && method === 'POST') {
          try {
            const db = await getMemoryDbHandle(agent);
            if (!db) { sendJson(res, 200, { items: [], totalCount: 0 }); return; }
            const body = await parseBody(req).catch(() => ({}));
            const q = String((body as { q?: unknown }).q ?? '');
            const type = (body as { type?: unknown }).type as string | undefined;
            const result = listMemoryItems(db, { q, type, pageSize: 100 });
            sendJson(res, 200, result);
          } catch (e) {
            sendJson(res, 500, { items: [], totalCount: 0, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Cognitive diagnostics + documents (read-only DB views)
        if (route === '/api/cognitive/diagnostics' && method === 'GET') {
          try {
            const db = await getMemoryDbHandle(agent) as unknown as { prepare(s: string): { get(...a: unknown[]): unknown } } | null;
            const counts: Record<string, number> = {};
            if (db) {
              for (const t of ['documents', 'document_chunks', 'entities', 'entity_aliases']) {
                try {
                  const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n?: number } | undefined;
                  counts[t] = Number(r?.n ?? 0);
                } catch { counts[t] = 0; }
              }
            }
            sendJson(res, 200, { available: !!db, counts });
          } catch (e) {
            sendJson(res, 200, { available: false, counts: {}, error: String(e) });
          }
          return;
        }
        if (route === '/api/cognitive/documents' && method === 'GET') {
          try {
            const db = await getMemoryDbHandle(agent) as unknown as { prepare(s: string): { all(...a: unknown[]): unknown[] } } | null;
            if (!db) { sendJson(res, 200, { documents: [] }); return; }
            try {
              const rows = db.prepare(`SELECT * FROM documents ORDER BY created_at DESC LIMIT 200`).all();
              sendJson(res, 200, { documents: rows });
            } catch {
              sendJson(res, 200, { documents: [] });
            }
          } catch (e) {
            sendJson(res, 200, { documents: [], error: String(e) });
          }
          return;
        }

        // ─── Cognitive Books subsystem ─────────────────────────────────
        // GET    /api/cognitive/books                  → list books
        // GET    /api/cognitive/books/:id              → book + pages
        // PATCH  /api/cognitive/books/:id/collection   → update collection
        // POST   /api/cognitive/ingest-book            → multipart OCR upload
        //
        // All routes resolve through the cognitive-adapter which binds to
        // the same SQLite file as memory-db (cognitive_memory.db when
        // available, agent.getDatabase() in tests). Schema-tolerant where
        // possible; honest 503/422 when OCR/tables aren't reachable.
        if (route === '/api/cognitive/books' && method === 'GET') {
          try {
            const svc = await getCognitiveServices(agent);
            if (!svc) { sendJson(res, 503, { error: 'Cognitive DB not available' }); return; }
            // Probe documents schema once per request — silly cognitive_memory.db
            // and main agentx.db (after migration 001) have different columns.
            const cols = new Set<string>();
            try {
              const info = svc.db.prepare(`PRAGMA table_info(documents)`).all() as Array<{ name?: string }>;
              for (const r of info) if (r.name) cols.add(r.name);
            } catch { /* */ }
            const hasMeta = cols.has('metadata_json');
            const hasWordCount = cols.has('word_count');
            const hasCreated = cols.has('created_at');
            const hasUpdated = cols.has('updated_at');
            const hasIngested = cols.has('ingested_at');
            if (!hasMeta) {
              // No metadata_json column means no book metadata can be stored.
              // Books table is effectively unbacked on this schema. Return [].
              sendJson(res, 200, { books: [] });
              return;
            }
            const dateExpr = hasUpdated && hasCreated ? 'COALESCE(d.updated_at, d.created_at)'
              : hasUpdated ? 'd.updated_at'
              : hasCreated ? 'd.created_at'
              : hasIngested ? 'd.ingested_at'
              : "''";
            const createdExpr = hasCreated ? 'd.created_at'
              : hasIngested ? 'd.ingested_at'
              : "''";
            const updatedExpr = hasUpdated ? 'd.updated_at' : createdExpr;
            const wordCountExpr = hasWordCount ? 'd.word_count' : '0';
            let rows: Array<Record<string, unknown>> = [];
            try {
              rows = svc.db.prepare(
                `SELECT d.document_id, d.file_name, d.mime_type,
                        d.metadata_json AS metadata_json,
                        ${createdExpr} AS created_at,
                        ${updatedExpr} AS updated_at,
                        ${wordCountExpr} AS word_count,
                        (SELECT COUNT(*) FROM document_pages dp WHERE dp.document_id = d.document_id) AS page_count,
                        (SELECT ROUND(AVG(ocr_confidence), 2) FROM document_pages dp WHERE dp.document_id = d.document_id) AS avg_ocr_confidence
                 FROM documents d
                 WHERE d.metadata_json LIKE '%"type":"book"%'
                 ORDER BY ${dateExpr} DESC`,
              ).all() as Array<Record<string, unknown>>;
            } catch {
              rows = [];
            }
            const books = rows.map((b) => {
              let collection = 'Uncategorised';
              try {
                const meta = JSON.parse(String(b['metadata_json'] ?? '{}')) as Record<string, unknown>;
                if (typeof meta['collection'] === 'string') collection = meta['collection'] as string;
              } catch { /* */ }
              return {
                document_id: b['document_id'],
                name: b['file_name'],
                mime_type: b['mime_type'],
                page_count: Number(b['page_count'] ?? 0),
                word_count: Number(b['word_count'] ?? 0),
                avg_ocr_confidence: b['avg_ocr_confidence'],
                created_at: b['created_at'],
                updated_at: b['updated_at'],
                collection,
              };
            });
            sendJson(res, 200, { books });
          } catch (e) {
            sendJson(res, 500, { books: [], error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // GET /api/cognitive/books/diagnostics — must come BEFORE :id handler
        if (route === '/api/cognitive/books/diagnostics' && method === 'GET') {
          try {
            await getCognitiveServices(agent);
            sendJson(res, 200, getCognitiveDiagnostics());
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // GET /api/cognitive/books/:id — book detail with pages
        if (route.startsWith('/api/cognitive/books/')
          && method === 'GET'
          && route !== '/api/cognitive/books/diagnostics'
          && !route.endsWith('/collection')
          && !route.includes('/page/')) {
          try {
            const docId = decodeURIComponent(route.slice('/api/cognitive/books/'.length));
            const svc = await getCognitiveServices(agent);
            if (!svc) { sendJson(res, 503, { error: 'Cognitive DB not available' }); return; }
            // Probe schema for compatibility
            const cols = new Set<string>();
            try {
              const info = svc.db.prepare(`PRAGMA table_info(documents)`).all() as Array<{ name?: string }>;
              for (const r of info) if (r.name) cols.add(r.name);
            } catch { /* */ }
            const metaExpr = cols.has('metadata_json') ? 'metadata_json' : "'{}' AS metadata_json";
            const wordCountExpr = cols.has('word_count') ? 'word_count' : '0 AS word_count';
            const createdExpr = cols.has('created_at') ? 'created_at'
              : cols.has('ingested_at') ? 'ingested_at AS created_at' : "'' AS created_at";
            const updatedExpr = cols.has('updated_at') ? 'updated_at' : `${createdExpr.includes(' AS ') ? createdExpr.split(' AS ')[0] : createdExpr} AS updated_at`;
            let doc: Record<string, unknown> | undefined;
            try {
              doc = svc.db.prepare(
                `SELECT document_id, file_name, mime_type,
                        ${metaExpr}, ${wordCountExpr}, ${createdExpr}, ${updatedExpr}
                 FROM documents WHERE document_id = ?`,
              ).get(docId) as Record<string, unknown> | undefined;
            } catch { doc = undefined; }
            if (!doc) { sendJson(res, 404, { error: `book not found: ${docId}` }); return; }
            let metadata: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(String(doc['metadata_json'] ?? '{}'));
              if (parsed && typeof parsed === 'object') metadata = parsed as Record<string, unknown>;
            } catch { /* */ }
            // document_pages uses `content` in main schema, `page_text` in silly.
            const pageCols = new Set<string>();
            try {
              const info = svc.db.prepare(`PRAGMA table_info(document_pages)`).all() as Array<{ name?: string }>;
              for (const r of info) if (r.name) pageCols.add(r.name);
            } catch { /* */ }
            const textCol = pageCols.has('page_text') ? 'page_text' : pageCols.has('content') ? 'content' : 'content';
            let pages: Array<Record<string, unknown>> = [];
            try {
              pages = svc.db.prepare(
                `SELECT page_id, page_number, ${textCol} AS page_text, ocr_confidence
                 FROM document_pages WHERE document_id = ? ORDER BY page_number ASC`,
              ).all(docId) as Array<Record<string, unknown>>;
            } catch { pages = []; }
            sendJson(res, 200, {
              document_id: doc['document_id'],
              name: doc['file_name'],
              mime_type: doc['mime_type'],
              word_count: Number(doc['word_count'] ?? 0),
              page_count: pages.length,
              created_at: doc['created_at'],
              updated_at: doc['updated_at'],
              collection: typeof metadata['collection'] === 'string' ? metadata['collection'] : 'Uncategorised',
              metadata,
              pages: pages.map((p) => ({
                page_id: p['page_id'],
                page_number: Number(p['page_number'] ?? 0),
                page_text: String(p['page_text'] ?? ''),
                ocr_confidence: typeof p['ocr_confidence'] === 'number' ? p['ocr_confidence'] : null,
              })),
            });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // PATCH /api/cognitive/books/:id/collection — update metadata.collection
        if (route.startsWith('/api/cognitive/books/')
          && route.endsWith('/collection')
          && (method === 'PATCH' || method === 'POST')) {
          try {
            const docId = decodeURIComponent(route.slice('/api/cognitive/books/'.length, -('/collection'.length)));
            const { body, error } = await readJsonCapped(req, 32 * 1024);
            if (error) { sendJson(res, 400, { error }); return; }
            const collection = body['collection'];
            if (typeof collection !== 'string') {
              sendJson(res, 400, { error: 'collection must be a string' });
              return;
            }
            const svc = await getCognitiveServices(agent);
            if (!svc) { sendJson(res, 503, { error: 'Cognitive DB not available' }); return; }
            const existing = svc.db
              .prepare(`SELECT metadata_json FROM documents WHERE document_id = ?`)
              .get(docId) as { metadata_json?: string } | undefined;
            if (!existing) { sendJson(res, 404, { error: `book not found: ${docId}` }); return; }
            let meta: Record<string, unknown> = {};
            try {
              const parsed = JSON.parse(String(existing.metadata_json ?? '{}'));
              if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
            } catch { /* */ }
            if (collection.trim().length === 0) delete meta['collection'];
            else meta['collection'] = collection.trim();
            svc.db.prepare(`UPDATE documents SET metadata_json = ? WHERE document_id = ?`)
              .run(JSON.stringify(meta), docId);
            sendJson(res, 200, { ok: true, document_id: docId, collection: meta['collection'] ?? null });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // POST /api/cognitive/ingest-book — multipart image upload → OCR per page
        if (route === '/api/cognitive/ingest-book' && method === 'POST') {
          try {
            let parsed;
            try {
              parsed = await parseMultipartBody(req, { maxBytes: 250 * 1024 * 1024 });
            } catch (e) {
              const status = e instanceof MultipartError ? e.status : 400;
              sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
              return;
            }
            const bookName = (parsed.fields['book_name'] ?? '').trim();
            const existingDocId = (parsed.fields['document_id'] ?? '').trim();
            const collection = (parsed.fields['collection'] ?? '').trim();
            if (!bookName && !existingDocId) {
              sendJson(res, 400, { error: 'book_name or document_id field is required' });
              return;
            }
            if (parsed.files.length === 0) {
              sendJson(res, 400, { error: 'no image files in multipart body' });
              return;
            }
            // Load tesseract.js — honest 422 when not present.
            type CreateWorker = (lang: string) => Promise<{
              recognize(buf: Buffer): Promise<{ data: { text?: string; confidence?: number } }>;
              terminate(): Promise<void>;
            }>;
            let createWorker: CreateWorker | null = null;
            try {
              const Tesseract = (await import('tesseract.js' as string)) as {
                createWorker?: CreateWorker;
                default?: { createWorker?: CreateWorker };
              };
              createWorker = Tesseract.createWorker ?? Tesseract.default?.createWorker ?? null;
            } catch {
              createWorker = null;
            }
            if (!createWorker) {
              sendJson(res, 422, {
                error: 'OCR engine unavailable',
                reason: 'tesseract.js could not be loaded. Install it to enable book ingestion.',
              });
              return;
            }
            const svc = await getCognitiveServices(agent);
            if (!svc) { sendJson(res, 503, { error: 'Cognitive DB not available' }); return; }
            // Sort files by filename so page order is preserved.
            const files = parsed.files.slice().sort((a, b) =>
              a.filename.localeCompare(b.filename, undefined, { numeric: true }),
            );
            const totalSize = files.reduce((s, f) => s + f.data.length, 0);
            let documentId = existingDocId;
            let startPage = 1;
            const isAppend = !!existingDocId;
            if (isAppend) {
              const existing = svc.db
                .prepare(`SELECT document_id FROM documents WHERE document_id = ?`)
                .get(documentId) as { document_id?: string } | undefined;
              if (!existing) { sendJson(res, 404, { error: `book not found: ${documentId}` }); return; }
              const maxPage = svc.db
                .prepare(`SELECT MAX(page_number) AS max_page FROM document_pages WHERE document_id = ?`)
                .get(documentId) as { max_page?: number } | undefined;
              startPage = (maxPage?.max_page ?? 0) + 1;
            } else {
              const crypto = await import('node:crypto');
              documentId = `doc_${crypto.randomBytes(8).toString('hex')}`;
              const meta: Record<string, unknown> = { type: 'book' };
              if (collection) meta['collection'] = collection;
              const nowIso = new Date().toISOString();
              // Schema-tolerant INSERT: probe documents columns and only set
              // those that exist. Required columns differ between main (NOT NULL
              // file_type, content_type, ingested_at, updated_at) and silly
              // (file_path, file_size_bytes, document_date).
              try {
                const docCols = new Set<string>();
                const info = svc.db.prepare(`PRAGMA table_info(documents)`).all() as Array<{ name?: string }>;
                for (const r of info) if (r.name) docCols.add(r.name);
                const fields: Record<string, unknown> = {
                  document_id: documentId,
                  file_name: bookName,
                  mime_type: 'image/book-collection',
                  classification_label: 'knowledge_base',
                  origin_type: 'file',
                };
                if (docCols.has('file_type')) fields['file_type'] = 'book';
                if (docCols.has('file_path')) fields['file_path'] = `book://${bookName}`;
                if (docCols.has('content_type')) fields['content_type'] = 'document';
                if (docCols.has('file_size_bytes')) fields['file_size_bytes'] = totalSize;
                if (docCols.has('classification_confidence')) fields['classification_confidence'] = 1.0;
                if (docCols.has('document_date')) fields['document_date'] = nowIso;
                if (docCols.has('extraction_status')) fields['extraction_status'] = 'pending';
                if (docCols.has('indexing_status')) fields['indexing_status'] = 'pending';
                if (docCols.has('word_count')) fields['word_count'] = 0;
                if (docCols.has('metadata_json')) fields['metadata_json'] = JSON.stringify(meta);
                if (docCols.has('created_at')) fields['created_at'] = nowIso;
                if (docCols.has('updated_at')) fields['updated_at'] = nowIso;
                if (docCols.has('ingested_at')) fields['ingested_at'] = Date.now();
                const keys = Object.keys(fields);
                const placeholders = keys.map(() => '?').join(',');
                const sql = `INSERT OR IGNORE INTO documents (${keys.join(',')}) VALUES (${placeholders})`;
                svc.db.prepare(sql).run(...keys.map((k) => fields[k]));
              } catch (sqlErr) {
                sendJson(res, 500, { error: 'failed to insert document row', detail: String(sqlErr) });
                return;
              }
            }
            // OCR each page
            const crypto = await import('node:crypto');
            const worker = await createWorker('eng');
            const pageResults: Array<{
              page: number; filename: string; words: number; confidence: number;
            }> = [];
            let newWordCount = 0;
            try {
              for (let i = 0; i < files.length; i++) {
                const file = files[i];
                const pageNum = startPage + i;
                try {
                  const { data } = await worker.recognize(file.data);
                  const pageText = (data.text ?? '').trim();
                  const confidence = (data.confidence ?? 0) / 100;
                  const words = pageText.split(/\s+/).filter((w) => w.length > 0).length;
                  newWordCount += words;
                  // Schema-tolerant page insert (silly: page_text, main: content)
                  const pgCols = new Set<string>();
                  try {
                    const info = svc.db.prepare(`PRAGMA table_info(document_pages)`).all() as Array<{ name?: string }>;
                    for (const r of info) if (r.name) pgCols.add(r.name);
                  } catch { /* */ }
                  const pageTextCol = pgCols.has('page_text') ? 'page_text' : 'content';
                  svc.db.prepare(
                    `INSERT OR REPLACE INTO document_pages (
                      page_id, document_id, page_number, ${pageTextCol}, ocr_confidence, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?)`,
                  ).run(
                    `page_${crypto.randomBytes(6).toString('hex')}`,
                    documentId, pageNum, pageText, confidence, new Date().toISOString(),
                  );
                  pageResults.push({ page: pageNum, filename: file.filename, words, confidence: Math.round(confidence * 100) });
                } catch (pageErr) {
                  pageResults.push({ page: pageNum, filename: file.filename, words: 0, confidence: 0 });
                  (await import('@agentx/core')).createLogger('web:ingest-book').warn(
                    { err: (pageErr as Error).message, page: pageNum }, 'OCR page failed',
                  );
                }
              }
            } finally {
              try { await worker.terminate(); } catch { /* */ }
            }
            // Update document word_count if the column exists (silly schema only)
            try {
              const docCols = new Set<string>();
              const info = svc.db.prepare(`PRAGMA table_info(documents)`).all() as Array<{ name?: string }>;
              for (const r of info) if (r.name) docCols.add(r.name);
              if (docCols.has('word_count')) {
                svc.db.prepare(`UPDATE documents SET word_count = ?, updated_at = ? WHERE document_id = ?`)
                  .run(newWordCount, new Date().toISOString(), documentId);
              } else if (docCols.has('updated_at')) {
                svc.db.prepare(`UPDATE documents SET updated_at = ? WHERE document_id = ?`)
                  .run(new Date().toISOString(), documentId);
              }
            } catch { /* */ }
            sendJson(res, 200, {
              ok: true,
              document_id: documentId,
              book_name: bookName,
              is_append: isAppend,
              pages_ingested: pageResults.length,
              pages: pageResults,
              total_word_count: newWordCount,
            });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Build memory — additional record endpoint (POST). DB write is best-
        // effort: the table may not exist on a fresh DB, in which case this
        // returns 501 rather than crashing.
        if (route === '/api/build-memory/record' && method === 'POST') {
          try {
            const body = await parseBody(req).catch(() => ({}));
            const db = (agent as unknown as { getDatabase?: () => unknown }).getDatabase?.();
            if (!db) { sendJson(res, 503, { ok: false, reason: 'No database' }); return; }
            // Best-effort insert — if table absent we report unimplemented.
            try {
              const stmt = (db as { prepare(s: string): { run(...a: unknown[]): unknown } })
                .prepare(`INSERT INTO build_memory (payload, created_at) VALUES (?, ?)`);
              stmt.run(JSON.stringify(body), Date.now());
              sendJson(res, 200, { ok: true });
            } catch (sqlErr) {
              sendJson(res, 501, { ok: false, reason: 'build_memory table missing — needs migration', error: String(sqlErr) });
            }
          } catch (e) {
            sendJson(res, 500, { ok: false, error: String(e) });
          }
          return;
        }

        // Command Center HTML — embedded dashboard tab (lifted helper)
        if (route === '/api/command-center' && method === 'GET') {
          try {
            // Imported lazily so the api module doesn't pay for the helper
            // on cold start unless someone requests it.
            const { renderCommandCenter } = await import('../command-center.js') as {
              renderCommandCenter?: () => string;
            };
            if (typeof renderCommandCenter === 'function') {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(renderCommandCenter());
            } else {
              sendJson(res, 501, { available: false, reason: 'Command center renderer missing' });
            }
          } catch (e) {
            sendJson(res, 500, { error: String(e) });
          }
          return;
        }

        // Device Permission Center HTML
        if (route === '/api/device/permission-center' && method === 'GET') {
          try {
            const { renderDevicePermissionCenter } = await import('../device-permission-center.js') as {
              renderDevicePermissionCenter?: () => string;
            };
            if (typeof renderDevicePermissionCenter === 'function') {
              res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
              res.end(renderDevicePermissionCenter());
            } else {
              sendJson(res, 501, { available: false, reason: 'Device permission center renderer missing' });
            }
          } catch (e) {
            sendJson(res, 500, { error: String(e) });
          }
          return;
        }

        // Builder queue — read-only (returns empty when not enabled)
        // ─── Tier 3 Builder Batch 2: queue routes ───────────────────────
        // GET /api/builder/queue        — silly-shape state + idle status
        // POST /api/builder/queue/cancel — mark current build cancelled
        // POST /api/builder/queue/clear  — drain pending queue
        //
        // All three use lazy-init getters in agent.ts. Cancel/clear are
        // best-effort: cancelCurrent() flips state but the runner (not
        // yet wired) is responsible for actually aborting work. Until
        // POST /api/builder/run is wired in a later batch, both routes
        // are correct-shape no-ops on an empty queue.
        if (route === '/api/builder/queue' && method === 'GET') {
          try {
            type Mgr = { getState(): unknown };
            type Idle = { getStatus(): unknown };
            const queue = (agent as unknown as { getBuildQueue?: () => Mgr }).getBuildQueue?.();
            const idle = (agent as unknown as { getIdleManager?: () => Idle }).getIdleManager?.();
            if (!queue || !idle) {
              // Defensive: should never happen because the agent has lazy
              // getters that always return non-null, but leave a safe
              // fallback so unit tests with stub agents still get JSON.
              sendJson(res, 200, { queue: [], available: false, reason: 'BuildQueueManager not yet wired' });
              return;
            }
            const state = queue.getState() as Record<string, unknown>;
            sendJson(res, 200, { ...state, idle: idle.getStatus() });
          } catch (e) {
            sendJson(res, 200, { queue: [], available: false, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // GET /api/builder/queue/events — SSE stream of queue state.
        //
        // Emits the current queue snapshot immediately on connect, then
        // re-emits whenever the state changes. State-change detection is
        // a 1 Hz hash diff of getState(); zero core/BuildQueueManager
        // changes. Heartbeat every 15s as an SSE comment so the
        // connection stays warm through proxies.
        //
        // Event shape: `event: state\ndata: {running, queued[], completed[]}\n\n`
        // Heartbeat:   `: heartbeat\n\n` (SSE comment line)
        //
        // Background builds submitted via POST /api/builder/run flow
        // through BuildQueueManager which is the same source this watcher
        // reads — no race conditions, no double-emission, no fake events.
        if (route === '/api/builder/queue/events' && method === 'GET') {
          type Mgr = { getState(): unknown };
          const queue = (agent as unknown as { getBuildQueue?: () => Mgr }).getBuildQueue?.();
          if (!queue) { sendJson(res, 503, { error: 'Build queue not available' }); return; }
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
          });

          let lastHash = '';
          let closed = false;
          const emitIfChanged = (): void => {
            if (closed) return;
            try {
              const state = queue.getState();
              const json = JSON.stringify(state);
              if (json !== lastHash) {
                lastHash = json;
                res.write(`event: state\ndata: ${json}\n\n`);
              }
            } catch (err) {
              try {
                res.write(`event: error\ndata: ${JSON.stringify({ message: err instanceof Error ? err.message : String(err) })}\n\n`);
              } catch { /* socket closed */ }
            }
          };

          // Initial state — always emit, even when queue is empty, so
          // the client knows the connection is live.
          emitIfChanged();

          const stateTimer = setInterval(emitIfChanged, 1000);
          const heartbeat = setInterval(() => {
            if (closed) return;
            try { res.write(`: heartbeat ${Date.now()}\n\n`); }
            catch { /* socket closed — cleanup below */ }
          }, 15_000);

          const cleanup = (): void => {
            closed = true;
            clearInterval(stateTimer);
            clearInterval(heartbeat);
          };
          req.on('close', cleanup);
          req.on('error', cleanup);
          return;
        }

        if (route === '/api/builder/queue/cancel' && method === 'POST') {
          try {
            type Mgr = { cancelCurrent(): boolean; getState(): unknown };
            const queue = (agent as unknown as { getBuildQueue?: () => Mgr }).getBuildQueue?.();
            if (!queue) { sendJson(res, 503, { error: 'Build queue not available' }); return; }
            const cancelled = queue.cancelCurrent();
            sendJson(res, 200, { cancelled, state: queue.getState() });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        if (route === '/api/builder/queue/clear' && method === 'POST') {
          try {
            type Mgr = { clearQueue(): number; getState(): unknown };
            const queue = (agent as unknown as { getBuildQueue?: () => Mgr }).getBuildQueue?.();
            if (!queue) { sendJson(res, 503, { error: 'Build queue not available' }); return; }
            const cleared = queue.clearQueue();
            sendJson(res, 200, { cleared, state: queue.getState() });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // ─── Tier 3 Models/Routing Batch: GET/POST /api/models/routing ──
        // Strategy 3 — route-level read/write of `~/.agentx/routing.json`.
        // No agent.ts instantiation. ModelFabric is null on this branch;
        // the route surface mirrors silly's so the Settings UI can render
        // the routing table even when the runtime fabric is offline.
        //
        // GET returns: { policy, availableModels, ollama: { reachable, host } }
        //   - policy:           merged defaults + persisted routing.json
        //   - availableModels:  live Ollama probe (5s timeout) → [] when unreachable
        //   - ollama.reachable: false on probe failure (does NOT 500)
        //
        // POST accepts a JSON body matching RoutingPolicyConfig. Validates
        // via `validateRoutingConfig`, persists atomically, returns the
        // normalised value.
        if (route === '/api/models/routing' && method === 'GET') {
          try {
            const dataDir = resolveDataDir();
            const policy = loadRoutingConfig(dataDir);
            const ollama = await probeOllamaModels({ timeoutMs: 5000 });
            // Models page (Silly Johnson) expects an enriched
            // `RoutingState`-shaped object with models[] + diagnostics +
            // config. Provide silly-compatible aliases alongside the
            // existing test-pinned fields. Live Ollama models → cast to
            // RegisteredModelView with privacyLevel='local'. Cloud
            // providers (anthropic/openai) are reported as registered when
            // their respective API key env vars are present.
            const liveModels = ollama.models.map((m) => ({
              id: m.name,
              provider: 'ollama',
              capabilities: ['text'],
              privacyLevel: 'local' as const,
              enabled: true,
              ...(typeof m.size === 'number' ? { size: m.size } : {}),
            }));
            const cloudModels: Array<Record<string, unknown>> = [];
            if (process.env['ANTHROPIC_API_KEY']) {
              cloudModels.push({
                id: 'claude-sonnet-4-20250514', provider: 'anthropic',
                capabilities: ['text', 'code', 'reasoning'],
                privacyLevel: 'cloud', enabled: true,
              });
            }
            if (process.env['OPENAI_API_KEY']) {
              cloudModels.push({
                id: 'gpt-4o', provider: 'openai',
                capabilities: ['text', 'code', 'reasoning'],
                privacyLevel: 'cloud', enabled: true,
              });
            }
            const models = [...liveModels, ...cloudModels];
            sendJson(res, 200, {
              // Strategy-3 fields (tests pin these)
              policy,
              availableModels: ollama.models,
              ollama: { reachable: ollama.reachable, host: ollama.host },
              // Silly-compatible aliases so Models.tsx renders
              mode: policy.mode,
              config: {
                mode: policy.mode,
                localFirst: policy.mode !== 'SUBSCRIPTION_ONLY',
                maxLocalFailuresBeforeCloud: policy.maxLocalFailuresBeforeCloud ?? 3,
                allowCloudForLatencySensitiveTasks: policy.allowCloudForLatencySensitiveTasks ?? false,
                latencySensitiveThresholdMs: policy.latencySensitiveThresholdMs ?? 1000,
                capabilityPins: policy.capabilityPins ?? {},
                contextOverflowTokens: policy.contextOverflowTokens ?? 28_000,
              },
              capabilityPins: policy.capabilityPins ?? {},
              models,
              fallbackChains: {},
              capabilityRouting: {},
              performance: null,
              diagnostics: {
                registry: {
                  totalRegistered: models.length,
                  enabledCount: models.filter((m) => m.enabled !== false).length,
                  localCount: liveModels.length,
                  cloudCount: cloudModels.length,
                },
                policy: { cloudAllowed: policy.mode !== 'LOCAL_ONLY' },
              },
            });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        if (route === '/api/models/routing' && method === 'POST') {
          const { body, error } = await readJsonCapped(req, 32 * 1024);
          if (error) { sendJson(res, 400, { error }); return; }
          const validation = validateRoutingConfig(body);
          if (!validation.ok || !validation.value) {
            sendJson(res, 400, { error: 'invalid routing config', details: validation.errors });
            return;
          }
          try {
            const dataDir = resolveDataDir();
            // Merge into the existing routing.json so we don't drop fields
            // that other routes set (e.g. forceModel via select-local-model).
            // Live audit caught POST /api/models/routing {mode} wiping a
            // previously-persisted forceModel.
            const current = loadRoutingConfig(dataDir);
            const merged = { ...current, ...validation.value };
            saveRoutingConfig(dataDir, merged);
            sendJson(res, 200, { ok: true, policy: merged });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // ─── Chat Multimodal: POST /api/chat/multimodal ─────────────────
        // Additive design — does NOT replace /api/chat/stream and does NOT
        // touch agent.ts. The route accepts a multipart upload (message
        // field + attached files), extracts text/description from each
        // attachment using existing infrastructure (vision-service for
        // images, extraction pipeline for documents), composes an enriched
        // prompt, then delegates to the existing `agent.chat()` method.
        //
        // R1–R12 retrieval is unchanged because we go through the same
        // chat path; the only thing different is the user message contains
        // attachment-derived text appended to the original text.
        //
        // Honest unavailable behaviour:
        //   - image with no vision provider available → text placeholder
        //     "[image attached: vision provider unavailable]"
        //   - document extraction failure → "[file attached: extraction
        //     failed]"
        //   - empty `message` AND no files → 400
        //   - non-multipart body                                  → 400
        if (route === '/api/chat/multimodal' && method === 'POST') {
          // Streaming opt-in via ?stream=true. Default (no query) preserves
          // the non-streaming JSON response shape exactly — every existing
          // test + UI fallback still passes.
          const streamMode = /[?&]stream=(true|1|yes|on)\b/i.test(url);
          try {
            let parsed;
            try {
              parsed = await parseMultipartBody(req, { maxBytes: 50 * 1024 * 1024 });
            } catch (e) {
              const status = e instanceof MultipartError ? e.status : 400;
              sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
              return;
            }
            const message = (parsed.fields['message'] ?? '').trim();
            const sessionId = parsed.fields['sessionId']?.trim() || undefined;
            const persona = parsed.fields['persona']?.trim() || undefined;
            if (!message && parsed.files.length === 0) {
              sendJson(res, 400, { error: 'message or at least one file is required' });
              return;
            }
            // Process each attachment — images go through vision, others
            // through the buffer text-extractor.
            interface AttachmentSummary {
              filename: string;
              fieldName: string;
              size: number;
              mimeType: string;
              kind: 'image' | 'document' | 'unknown';
              available: boolean;
              text?: string;
              reason?: string;
            }
            const attachments: AttachmentSummary[] = [];
            for (const f of parsed.files) {
              const mime = (f.contentType || '').toLowerCase();
              const isImage = mime.startsWith('image/');
              if (isImage) {
                try {
                  const vr = await analyzeImageBuffer(f.data);
                  // Augment unavailable reasons with an install hint so the
                  // UI can show actionable guidance without parsing details.
                  const friendlyReason = vr.reason
                    ? `${vr.reason} — Tip: install qwen3-vl with \`ollama pull qwen3-vl:32b\` and start Ollama to enable image understanding.`
                    : undefined;
                  attachments.push({
                    filename: f.filename, fieldName: f.fieldName,
                    size: f.data.length, mimeType: mime || 'application/octet-stream',
                    kind: 'image',
                    available: vr.available,
                    text: vr.description,
                    reason: vr.available ? undefined : (friendlyReason ?? vr.reason),
                  });
                } catch (e) {
                  attachments.push({
                    filename: f.filename, fieldName: f.fieldName,
                    size: f.data.length, mimeType: mime, kind: 'image',
                    available: false,
                    reason: e instanceof Error ? e.message : String(e),
                  });
                }
              } else {
                try {
                  const er = await extractTextFromUpload(f.data, f.filename);
                  attachments.push({
                    filename: f.filename, fieldName: f.fieldName,
                    size: f.data.length, mimeType: mime || 'application/octet-stream',
                    kind: er.kind === 'unknown' ? 'unknown' : 'document',
                    available: !!er.text && er.text.length > 0,
                    text: er.text,
                  });
                } catch (e) {
                  attachments.push({
                    filename: f.filename, fieldName: f.fieldName,
                    size: f.data.length, mimeType: mime, kind: 'document',
                    available: false,
                    reason: e instanceof Error ? e.message : String(e),
                  });
                }
              }
            }
            // Compose enriched prompt. Cap each attachment-derived text
            // at 4 000 chars to keep prompt manageable.
            const parts: string[] = [];
            if (message) parts.push(message);
            for (const a of attachments) {
              const head = `\n\n[Attachment: ${a.filename} (${a.kind}, ${a.size} bytes)]`;
              if (a.available && a.text) {
                const trimmed = a.text.length > 4_000 ? a.text.slice(0, 4_000) + ' …[truncated]' : a.text;
                parts.push(`${head}\n${trimmed}`);
              } else {
                parts.push(`${head}\n[${a.kind} content unavailable${a.reason ? ': ' + a.reason : ''}]`);
              }
            }
            const enriched = parts.join('');
            // Public-shape attachment summary (no internal `text`, just
            // `preview` + `textLength`). Shared by streaming and non-
            // streaming branches.
            const publicAttachments = attachments.map((a) => ({
              filename: a.filename,
              kind: a.kind,
              size: a.size,
              mimeType: a.mimeType,
              available: a.available,
              reason: a.reason,
              preview: a.text ? a.text.slice(0, 300) + (a.text.length > 300 ? '…' : '') : undefined,
              textLength: a.text ? a.text.length : 0,
            }));
            // Friendly error categorisation — used by both branches.
            const categoriseError = (raw: string): { code: string; userMessage: string } => {
              if (/Could not resolve authentication method|api[- ]?key|authToken|Authorization/i.test(raw)) {
                return {
                  code: 'PROVIDER_AUTH_MISSING',
                  userMessage: 'Chat provider not configured. Set ANTHROPIC_API_KEY (or OPENAI_API_KEY), or switch to local Ollama with AGENT_DEFAULT_PROVIDER=ollama.',
                };
              }
              if (/Ollama|ECONNREFUSED|fetch failed/i.test(raw)) {
                return {
                  code: 'PROVIDER_UNREACHABLE',
                  userMessage: 'LLM provider unreachable. Start Ollama (`ollama serve`) or check the configured API endpoint.',
                };
              }
              if (/rate.?limit|429/i.test(raw)) {
                return {
                  code: 'PROVIDER_RATE_LIMITED',
                  userMessage: 'LLM provider rate-limited the request. Wait a moment and try again.',
                };
              }
              return { code: 'CHAT_EXECUTION_FAILED', userMessage: 'Chat execution failed.' };
            };

            // ─── Streaming branch ─────────────────────────────────────────
            // Opt-in via ?stream=true. Reuses agent.chatStream() so the same
            // R1–R12 retrieval callback the regular /api/chat/stream path
            // exposes fires here too.
            //
            // Event protocol — matches /api/chat/stream's data:{type,...}
            // shape so the existing chat-sse-parser handles both endpoints:
            //
            //   data: {"type":"attachment_processed", "filename":..., "kind":..., "available":..., ...}
            //   data: {"type":"chat_started", "sessionId":..., "multimodal":true, "persona"?:...}
            //   data: {"type":"retrieval", "retrieval":{...}}        (when onRetrieval fires)
            //   data: {"type":"token", "content":"..."}
            //   data: {"type":"done", "content":"...", "sessionId":"..."}
            //   data: {"type":"error", "code":"...", "message":"..."}
            if (streamMode) {
              res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no',
              });
              const write = (payload: Record<string, unknown>): void => {
                try { res.write(`data: ${JSON.stringify(payload)}\n\n`); }
                catch { /* socket closed */ }
              };
              for (const a of publicAttachments) write({ type: 'attachment_processed', ...a });
              write({
                type: 'chat_started',
                sessionId: sessionId ?? 'default',
                multimodal: attachments.length > 0,
                ...(persona ? { persona } : {}),
              });
              try {
                let accumulated = '';
                const finalContent = await (agent as unknown as {
                  chatStream(
                    input: string,
                    callbacks: {
                      onRetrieval?: (m: unknown) => void;
                      onToken?: (t: string) => void;
                      onError?: (err: Error) => void;
                      onComplete?: (resp: { content: string }) => void;
                    },
                    sessionId?: string,
                  ): Promise<string>;
                }).chatStream(enriched, {
                  onRetrieval: (metadata) => write({ type: 'retrieval', retrieval: metadata }),
                  onToken: (token) => {
                    accumulated += token;
                    write({ type: 'token', content: token });
                  },
                  onError: (err) => {
                    const { code, userMessage } = categoriseError(err.message);
                    write({ type: 'error', code, message: userMessage, detail: err.message });
                  },
                }, sessionId);
                write({
                  type: 'done',
                  content: typeof finalContent === 'string' && finalContent.length > 0 ? finalContent : accumulated,
                  sessionId: sessionId ?? 'default',
                });
              } catch (e) {
                const raw = e instanceof Error ? e.message : String(e);
                const { code, userMessage } = categoriseError(raw);
                write({ type: 'error', code, message: userMessage, detail: raw });
              } finally {
                try { res.end(); } catch { /* */ }
              }
              return;
            }

            // ─── Non-streaming branch (default — unchanged contract) ─────
            let response: string;
            try {
              response = await (agent as unknown as {
                chat(input: string, sessionId?: string, ctx?: unknown): Promise<string>;
              }).chat(enriched, sessionId, persona ? { persona } : undefined);
            } catch (e) {
              const raw = e instanceof Error ? e.message : String(e);
              const { code, userMessage } = categoriseError(raw);
              sendJson(res, 502, {
                error: userMessage,
                code,
                detail: raw,
                attachments: publicAttachments,
              });
              return;
            }
            sendJson(res, 200, {
              response,
              sessionId: sessionId ?? 'default',
              multimodal: attachments.length > 0,
              attachments: publicAttachments,
            });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // ─── Tier 3 Vision Batch: POST /api/vision/analyze ──────────────
        // Strategy 3: route-level vision analysis. Multipart upload (image
        // field), 25 MB cap. Delegates to `analyzeImageBuffer` which wraps
        // OllamaVisionProvider; tests substitute via setVisionProviderForTesting.
        //
        // Honest unavailable behaviour:
        //   - Ollama unreachable or model not installed → 200 {available:false, reason, model}
        //   - Provider returned a "[…]" placeholder        → 200 {available:false, …}
        //   - Success                                       → 200 {available:true, description, model, latencyMs}
        //   - Non-multipart body                            → 400
        //   - Missing image part                            → 400
        if (route === '/api/vision/analyze' && method === 'POST') {
          try {
            let parsed;
            try {
              parsed = await parseMultipartBody(req, { maxBytes: 25 * 1024 * 1024 });
            } catch (e) {
              const status = e instanceof MultipartError ? e.status : 400;
              sendJson(res, status, { error: e instanceof Error ? e.message : String(e) });
              return;
            }
            // Accept the first image-like part. Field names commonly used by
            // SPA pages: `image`, `file`, `upload`. Anything with a non-empty
            // buffer is accepted; we validate by simple length/type checks.
            const imagePart = parsed.files.find((f) =>
              f.fieldName === 'image' || f.fieldName === 'file' || f.fieldName === 'upload',
            ) ?? parsed.files[0];
            if (!imagePart || !imagePart.data || imagePart.data.length === 0) {
              sendJson(res, 400, { error: 'no image file in multipart body' });
              return;
            }
            const result = await analyzeImageBuffer(imagePart.data);
            sendJson(res, 200, {
              ...result,
              filename: imagePart.filename,
              size: imagePart.data.length,
            });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // ─── Builder/run — REAL implementation (BuilderV2-backed) ───────
        // Replaces the prior permanent shim. silly-johnson's upstream
        // /api/builder/run was dead code (BuildPlanner/BuildController =
        // null). This route is an AgentX original — it adapts the
        // request to BuilderV2 (packages/builder-v2) via builder-adapter.ts.
        //
        // Body (JSON, 32 KB cap):
        //   { prompt: string, appName?: string, platform?: string,
        //     workspace?: string, wait?: boolean }
        //
        //   wait=false (default): returns {id, status:"queued"} and the
        //     build runs through the BuildQueueManager in the background.
        //     The UI polls /api/builder/queue + /api/builder/artifacts.
        //   wait=true: blocks until the build finishes and returns the
        //     full BuildRunResult. Use sparingly; builds can take minutes.
        //
        // The route does NOT pre-validate the LLM provider — BuilderV2
        // throws inside the build if auth/model is missing, and the
        // queue surfaces the failure with the standard error envelope.
        if (route === '/api/builder/run' && method === 'POST') {
          const { body, error } = await readJsonCapped(req, 32 * 1024);
          if (error) { sendJson(res, 400, { error }); return; }
          const prompt = typeof body['prompt'] === 'string' ? (body['prompt'] as string).trim() : '';
          if (!prompt) { sendJson(res, 400, { error: 'prompt field is required' }); return; }
          const appName = typeof body['appName'] === 'string' ? (body['appName'] as string).trim() : undefined;
          const platform = typeof body['platform'] === 'string' ? (body['platform'] as string).trim() : undefined;
          const workspace = typeof body['workspace'] === 'string' ? (body['workspace'] as string).trim() : undefined;
          const wait = body['wait'] === true;

          // Lazy-import the adapter so this file doesn't pull builder-v2
          // into the TS dependency graph in unused branches (smaller test
          // boot when builder-adapter isn't exercised).
          const { runBuild } = await import('../builder-adapter.js');
          type QueueLike = {
            submit(opts: {
              id: string; appName: string; prompt: string; workspace: string;
              execute: () => Promise<unknown>;
            }): Promise<unknown>;
            getState(): unknown;
          };
          const queue = (agent as unknown as { getBuildQueue?: () => QueueLike }).getBuildQueue?.();
          if (!queue) {
            sendJson(res, 503, { error: 'Build queue not available' });
            return;
          }
          const buildId = `build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          const wsRoot = workspace ?? `${process.env['HOME']}/Projects/AGENTX_APPS`;
          const wsPath = `${wsRoot}/${buildId}-${(appName ?? 'app').replace(/[^A-Za-z0-9._-]/g, '_')}`;

          const exec = async () => runBuild(agent as never, {
            prompt, appName, platform, workspace: wsRoot, sessionId: buildId,
          });

          if (wait) {
            try {
              const result = await queue.submit({
                id: buildId, appName: appName ?? buildId, prompt, workspace: wsPath, execute: exec,
              });
              sendJson(res, 200, { ok: true, id: buildId, result });
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              sendJson(res, 502, { ok: false, id: buildId, error: msg });
            }
            return;
          }
          // Background mode — fire and forget, return immediately.
          queue.submit({
            id: buildId, appName: appName ?? buildId, prompt, workspace: wsPath, execute: exec,
          }).catch((err: unknown) => {
            const msg = err instanceof Error ? err.message : String(err);
            createLogger('web:builder/run').warn({ buildId, err: msg }, 'Background build failed');
          });
          sendJson(res, 200, { ok: true, id: buildId, status: 'queued', workspace: wsPath });
          return;
        }

        // ─── Tier 3 Builder Batch 1: GET /api/builder/artifacts ─────────
        // Defensive read of the `build_artifacts` table. The table is
        // created inside silly-johnson's createDatabase but isn't part of
        // main's schema yet (no migration in this batch). When the table
        // is absent OR the DB handle is unavailable, returns {artifacts:[]}
        // instead of 500. Hard cap of 100 rows, newest first.
        if (route === '/api/builder/artifacts' && method === 'GET') {
          try {
            const db = (agent as unknown as { getDatabase?: () => { prepare(s: string): { all(...a: unknown[]): unknown[] } } }).getDatabase?.();
            if (!db) {
              sendJson(res, 200, { artifacts: [] });
              return;
            }
            try {
              const rows = db
                .prepare(`SELECT * FROM build_artifacts ORDER BY created_at DESC LIMIT 100`)
                .all();
              sendJson(res, 200, { artifacts: rows });
            } catch {
              // Table absent or schema mismatch — degrade to empty list.
              sendJson(res, 200, { artifacts: [] });
            }
          } catch (e) {
            sendJson(res, 200, { artifacts: [], error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Memory stats — basic counts from the DB. Real cognitive memory
        // statistics (working set, episodes, etc.) come later when we wire
        // CategorizedMemoryStore reporting fully.
        // /api/memory/diagnostics — surfaces which SQLite file the memory
        // routes are bound to. Useful for confirming the cognitive-memory.db
        // (silly-johnson) vs agentx.db (legacy) resolution.
        // GET /api/retrieval/diagnostics — surfaces the effective retrieval
        // configuration, which DB the retrieval pipeline reads from, and
        // counts in both retrieval DB (agentx.db) and the memory DB
        // (cognitive_memory.db). Tells the user the truth about whether
        // RetrievalPanel will receive non-empty events.
        //
        // Reads (in order):
        //   AGENT_RETRIEVAL_ENABLED env override  (parseBoolEnv truthy/falsy)
        //   config.agent.retrieval.enabled       (config/default.yaml default)
        // Combined into the effective `enabled` boolean — same path Agent
        // construction uses (config.ts applyEnvOverrides).
        // POST /api/retrieval/sync — bridges cognitive_memory.db → agentx.db.
        // One-way, idempotent, additive. Reads cognitive_memory.db
        // READ-ONLY (cannot mutate the 253 user docs). Writes to the agent
        // DB using INSERT OR REPLACE keyed on document_id. Running multiple
        // times produces the same end state.
        //
        // Body (JSON, optional):
        //   { "limit": number }   — hard cap for testing
        //   { "sourcePath": str } — override (defaults to ~/.agentx/cognitive_memory.db)
        //
        // Returns: SyncResult with counts + document IDs touched (for
        // rollback).
        if (route === '/api/retrieval/sync' && method === 'POST') {
          const { body, error } = await readJsonCapped(req, 32 * 1024);
          if (error) { sendJson(res, 400, { error }); return; }
          const limit = typeof body['limit'] === 'number' ? (body['limit'] as number) : undefined;
          const sourcePath = typeof body['sourcePath'] === 'string'
            ? (body['sourcePath'] as string)
            : path.join(resolveDataDir(), 'cognitive_memory.db');
          try {
            type DbLike = { prepare(s: string): { get(): unknown; run(...a: unknown[]): unknown }; exec(s: string): void };
            const agentDb = (agent as unknown as { getDatabase?: () => DbLike }).getDatabase?.();
            if (!agentDb) { sendJson(res, 503, { error: 'agent DB not available' }); return; }
            // Make sure migration 001 has run AND its tables physically
            // exist. The migrations runner tracks applied state in
            // `schema_migrations_cognitive`; if the tables were dropped
            // manually (e.g. by the audit-batch cleanup) but the tracker
            // still says applied, we need to clear that row so the
            // migration re-runs. The audit explicitly forbids touching
            // migration files — this is a tracker reset, not a schema
            // edit.
            try {
              const hasDocsTable = (agentDb as unknown as { prepare(s: string): { get(): unknown } })
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='documents'")
                .get();
              if (!hasDocsTable) {
                try {
                  (agentDb as unknown as { prepare(s: string): { run(...a: unknown[]): unknown } })
                    .prepare("DELETE FROM schema_migrations_cognitive WHERE migration_id = '001_cognitive_memory'")
                    .run();
                } catch { /* table may not exist yet */ }
              }
              runCognitiveMemoryMigrations(agentDb as never);
            } catch (err) {
              log.warn({ err: (err as Error).message }, 'runCognitiveMemoryMigrations failed (continuing)');
            }
            const result = await syncCognitiveToRetrieval({
              sourcePath, targetDb: agentDb as never, limit,
            });
            sendJson(res, 200, { ok: true, ...result });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        if (route === '/api/retrieval/diagnostics' && method === 'GET') {
          try {
            const cfg = agent.getConfig();
            const configEnabled = cfg.agent?.retrieval?.enabled === true;
            // Env override semantics match parseBoolEnv in config.ts.
            const envRaw = process.env['AGENT_RETRIEVAL_ENABLED'];
            const envParsed = (() => {
              if (envRaw === undefined) return undefined;
              const v = String(envRaw).toLowerCase().trim();
              if (['true', '1', 'yes', 'on'].includes(v)) return true;
              if (['false', '0', 'no', 'off'].includes(v)) return false;
              return undefined; // invalid → ignored
            })();
            const effective = envParsed === undefined ? configEnabled : envParsed;

            // Retrieval is bound to agent.getDatabase() (= agentx.db).
            // Memory routes are bound separately via getMemoryDbHandle
            // (= cognitive_memory.db when present). Surface document
            // counts on both so the user can see the gap.
            type DbLike = { prepare(sql: string): { get(): { n?: number } } };
            const agentDb = (agent as unknown as { getDatabase?: () => DbLike }).getDatabase?.();
            let retrievalDocs = -1;
            try {
              const row = agentDb?.prepare("SELECT COUNT(*) AS n FROM documents").get();
              retrievalDocs = Number(row?.n ?? 0);
            } catch { retrievalDocs = 0; }

            const memDb = await getMemoryDbHandle(agent) as unknown as DbLike | null;
            let memoryDocs = -1;
            try {
              const row = memDb?.prepare("SELECT COUNT(*) AS n FROM documents").get();
              memoryDocs = Number(row?.n ?? 0);
            } catch { memoryDocs = 0; }
            // Page counts on both sides + chunks-with-page-id metric.
            // Memory pages need to be queried against the SOURCE
            // cognitive_memory.db file (when present) rather than the
            // memory-db helper handle — once the bridge sync writes
            // docs into agentx.db, the helper resolves to agentx and
            // its page count is the retrieval count, not the source.
            let retrievalPages = 0, memoryPages = 0, retrievalChunksWithPage = 0;
            try {
              const row = agentDb?.prepare("SELECT COUNT(*) AS n FROM document_pages").get();
              retrievalPages = Number(row?.n ?? 0);
            } catch { /* table absent */ }
            try {
              const fs = await import('node:fs');
              const cognitivePath = path.join(resolveDataDir(), 'cognitive_memory.db');
              if (fs.existsSync(cognitivePath)) {
                const mod = (await import('better-sqlite3' as string)) as {
                  default: new (filename: string, options?: { readonly?: boolean }) => DbLike & { close(): void };
                };
                const src = new mod.default(cognitivePath, { readonly: true });
                try {
                  const row = src.prepare('SELECT COUNT(*) AS n FROM document_pages').get();
                  memoryPages = Number(row?.n ?? 0);
                } finally { try { src.close(); } catch { /* */ } }
              }
            } catch { /* */ }
            try {
              const row = agentDb?.prepare("SELECT COUNT(*) AS n FROM document_chunks WHERE page_id IS NOT NULL").get();
              retrievalChunksWithPage = Number(row?.n ?? 0);
            } catch { /* */ }
            const memDbInfo = getMemoryDbDiagnostics();

            const { getRetrievalSyncState } = await import('./retrieval-sync-state.js');
            const syncState = getRetrievalSyncState();
            sendJson(res, 200, {
              enabled: effective,
              source: envParsed === undefined ? 'config' : 'env',
              configEnabled,
              envRaw: envRaw ?? null,
              retrievalDb: '(agent.getDatabase) — agentx.db',
              retrievalDocumentCount: retrievalDocs,
              retrievalPageCount: retrievalPages,
              retrievalChunksWithPageId: retrievalChunksWithPage,
              memoryDb: memDbInfo.path,
              memoryDocumentCount: memoryDocs,
              memoryPageCount: memoryPages,
              lastSyncAt: syncState.lastSyncAt,
              lastSyncResult: syncState.lastSyncResult,
              lastSyncError: syncState.lastSyncError,
              pendingDocumentCount: syncState.pendingDocumentCount,
              // Honest user-facing summary so the UI can render guidance
              // without recomputing the logic.
              hint:
                !effective
                  ? 'Retrieval disabled by config. Set AGENT_RETRIEVAL_ENABLED=true and restart the agent to enable R7/R11 retrieval events.'
                  : retrievalDocs === 0 && memoryDocs > 0
                    ? `Retrieval is enabled but reads from agentx.db (0 documents). Your ${memoryDocs} documents live in ${memDbInfo.path}. Retrieval and the Memory page currently use separate databases; bridging them is a follow-up batch.`
                    : retrievalDocs > 0
                      ? `Retrieval is enabled with ${retrievalDocs} documents.`
                      : 'Retrieval enabled. No documents in any DB yet.',
            });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        if (route === '/api/memory/diagnostics' && method === 'GET') {
          try {
            // Force resolution if not yet bound, then read diagnostics.
            await getMemoryDbHandle(agent);
            sendJson(res, 200, getMemoryDbDiagnostics());
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        if (route === '/api/memory/stats' && method === 'GET') {
          try {
            const db = await getMemoryDbHandle(agent) as unknown as { prepare(s: string): { get(): unknown } } | null;
            const counts: Record<string, number> = {};
            if (db) {
              for (const t of ['longterm_memory', 'documents', 'episodes']) {
                try {
                  const r = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n?: number } | undefined;
                  counts[t] = Number(r?.n ?? 0);
                } catch { counts[t] = 0; }
              }
            }
            sendJson(res, 200, { counts, available: !!db });
          } catch (e) {
            sendJson(res, 200, { counts: {}, error: String(e) });
          }
          return;
        }

        // Multimodal status — read agent's feature flags
        if (route === '/api/multimodal/status' && method === 'GET') {
          try {
            const cfg = agent.getConfig();
            sendJson(res, 200, {
              available: false,
              reason: 'Multimodal router not yet wired to agent.chat() (subsystem present)',
              voice: cfg.voice ?? null,
            });
          } catch (e) {
            sendJson(res, 200, { available: false, error: String(e) });
          }
          return;
        }

        // ─── Memory Control Center — REAL DB-backed (no shims) ─────────
        // The Memory page reads/writes through these routes. Backed by
        // documents + long_term_memory tables. See memory-control-center.ts.
        if (route === '/api/memory/control-center' && method === 'GET') {
          try {
            const db = await getMemoryDbHandle(agent);
            if (!db) { sendJson(res, 200, { items: [], totalCount: 0 }); return; }
            const u = new URL(url, 'http://x');
            const result = listMemoryItems(db, {
              q: u.searchParams.get('q') ?? undefined,
              type: u.searchParams.get('type') ?? undefined,
              sender: u.searchParams.get('sender') ?? undefined,
              dateFrom: u.searchParams.get('dateFrom') ?? undefined,
              dateTo: u.searchParams.get('dateTo') ?? undefined,
              page: u.searchParams.get('page') ? Number(u.searchParams.get('page')) : undefined,
              pageSize: u.searchParams.get('pageSize') ? Number(u.searchParams.get('pageSize')) : undefined,
            });
            sendJson(res, 200, result);
          } catch (e) {
            log.error({ err: e }, '/api/memory/control-center GET failed');
            sendJson(res, 500, { items: [], totalCount: 0, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }
        if (route === '/api/memory/control-center/bulk-delete' && method === 'POST') {
          try {
            const db = await getMemoryDbHandle(agent);
            if (!db) { sendJson(res, 503, { ok: false, deleted: 0, error: 'no database' }); return; }
            const body = await parseBody(req).catch(() => ({}));
            const ids = (body as { ids?: unknown }).ids;
            if (!Array.isArray(ids)) { sendJson(res, 400, { ok: false, deleted: 0, error: 'ids[] required' }); return; }
            const deleted = bulkDeleteMemoryItems(db, ids.map(String));
            sendJson(res, 200, { ok: true, deleted });
          } catch (e) {
            log.error({ err: e }, '/api/memory/control-center/bulk-delete failed');
            sendJson(res, 500, { ok: false, deleted: 0, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }
        if (route.startsWith('/api/memory/control-center/') && (method === 'GET' || method === 'DELETE')) {
          try {
            const db = await getMemoryDbHandle(agent);
            if (!db) { sendJson(res, 503, { error: 'no database' }); return; }
            const id = decodeURIComponent(route.slice('/api/memory/control-center/'.length));
            if (method === 'GET') {
              const detail = getMemoryDetail(db, id);
              if (!detail) { sendJson(res, 404, { error: `not found: ${id}` }); return; }
              sendJson(res, 200, detail);
            } else {
              const ok = deleteMemoryItem(db, id);
              if (!ok) { sendJson(res, 404, { ok: false, error: `not found: ${id}` }); return; }
              sendJson(res, 200, { ok: true });
            }
          } catch (e) {
            log.error({ err: e, route, method }, 'memory control-center detail/delete failed');
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // ─── Document upload — REAL ingestion (no shim) ─────────────────
        // Accepts multipart/form-data with one or more `file` parts. For each
        // file: extract text (txt/md/pdf supported today; docx/msg deferred),
        // INSERT documents+document_chunks (FTS triggers populate the index),
        // run R5 entity ingestion when enabled. Uploaded docs immediately
        // appear in /api/memory/control-center and are retrievable via chat.
        if ((route === '/api/memory/upload-document' || route === '/api/cognitive/ingest')
            && method === 'POST') {
          try {
            const db = await getMemoryDbHandle(agent);
            if (!db) { sendJson(res, 503, { ok: false, error: 'no database' }); return; }
            let parsed;
            try {
              parsed = await parseMultipartBody(req);
            } catch (err) {
              if (err instanceof MultipartError) {
                sendJson(res, err.status, { ok: false, error: err.message });
                return;
              }
              throw err;
            }
            if (parsed.files.length === 0) {
              sendJson(res, 400, { ok: false, error: 'no files in upload' });
              return;
            }
            const uploaded: Array<Record<string, unknown>> = [];
            for (const file of parsed.files) {
              try {
                const result = await ingestUploadedDocument(
                  db as unknown as import('@agentx/core').IngestArgs extends never ? never : Parameters<typeof ingestUploadedDocument>[0],
                  {
                    buffer: file.data,
                    filename: file.filename,
                    mimeHint: file.contentType,
                    title: parsed.fields['title'] || undefined,
                    // Let ingestUploadedDocument auto-detect originType
                    // ('email' for EML/MSG, 'upload' otherwise) when the
                    // form didn't explicitly set one.
                    originType: parsed.fields['origin_type'] || undefined,
                  },
                );
                // R5: run entity ingestion if enabled — uses the document's
                // first chunk text since we already chunked it during ingest.
                let entityResult: unknown = null;
                if (typeof (agent as unknown as { isEntityIndexingEnabled?: () => boolean }).isEntityIndexingEnabled === 'function'
                    && (agent as unknown as { isEntityIndexingEnabled: () => boolean }).isEntityIndexingEnabled()) {
                  try {
                    const ingestFn = (agent as unknown as { ingestDocumentEntities?: (id: string, text: string) => unknown }).ingestDocumentEntities;
                    if (typeof ingestFn === 'function' && !result.duplicateOf) {
                      entityResult = ingestFn.call(agent, result.documentId, file.data.toString('utf8').slice(0, 100_000));
                    }
                  } catch (err) {
                    log.warn({ err: String(err), documentId: result.documentId }, 'entity ingestion failed');
                  }
                }
                uploaded.push({
                  document_id: result.documentId,
                  file_name: result.fileName,
                  file_type: result.fileType,
                  mime_type: result.mimeType,
                  origin_type: result.originType,
                  chunk_count: result.chunkCount,
                  word_count: result.wordCount,
                  duplicate_of: result.duplicateOf ?? null,
                  warnings: result.warnings,
                  entity_indexed: !!entityResult,
                });
              } catch (err) {
                uploaded.push({
                  file_name: file.filename,
                  error: err instanceof Error ? err.message : String(err),
                });
              }
            }
            // Post-ingest: queue retrieval sync for the new doc IDs.
            // Fire-and-forget — never blocks the response, never fails
            // the upload if sync fails.
            try {
              const { queueRetrievalSync } = await import('./retrieval-sync-state.js');
              const newIds = uploaded
                .map((u) => typeof u['document_id'] === 'string' ? (u['document_id'] as string) : null)
                .filter((id): id is string => !!id);
              if (newIds.length > 0) queueRetrievalSync(agent, newIds);
            } catch (err) {
              log.warn({ err: String(err) }, 'queueRetrievalSync after upload failed (upload still succeeded)');
            }
            sendJson(res, 200, { ok: true, uploaded });
          } catch (e) {
            log.error({ err: e, route }, 'upload route failed');
            sendJson(res, 500, { ok: false, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Memory gateway query — wraps the same listing for the search box
        if (route === '/api/memory/gateway/query' && method === 'POST') {
          try {
            const db = await getMemoryDbHandle(agent);
            if (!db) { sendJson(res, 200, { items: [], totalCount: 0 }); return; }
            const body = await parseBody(req).catch(() => ({}));
            const q = String((body as { q?: unknown }).q ?? '');
            const result = listMemoryItems(db, { q, pageSize: 100 });
            sendJson(res, 200, result);
          } catch (e) {
            sendJson(res, 500, { items: [], totalCount: 0, error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // ─── Tier 1 safe-batch routes — read-only, no agent.ts changes ──
        // Each handler uses optional chaining and never throws. Deep
        // imports avoid touching core/index.ts. All five routes were
        // shimmed before; their backends already exist on the branch.

        // ─── Tier 2 batch C: POST /api/agent-loops/start ────────────────
        // Gated behind AGENTX_ENABLE_AGENT_LOOPS=true. Default OFF — when
        // the env flag isn't set, returns 503 with a clear reason so the
        // SPA Agent Loops page can render disabled state. This route
        // blocks the HTTP request for up to 6 minutes (engine's internal
        // maxDuration is 5 min; we add 1 min buffer then return 504).
        if (route === '/api/agent-loops/start' && method === 'POST') {
          if (process.env['AGENTX_ENABLE_AGENT_LOOPS'] !== 'true') {
            sendJson(res, 503, { available: false, reason: 'agent_loops_disabled' });
            return;
          }
          let body: Record<string, unknown>;
          try {
            body = await parseBody(req);
          } catch {
            sendJson(res, 400, { error: 'Invalid JSON body' });
            return;
          }
          // Goal validation
          const goal = body['goal'];
          if (typeof goal !== 'string' || goal.trim().length === 0) {
            sendJson(res, 400, { error: 'Missing required field: goal (string)' });
            return;
          }
          if (goal.length > 4000) {
            sendJson(res, 400, { error: `Goal exceeds 4000-character limit (got ${goal.length})` });
            return;
          }
          // Constraints validation
          const constraintsRaw = body['constraints'];
          let constraints: string[] | undefined;
          if (constraintsRaw !== undefined) {
            if (!Array.isArray(constraintsRaw)) {
              sendJson(res, 400, { error: 'constraints must be an array of strings' });
              return;
            }
            if (constraintsRaw.length > 50) {
              sendJson(res, 400, { error: `constraints exceeds 50-item limit (got ${constraintsRaw.length})` });
              return;
            }
            const filtered: string[] = [];
            for (const c of constraintsRaw) {
              if (typeof c !== 'string') continue;
              if (c.length > 256) {
                sendJson(res, 400, { error: `constraint exceeds 256-char limit (one item is ${c.length})` });
                return;
              }
              filtered.push(c);
            }
            constraints = filtered;
          }
          const sessionId = typeof body['sessionId'] === 'string' ? body['sessionId'] as string : undefined;

          // Server-side timeout — 6 minutes (slightly above engine's 5-min cap).
          const TIMEOUT_MS = 6 * 60 * 1000;
          const TIMEOUT_SENTINEL = Symbol('agent-loops-timeout');
          try {
            type LoopState = {
              loopId?: string;
              status?: string;
              plan?: { tasks?: Array<{ action?: string; description?: string }>; reasoning?: string; expectedOutcome?: string };
              currentStep?: number;
              totalDuration?: number;
              executionResults?: Array<{ success?: boolean; output?: unknown; error?: string }>;
              reflections?: Array<{ analysis?: string }>;
              finalOutcome?: { success?: boolean; summary?: string };
            };
            const runP = (agent as unknown as { runAgentLoop(d: string, s?: string, c?: string[]): Promise<LoopState> })
              .runAgentLoop(goal.trim(), sessionId, constraints);
            const timeoutP = new Promise<typeof TIMEOUT_SENTINEL>((resolve) => {
              const t = setTimeout(() => resolve(TIMEOUT_SENTINEL), TIMEOUT_MS);
              // Don't keep the process alive just for this timer.
              if (typeof t.unref === 'function') t.unref();
            });
            const raced = await Promise.race([runP, timeoutP]);
            if (raced === TIMEOUT_SENTINEL) {
              sendJson(res, 504, { error: 'Agent loop timed out' });
              return;
            }
            const result = raced as LoopState;
            // Build findings[] per silly's contract
            const tasks = result.plan?.tasks ?? [];
            const execResults = result.executionResults ?? [];
            const reflections = result.reflections ?? [];
            const findings: Array<{ step: number; action: string; description: string; outcome: string; analysis: string; output?: unknown }> = [];
            for (let i = 0; i < tasks.length && i < execResults.length; i++) {
              const t = tasks[i];
              const ex = execResults[i];
              const refl = reflections[i];
              findings.push({
                step: i + 1,
                action: String(t.action ?? ''),
                description: String(t.description ?? ''),
                outcome: ex.success ? 'success' : 'failed',
                analysis: refl?.analysis ?? (ex.success ? 'Completed.' : (ex.error || 'Failed.')),
                output: ex.output,
              });
            }
            sendJson(res, 200, {
              loopId: result.loopId,
              status: result.status,
              success: result.finalOutcome?.success ?? false,
              summary: result.finalOutcome?.summary ?? '',
              steps: result.currentStep,
              duration: result.totalDuration,
              tasks: tasks.map((t) => ({ action: t.action, description: t.description })),
              reasoning: result.plan?.reasoning ?? '',
              expectedOutcome: result.plan?.expectedOutcome ?? '',
              findings,
            });
          } catch (e) {
            log.error({ err: String(e) }, 'agent loop start failed');
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // 1. GET /api/agent-loops/events — recent eventBus history
        if (route === '/api/agent-loops/events' && method === 'GET') {
          try {
            const { eventBus } = await import('@agentx/core');
            const history = eventBus.getHistory(undefined, 50);
            sendJson(res, 200, {
              events: history.map((e) => ({
                type: e.type,
                payload: e.payload === undefined || e.payload === null
                  ? ''
                  : typeof e.payload === 'object'
                    ? JSON.stringify(e.payload).slice(0, 100)
                    : String(e.payload).slice(0, 100),
                timestamp: e.timestamp,
              })),
            });
          } catch (e) {
            sendJson(res, 200, { events: [], error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // 2. GET /api/agent-loops/:loopId — runtime state for a single loop.
        // Uses runtimeStateStore (active loops in memory + history).
        const loopIdMatch = route.match(/^\/api\/agent-loops\/([^/]+)$/);
        if (loopIdMatch && method === 'GET') {
          // Skip well-known sub-routes that are already handled above
          // (active, history, dashboard, events) — their match groups would
          // collide with the regex. We exclude them explicitly.
          const reserved = new Set(['active', 'history', 'dashboard', 'events', 'start']);
          const loopId = decodeURIComponent(loopIdMatch[1]);
          if (!reserved.has(loopId)) {
            try {
              const { runtimeStateStore } = await import('@agentx/core');
              const active = runtimeStateStore.getActiveLoop(loopId);
              if (active) { sendJson(res, 200, { loop: active }); return; }
              const historyMatch = runtimeStateStore.getHistory().find((l) => l.loopId === loopId);
              if (historyMatch) { sendJson(res, 200, { loop: historyMatch }); return; }
              sendJson(res, 404, { error: `Agent loop not found: ${loopId}` });
            } catch (e) {
              sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
            }
            return;
          }
        }

        // 3. GET /api/agents/trace — orchestrator events from eventBus
        if (route === '/api/agents/trace' && method === 'GET') {
          try {
            const u = new URL(url, 'http://x');
            const limit = Math.max(1, Math.min(1000, Number(u.searchParams.get('limit') ?? 100) | 0));
            const { eventBus } = await import('@agentx/core');
            const all = eventBus.getHistory(undefined, limit);
            const events = all.filter((e) => e.type.startsWith('agent.orchestrator.'));
            sendJson(res, 200, { events, count: events.length });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // 4. GET /api/auth/claude/status — graceful when service is null.
        // The agent's lazy getter currently returns null (OAuth service is
        // declared but not instantiated until Tier 2). Until then this route
        // returns the silly-documented `{connected: false, reason: 'service_unavailable'}`
        // shape so the SPA Claude-auth panel renders correctly.
        if (route === '/api/auth/claude/status' && method === 'GET') {
          try {
            const oauth = (agent as unknown as { getClaudeOAuthService?: () => { getStatus(): Promise<unknown> } | null }).getClaudeOAuthService?.();
            if (!oauth) {
              sendJson(res, 200, { connected: false, reason: 'service_unavailable' });
              return;
            }
            const status = await oauth.getStatus();
            sendJson(res, 200, status);
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Tier 2 batch A: POST /api/auth/claude/start — kick off PKCE/OAuth.
        // Service is now eager-initialised in agent.ts. The handler:
        //   - 500 if service unavailable (null guard preserved for defensive parity with silly)
        //   - calls startAuthFlow(); fires-and-forgets waitForCompletion()
        //     so the unhandled-rejection path can't crash the server
        //   - returns { started, authUrl, callbackPort }
        if (route === '/api/auth/claude/start' && method === 'POST') {
          try {
            const oauth = (agent as unknown as { getClaudeOAuthService?: () => {
              startAuthFlow(): Promise<{ authUrl: string; state: string; callbackPort: number; waitForCompletion(): Promise<unknown> }>;
            } | null }).getClaudeOAuthService?.();
            if (!oauth) {
              sendJson(res, 500, { error: 'Claude OAuth service unavailable' });
              return;
            }
            const result = await oauth.startAuthFlow();
            // Don't block the HTTP response on completion; client polls /status.
            // Swallow rejection so user-cancel/timeout doesn't crash the process.
            result.waitForCompletion().catch(() => { /* user cancel or timeout */ });
            sendJson(res, 200, {
              started: true,
              authUrl: result.authUrl,
              callbackPort: result.callbackPort,
            });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // Tier 2 batch A: POST /api/auth/claude/disconnect — revoke + clear creds.
        // Returns 200 in both wired and null-fallback cases (silly contract).
        if (route === '/api/auth/claude/disconnect' && method === 'POST') {
          try {
            const oauth = (agent as unknown as { getClaudeOAuthService?: () => {
              disconnect(): Promise<void>;
            } | null }).getClaudeOAuthService?.();
            if (!oauth) {
              sendJson(res, 200, { disconnected: true, reason: 'service_unavailable' });
              return;
            }
            await oauth.disconnect();
            sendJson(res, 200, { disconnected: true });
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // 5. GET /api/logs/llm-interactions/:id — single interaction lookup.
        // The list route /api/logs/llm-interactions already real (round 1).
        // This handler covers the per-id detail.
        if (route.startsWith('/api/logs/llm-interactions/') && method === 'GET') {
          try {
            const id = route.slice('/api/logs/llm-interactions/'.length);
            if (!id) { sendJson(res, 400, { error: 'id is required' }); return; }
            const { LLMInteractionLogger } = await import('@agentx/core');
            const rec = LLMInteractionLogger.getInstance().findById(decodeURIComponent(id));
            if (!rec) { sendJson(res, 404, { error: 'Interaction not found' }); return; }
            sendJson(res, 200, rec);
          } catch (e) {
            sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) });
          }
          return;
        }

        // ─── SPA-known but unimplemented endpoints → 501 (Step 3) ───────
        // Returns a uniform JSON envelope so SPA panels can detect
        // `available: false` instead of guessing from `error` strings.
        const shim = tryUnsupportedSpaShim(method, route);
        if (shim) {
          sendJson(res, shim.status, shim.body);
          return;
        }

        // ─── 404 (uniform envelope) ─────────────────────────────────────
        sendJson(res, 404, unknownEndpointEnvelope(method, route));
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ method, route, error: msg }, 'API error');
        sendJson(res, 500, { error: msg });
      }
    },
  };
}
