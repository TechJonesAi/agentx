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
  // Agent loops
  { kind: 'prefix', prefix: '/api/agent-loops' },
  // Agents trace
  { kind: 'exact', route: '/api/agents/trace' },
  // Claude auth flow
  { kind: 'prefix', prefix: '/api/auth/claude' },
  // BuilderV2 (only /api/builder/stats is implemented; runs/* are not)
  { kind: 'prefix', prefix: '/api/builder/runs' },
  // Multimodal chat (text-only chat is implemented)
  { kind: 'exact', route: '/api/chat/multimodal' },
  // Cognitive (only /api/cognitive/status is implemented)
  { kind: 'prefix', prefix: '/api/cognitive/books' },
  { kind: 'prefix', prefix: '/api/cognitive/document' },
  { kind: 'exact', route: '/api/cognitive/ingest' },
  { kind: 'exact', route: '/api/cognitive/ingest-book' },
  { kind: 'exact', route: '/api/cognitive/run' },
  // Integrity / self-repair
  { kind: 'prefix', prefix: '/api/integrity' },
  // (`/api/logs/llm-interactions` and `/api/logs/system` now real — see api.ts.
  //  Subroutes like /api/logs/llm-interactions/:id are still unimplemented.)
  { kind: 'prefix', prefix: '/api/logs/llm-interactions/' },
  // MCP server management
  { kind: 'prefix', prefix: '/api/mcp' },
  // Memory control-center + gateway/query + upload + stats
  { kind: 'prefix', prefix: '/api/memory/control-center' },
  { kind: 'prefix', prefix: '/api/memory/gateway/document' },
  { kind: 'exact', route: '/api/memory/gateway/query' },
  { kind: 'exact', route: '/api/memory/stats' },
  { kind: 'exact', route: '/api/memory/upload-document' },
  // Model routing config
  { kind: 'exact', route: '/api/models/routing' },
  // Multimodal status
  { kind: 'exact', route: '/api/multimodal/status' },
  // (`/api/supervisor/status` now real — see api.ts. Other supervisor
  //  subroutes — restart, services, simulate-crash, logs/:id — still shimmed.)
  { kind: 'exact', route: '/api/supervisor/restart' },
  { kind: 'exact', route: '/api/supervisor/services' },
  { kind: 'exact', route: '/api/supervisor/simulate-crash' },
  { kind: 'prefix', prefix: '/api/supervisor/logs' },
  // Telemetry sink
  { kind: 'exact', route: '/api/telemetry' },
  // Text-to-speech
  { kind: 'exact', route: '/api/tts' },
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
