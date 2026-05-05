/**
 * Chat error categorisation — pure helper, no @agentx/core imports so it
 * is unit-testable from the web package without tripping vitest's alias
 * resolution.
 *
 * Categorises an unknown error from agent.chat() into a stable
 * (status, code, userMessage, raw) tuple so the live /api/chat route
 * never leaks raw SDK strings to the dashboard.
 */
export interface CategorisedChatError {
  status: number;
  code:
    | 'PROVIDER_AUTH_MISSING'
    | 'PROVIDER_RATE_LIMITED'
    | 'PROVIDER_UNREACHABLE'
    | 'STORAGE_FAILURE'
    | 'RETRIEVAL_TIMEOUT'
    | 'UNKNOWN_FAILURE';
  userMessage: string;
  raw: string;
}

export function categoriseChatError(err: unknown): CategorisedChatError {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (
    lower.includes('apikey') ||
    lower.includes('api key') ||
    lower.includes('authentication') ||
    lower.includes('authtoken') ||
    lower.includes('unauthorized') ||
    lower.includes('401')
  ) {
    return {
      status: 503,
      code: 'PROVIDER_AUTH_MISSING',
      userMessage:
        'The configured LLM provider is not authenticated. Set the appropriate API key (e.g. ANTHROPIC_API_KEY) or switch to a local provider such as Ollama in your config.',
      raw,
    };
  }
  if (lower.includes('rate limit') || lower.includes('429') || lower.includes('too many requests')) {
    return {
      status: 429,
      code: 'PROVIDER_RATE_LIMITED',
      userMessage: 'The LLM provider rate-limited the request. Please retry in a few seconds.',
      raw,
    };
  }
  if (
    lower.includes('econnrefused') ||
    lower.includes('enotfound') ||
    lower.includes('etimedout') ||
    lower.includes('fetch failed') ||
    lower.includes('network')
  ) {
    return {
      status: 502,
      code: 'PROVIDER_UNREACHABLE',
      userMessage: 'Cannot reach the LLM provider. Verify network connectivity and the provider URL.',
      raw,
    };
  }
  if (lower.includes('sqlite_') || lower.includes('no such column') || lower.includes('no such table')) {
    return {
      status: 500,
      code: 'STORAGE_FAILURE',
      userMessage: 'A storage/migration error occurred. The server log has details.',
      raw,
    };
  }
  if (raw.startsWith('R10:') || lower.includes('retrieval timed out')) {
    return {
      status: 504,
      code: 'RETRIEVAL_TIMEOUT',
      userMessage: 'Retrieval took too long and was aborted. The chat continues without retrieval context.',
      raw,
    };
  }
  return {
    status: 500,
    code: 'UNKNOWN_FAILURE',
    userMessage: 'Unexpected server error during chat. The server log has details.',
    raw,
  };
}
