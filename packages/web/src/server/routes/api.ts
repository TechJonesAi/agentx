/**
 * REST API routes for the AgentX Web UI.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import type { Agent } from '@agentx/core';
import { createLogger } from '@agentx/core';

const log = createLogger('web:api');

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

        // ─── 404 ────────────────────────────────────────────────────────
        sendJson(res, 404, { error: `Not found: ${method} ${route}` });
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error({ method, route, error: msg }, 'API error');
        sendJson(res, 500, { error: msg });
      }
    },
  };
}
