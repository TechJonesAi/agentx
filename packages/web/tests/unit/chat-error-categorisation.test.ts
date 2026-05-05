/**
 * Live-route regression — chat error categorisation.
 *
 * Reproduces the urgent fix scenario: when agent.chat() throws a provider
 * auth error (no API key configured), /api/chat must return a categorised
 * 503 with code=PROVIDER_AUTH_MISSING and a useful user message — not a
 * raw 500 with the SDK's internal message.
 */
import { describe, it, expect } from 'vitest';
import { categoriseChatError } from '../../src/server/chat-error.js';

describe('categoriseChatError — provider auth (the live 500 reproducer)', () => {
  it('Anthropic SDK "Could not resolve authentication method" → PROVIDER_AUTH_MISSING / 503', () => {
    const err = new Error('Could not resolve authentication method. Expected either apiKey or authToken to be set.');
    const r = categoriseChatError(err);
    expect(r.code).toBe('PROVIDER_AUTH_MISSING');
    expect(r.status).toBe(503);
    expect(r.userMessage).toMatch(/not authenticated/i);
    expect(r.userMessage).toMatch(/Ollama/);
  });

  it('"Unauthorized" 401-style → PROVIDER_AUTH_MISSING', () => {
    expect(categoriseChatError(new Error('401 Unauthorized')).code).toBe('PROVIDER_AUTH_MISSING');
  });

  it('"apiKey required" → PROVIDER_AUTH_MISSING', () => {
    expect(categoriseChatError(new Error('apiKey is required')).code).toBe('PROVIDER_AUTH_MISSING');
  });
});

describe('categoriseChatError — rate limit', () => {
  it('"rate limit" → PROVIDER_RATE_LIMITED / 429', () => {
    const r = categoriseChatError(new Error('You hit the rate limit'));
    expect(r.code).toBe('PROVIDER_RATE_LIMITED');
    expect(r.status).toBe(429);
  });
  it('"429 Too Many Requests" → PROVIDER_RATE_LIMITED', () => {
    expect(categoriseChatError(new Error('429 Too Many Requests')).code).toBe('PROVIDER_RATE_LIMITED');
  });
});

describe('categoriseChatError — network', () => {
  it('ECONNREFUSED → PROVIDER_UNREACHABLE / 502', () => {
    const r = categoriseChatError(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    expect(r.code).toBe('PROVIDER_UNREACHABLE');
    expect(r.status).toBe(502);
  });
  it('ENOTFOUND → PROVIDER_UNREACHABLE', () => {
    expect(categoriseChatError(new Error('getaddrinfo ENOTFOUND api.anthropic.com')).code).toBe('PROVIDER_UNREACHABLE');
  });
  it('"fetch failed" → PROVIDER_UNREACHABLE', () => {
    expect(categoriseChatError(new Error('fetch failed')).code).toBe('PROVIDER_UNREACHABLE');
  });
});

describe('categoriseChatError — storage', () => {
  it('SQLite "no such column" → STORAGE_FAILURE', () => {
    expect(categoriseChatError(new Error('no such column: foo')).code).toBe('STORAGE_FAILURE');
  });
  it('SQLite "no such table" → STORAGE_FAILURE', () => {
    expect(categoriseChatError(new Error('no such table: bar')).code).toBe('STORAGE_FAILURE');
  });
});

describe('categoriseChatError — retrieval timeout', () => {
  it('R10 timeout marker → RETRIEVAL_TIMEOUT / 504', () => {
    const r = categoriseChatError(new Error('R10: retrieval timed out after 5000ms'));
    expect(r.code).toBe('RETRIEVAL_TIMEOUT');
    expect(r.status).toBe(504);
  });
});

describe('categoriseChatError — fallthrough', () => {
  it('unknown errors → UNKNOWN_FAILURE / 500', () => {
    const r = categoriseChatError(new Error('something completely random'));
    expect(r.code).toBe('UNKNOWN_FAILURE');
    expect(r.status).toBe(500);
  });
  it('non-Error values are stringified safely', () => {
    expect(categoriseChatError('string error').code).toBe('UNKNOWN_FAILURE');
    expect(categoriseChatError(42).code).toBe('UNKNOWN_FAILURE');
    expect(categoriseChatError(null).code).toBe('UNKNOWN_FAILURE');
    expect(categoriseChatError(undefined).code).toBe('UNKNOWN_FAILURE');
  });
});

describe('categoriseChatError — message safety (no raw SDK details leak)', () => {
  it('user-facing message never includes the original SDK string', () => {
    const sdkMsg = 'Could not resolve authentication method. Expected either apiKey or authToken to be set. Or for one of the "X-Api-Key" or "Authorization" headers to be explicitly omitted';
    const r = categoriseChatError(new Error(sdkMsg));
    expect(r.userMessage).not.toContain('X-Api-Key');
    expect(r.userMessage).not.toContain('Could not resolve authentication method');
    // raw is preserved separately for the server log
    expect(r.raw).toBe(sdkMsg);
  });
});
