/**
 * Anthropic Subscription Provider — uses a Claude-subscription OAuth token
 * (Authorization: Bearer ...) instead of a pay-per-token API key.
 *
 * Usage counts against the user's Claude Pro/Max subscription quota. The same
 * underlying /v1/messages endpoint is used as the API-key provider; the only
 * difference is how the SDK authenticates. An `anthropic-beta` header is
 * required to opt into OAuth-scoped access.
 *
 * Tokens are fetched freshly per request via ClaudeOAuthService.getAccessToken()
 * so automatic refresh just works.
 */
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicProvider } from './anthropic.js';
import { createLogger } from '../logger.js';
import type { ClaudeOAuthService } from '../security/claude-oauth.js';

const log = createLogger('llm:anthropic-subscription');

/** Beta header toggling OAuth-token auth on the Anthropic API. */
const OAUTH_BETA_HEADER = 'oauth-2025-04-20';

export class AnthropicSubscriptionProvider extends AnthropicProvider {
  readonly name = 'anthropic-subscription';

  constructor(
    private oauth: ClaudeOAuthService,
    model?: string,
    maxTokens?: number,
  ) {
    super(model, maxTokens);
  }

  /** Configured when the user has an active OAuth token. */
  isConfigured(): boolean {
    // We don't block construction if no token yet; the first `complete()` will
    // raise a clear error. This matches how the API-key provider behaves when
    // ANTHROPIC_API_KEY is missing.
    return true;
  }

  /**
   * Override: build a fresh Anthropic client with the current OAuth token
   * every call. This lets token refresh happen transparently between requests.
   */
  protected async getClientAsync(): Promise<Anthropic> {
    const token = await this.oauth.getAccessToken();
    if (!token) {
      throw new Error('No Claude subscription token available — connect your account in Models → Subscription Accounts');
    }
    return new Anthropic({
      authToken: token,
      defaultHeaders: {
        'anthropic-beta': OAUTH_BETA_HEADER,
      },
    });
  }

  // ─ complete / completeStream: override to use the async client ────────────
  //
  // The parent class's complete() uses a cached getClient(). We re-implement
  // here minimally to call getClientAsync() every request. The conversion
  // helpers (convertMessages, convertTools, parseResponse) are inherited.

  async complete(options: Parameters<AnthropicProvider['complete']>[0]): ReturnType<AnthropicProvider['complete']> {
    const client = await this.getClientAsync();
    // Cast to any to call parent's private helpers via duck-typing on the client
    // (the parent's complete() depends on these helpers). Safer alternative:
    // temporarily override this.client and call super.complete(). Do that:
    const self = this as unknown as { client: Anthropic | null };
    const previous = self.client;
    self.client = client;
    try {
      log.debug('Using OAuth Bearer token for /v1/messages call');
      return await super.complete(options);
    } finally {
      // Restore to null so parent won't reuse a stale client on next call
      // from the API-key code path.
      self.client = previous;
    }
  }

  async completeStream(
    options: Parameters<AnthropicProvider['completeStream']>[0],
    callbacks: Parameters<AnthropicProvider['completeStream']>[1],
  ): ReturnType<AnthropicProvider['completeStream']> {
    const client = await this.getClientAsync();
    const self = this as unknown as { client: Anthropic | null };
    const previous = self.client;
    self.client = client;
    try {
      log.debug('Using OAuth Bearer token for streaming /v1/messages call');
      return await super.completeStream(options, callbacks);
    } finally {
      self.client = previous;
    }
  }
}
