/**
 * Step 3 — graceful 501 shims for SPA-known endpoints that aren't implemented
 * on this build.
 *
 * Why this exists: future SPA pages may call endpoints (BuilderV2, Voice,
 * Vision, Memory gateway subroutes, AgentLoops, Validation, Integrity,
 * Cognitive sub-endpoints, etc.) that haven't been restored to main yet.
 * Without this shim, the api router falls through to a generic 404 and the
 * SPA panels would have to handle ad-hoc `error` shapes — easy to misread as
 * blank-screen failures.
 *
 * This module returns a uniform JSON envelope:
 *   { available: false, reason: 'not implemented on this build', method, endpoint }
 *
 * - matched, known-but-unimplemented endpoints → 501
 * - unmatched /api/* paths fall through to the api router's existing 404,
 *   which the router additionally enriches with the same envelope.
 */

export interface UnsupportedShimResponse {
  status: number;
  body: {
    available: false;
    reason: string;
    method: string;
    endpoint: string;
    /** kept for backwards compatibility with the previous 404 shape */
    error: string;
  };
}

/**
 * Endpoints visible in the Silly Johnson SPA whose backends aren't lifted
 * yet. Match either via `===` or `route.startsWith(prefix + '/')` so
 * subroutes (e.g. `/api/integrity/repair/123`) are also caught.
 *
 * Order matters only insofar as more specific entries should appear before
 * less specific ones; we use simple equality + prefix checks so collisions
 * are unlikely.
 */
const KNOWN_UNIMPLEMENTED: ReadonlyArray<
  | { kind: 'exact'; route: string }
  | { kind: 'prefix'; prefix: string }
> = [
  // (All /api/agent-loops/* routes now real — see api.ts:
  //   GET /active, /history, /dashboard, /events, /:loopId  (Tier 1)
  //   POST /start                                            (Tier 2 batch C)
  //  /start is gated behind AGENTX_ENABLE_AGENT_LOOPS=true; when disabled
  //  it returns 503 with reason:agent_loops_disabled, not a shim envelope.)
  // (`/api/agents/trace` now real — see api.ts.)
  // (`/api/auth/claude/{status,start,disconnect}` all now real — see api.ts.
  //  ClaudeOAuthService is eager-instantiated in agent.ts (Tier 2 batch A).)
  // (`/api/builder/runs` and `/api/builder/queue` now real — see api.ts. The
  //  prefix below covers sub-paths like /runs/:id/cancel; the real top-level
  //  /runs handler in api.ts fires before the shim, so the prefix doesn't
  //  intercept it at runtime.)
  { kind: 'prefix', prefix: '/api/builder/runs' },
  // (`/api/builder/queue/{cancel,clear}` now real — see api.ts.
  //  Built on lazy-init BuildQueueManager + IdleManager getters.)
  { kind: 'exact', route: '/api/builder/run' },
  // (`/api/builder/artifacts` now real — see api.ts. Defensive read; returns
  //  {artifacts: []} when the build_artifacts table is absent.)
  // Multimodal chat (text-only chat is implemented)
  { kind: 'exact', route: '/api/chat/multimodal' },
  // (Cognitive routes implemented:
  //   /api/cognitive/status, /api/cognitive/diagnostics,
  //   /api/cognitive/documents, /api/cognitive/document/:id,
  //   /api/cognitive/ingest, /api/cognitive/search
  //  Books and ingest-book/run still shimmed — book-format support
  //  needs a separate library lift.)
  { kind: 'prefix', prefix: '/api/cognitive/books' },
  { kind: 'exact', route: '/api/cognitive/ingest-book' },
  { kind: 'exact', route: '/api/cognitive/run' },
  // Integrity / self-repair
  { kind: 'prefix', prefix: '/api/integrity' },
  // (`/api/logs/llm-interactions`, `/api/logs/llm-interactions/:id`, and
  //  `/api/logs/system` now real — see api.ts.)
  // (`/api/mcp/servers`, `/api/mcp/tools` (Tier 1), `/api/mcp/allow-remote`
  //  (Tier 2 batch B PUT), and `/api/mcp/servers/:name` (Tier 2 batch B
  //  PUT/DELETE) all now real — see api.ts. Unmatched MCP paths fall
  //  through to the catch-all 404 with the safe envelope.)
  // (`/api/memory/control-center` and `/api/memory/gateway/query` now real
  //  — see memory-control-center.ts. Document-detail prefix still shimmed.)
  // (`/api/memory/gateway/document/:id` now real — see api.ts.)
  // (`/api/memory/stats` now real — see api.ts)
  // (`/api/memory/upload-document` now real — see api.ts upload handler.)
  // (`/api/models/routing` GET/POST now real — see api.ts. Strategy 3:
  //  route reads/writes ~/.agentx/routing.json directly, optional Ollama
  //  probe for live model discovery. No agent.ts wiring.)
  // (`/api/multimodal/status` now real — see api.ts)
  // (`/api/supervisor/status` now real — see api.ts. Other supervisor
  //  subroutes — restart, services, simulate-crash, logs/:id — still shimmed.)
  { kind: 'exact', route: '/api/supervisor/restart' },
  { kind: 'exact', route: '/api/supervisor/services' },
  { kind: 'exact', route: '/api/supervisor/simulate-crash' },
  { kind: 'prefix', prefix: '/api/supervisor/logs' },
  // Telemetry sink
  { kind: 'exact', route: '/api/telemetry' },
  // (`/api/tts`, `/api/tts/health`, `/api/tts/voices` now real via tts/router)
  // Validation lab
  { kind: 'prefix', prefix: '/api/validation' },
  // Vision
  { kind: 'prefix', prefix: '/api/vision' },
];

const REASON = 'not implemented on this build';

function envelope(method: string, route: string): UnsupportedShimResponse {
  return {
    status: 501,
    body: {
      available: false,
      reason: REASON,
      method,
      endpoint: route,
      error: `${method} ${route} is not implemented on this build`,
    },
  };
}

/**
 * If `route` matches a known-unimplemented SPA endpoint, return a 501 JSON
 * envelope. Otherwise return null and let the api router handle it
 * (matching a real route, or falling through to the catch-all 404).
 *
 * Strips query string and trailing slash for matching, but echoes the
 * original `route` back in the envelope for debugging.
 */
export function tryUnsupportedSpaShim(
  method: string,
  route: string,
): UnsupportedShimResponse | null {
  // Normalise: drop query/hash, collapse trailing slash (except for "/").
  const cleaned = route.split('?')[0].split('#')[0];
  const normalised =
    cleaned.length > 1 && cleaned.endsWith('/') ? cleaned.slice(0, -1) : cleaned;

  for (const entry of KNOWN_UNIMPLEMENTED) {
    if (entry.kind === 'exact' && entry.route === normalised) {
      return envelope(method, route);
    }
    if (entry.kind === 'prefix') {
      if (
        normalised === entry.prefix ||
        normalised.startsWith(entry.prefix + '/')
      ) {
        return envelope(method, route);
      }
    }
  }
  return null;
}

/**
 * Build the same-shape envelope for the catch-all 404 — keeps the SPA's
 * fetch error-handling uniform whether an endpoint is "known but unimplemented"
 * (501) or "totally unknown" (404).
 */
export function unknownEndpointEnvelope(
  method: string,
  route: string,
): UnsupportedShimResponse['body'] {
  return {
    available: false,
    reason: 'unknown endpoint',
    method,
    endpoint: route,
    error: `Not found: ${method} ${route}`,
  };
}
