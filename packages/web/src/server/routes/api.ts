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
import { parseMultipartBody, MultipartError } from '../multipart.js';
import {
  ingestUploadedDocument,
  loadMCPConfig,
  saveMCPConfig,
  validateServerConfig,
  resolveDataDir,
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
            const logger = (agent as unknown as { getLLMInteractionLogger?: () => { recent(n?: number): unknown } }).getLLMInteractionLogger?.();
            const entries = logger?.recent(200) ?? [];
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
          const sup = (agent as unknown as { getMultiAgentSupervisor?: () => { listPlans?: () => unknown[] } | null }).getMultiAgentSupervisor?.();
          if (!sup) {
            sendJson(res, 200, { runs: [], available: false, reason: 'features.builderV2 is off' });
            return;
          }
          try {
            sendJson(res, 200, { runs: sup.listPlans?.() ?? [], available: true });
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
            const db = (agent as unknown as { getDatabase?: () => import('./memory-control-center.js').DbHandle }).getDatabase?.();
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
            const db = (agent as unknown as { getDatabase?: () => import('./memory-control-center.js').DbHandle }).getDatabase?.();
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
            const db = (agent as unknown as { getDatabase?: () => import('./memory-control-center.js').DbHandle }).getDatabase?.();
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
            const db = (agent as unknown as { getDatabase?: () => { prepare(s: string): { get(...a: unknown[]): unknown } } }).getDatabase?.();
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
            const db = (agent as unknown as { getDatabase?: () => { prepare(s: string): { all(...a: unknown[]): unknown[] } } }).getDatabase?.();
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
        if (route === '/api/builder/queue' && method === 'GET') {
          sendJson(res, 200, { queue: [], available: false, reason: 'BuildQueueManager not yet wired' });
          return;
        }

        // Memory stats — basic counts from the DB. Real cognitive memory
        // statistics (working set, episodes, etc.) come later when we wire
        // CategorizedMemoryStore reporting fully.
        if (route === '/api/memory/stats' && method === 'GET') {
          try {
            const db = (agent as unknown as { getDatabase?: () => { prepare(s: string): { get(): unknown } } }).getDatabase?.();
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
            const db = (agent as unknown as { getDatabase?: () => import('./memory-control-center.js').DbHandle }).getDatabase?.();
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
            const db = (agent as unknown as { getDatabase?: () => import('./memory-control-center.js').DbHandle }).getDatabase?.();
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
            const db = (agent as unknown as { getDatabase?: () => import('./memory-control-center.js').DbHandle }).getDatabase?.();
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
            const db = (agent as unknown as { getDatabase?: () => import('./memory-control-center.js').DbHandle }).getDatabase?.();
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
            const db = (agent as unknown as { getDatabase?: () => import('./memory-control-center.js').DbHandle }).getDatabase?.();
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
