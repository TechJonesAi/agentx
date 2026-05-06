/**
 * Claude OAuth — Authorization Code + PKCE flow against Anthropic's Claude
 * subscription auth endpoints. Tokens are stored in the macOS Keychain via
 * CredentialManager (never on disk in plaintext).
 *
 * Flow:
 *   1. `startAuthFlow()` — generates a PKCE verifier/challenge, opens a
 *      short-lived HTTP callback server on a random loopback port, opens the
 *      browser to claude.ai's authorize URL, and resolves when the user
 *      completes authorization.
 *   2. The callback server exchanges the received `code` at
 *      `console.anthropic.com/v1/oauth/token` for `{access_token, refresh_token}`.
 *   3. Tokens are written to Keychain under CLAUDE_OAUTH_* keys.
 *   4. `getAccessToken()` transparently refreshes expired tokens.
 *
 * This matches the flow used by Claude Code and other Anthropic-official
 * OAuth clients. The default CLIENT_ID is the widely-published public client
 * for the Claude Code CLI; projects can override with the env var
 * `ANTHROPIC_OAUTH_CLIENT_ID` (e.g. if Anthropic issues AgentX a dedicated one).
 *
 * Security note: This file performs NO password-based auth. The only way a
 * credential enters the system is through the user explicitly approving
 * access in the browser (which redirects a signed code to loopback).
 */
import * as crypto from 'node:crypto';
import * as http from 'node:http';
import { spawn } from 'node:child_process';
import { createLogger } from '../logger.js';
import { CredentialManager } from './keychain.js';

const log = createLogger('security:claude-oauth');

/**
 * Public OAuth client ID for the Claude Code CLI. Anthropic publishes this as
 * a public client, so it's safe to reuse for desktop tools like AgentX until
 * Anthropic offers per-app OAuth client registration. Override with the env
 * var ANTHROPIC_OAUTH_CLIENT_ID if you register your own client.
 */
const DEFAULT_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
const TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token';

/** OAuth scopes requested. `user:inference` = can call LLM APIs on user's behalf. */
const DEFAULT_SCOPES = ['org:create_api_key', 'user:profile', 'user:inference'];

// ─── Credential keys (opaque strings accepted by CredentialManager) ──────────
export const CLAUDE_OAUTH_ACCESS_TOKEN = 'CLAUDE_OAUTH_ACCESS_TOKEN';
export const CLAUDE_OAUTH_REFRESH_TOKEN = 'CLAUDE_OAUTH_REFRESH_TOKEN';
export const CLAUDE_OAUTH_EXPIRES_AT = 'CLAUDE_OAUTH_EXPIRES_AT';
export const CLAUDE_OAUTH_EMAIL = 'CLAUDE_OAUTH_EMAIL';

export interface ClaudeOAuthStatus {
  connected: boolean;
  email?: string;
  expiresAt?: number;
  expiresInSec?: number;
  stale?: boolean;
}

export interface ClaudeOAuthStartResult {
  authUrl: string;
  state: string;
  callbackPort: number;
  /**
   * Resolves with the final status once the user completes (or cancels)
   * authorization in the browser. Callers typically ignore this and poll
   * `getStatus()` instead, but it's here for tests.
   */
  waitForCompletion(): Promise<ClaudeOAuthStatus>;
}

// ─── PKCE helpers ────────────────────────────────────────────────────────────

function base64Url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function generateVerifier(): string {
  return base64Url(crypto.randomBytes(32));
}

function generateChallenge(verifier: string): string {
  return base64Url(crypto.createHash('sha256').update(verifier).digest());
}

// ─── Browser launcher ────────────────────────────────────────────────────────

/**
 * Open a URL in the user's default browser. Cross-platform but macOS-first.
 * Never blocks.
 */
function openBrowser(url: string): void {
  try {
    const cmd = process.platform === 'darwin'
      ? 'open'
      : process.platform === 'win32'
      ? 'start'
      : 'xdg-open';
    const args = process.platform === 'win32' ? ['', url] : [url];
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch (err) {
    log.warn({ err, url }, 'Failed to open browser automatically — user must open URL manually');
  }
}

// ─── Main service ────────────────────────────────────────────────────────────

export class ClaudeOAuthService {
  private pendingFlow: {
    verifier: string;
    state: string;
    server: http.Server;
    port: number;
    resolve: (status: ClaudeOAuthStatus) => void;
    reject: (err: Error) => void;
  } | null = null;

  constructor(private credentials: CredentialManager) {}

  /** Returns the current connection status without triggering any network I/O. */
  async getStatus(): Promise<ClaudeOAuthStatus> {
    const access = await this.credentials.getCredential(CLAUDE_OAUTH_ACCESS_TOKEN);
    if (!access) return { connected: false };

    const expiresAtStr = await this.credentials.getCredential(CLAUDE_OAUTH_EXPIRES_AT);
    const expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;
    const email = (await this.credentials.getCredential(CLAUDE_OAUTH_EMAIL)) ?? undefined;
    const now = Date.now();
    const expiresInSec = expiresAt > 0 ? Math.floor((expiresAt - now) / 1000) : undefined;
    const stale = expiresAt > 0 && now > expiresAt;

    return {
      connected: true,
      email,
      expiresAt: expiresAt > 0 ? expiresAt : undefined,
      expiresInSec,
      stale,
    };
  }

  /** Delete all Claude OAuth credentials. Safe to call when not connected. */
  async disconnect(): Promise<void> {
    await Promise.all([
      this.credentials.deleteCredential(CLAUDE_OAUTH_ACCESS_TOKEN),
      this.credentials.deleteCredential(CLAUDE_OAUTH_REFRESH_TOKEN),
      this.credentials.deleteCredential(CLAUDE_OAUTH_EXPIRES_AT),
      this.credentials.deleteCredential(CLAUDE_OAUTH_EMAIL),
    ]);
    log.info('Claude OAuth credentials cleared');
  }

  /**
   * Return a valid access token, refreshing if the current one has expired.
   * Returns null if not connected or the refresh fails.
   */
  async getAccessToken(): Promise<string | null> {
    const access = await this.credentials.getCredential(CLAUDE_OAUTH_ACCESS_TOKEN);
    if (!access) return null;

    const expiresAtStr = await this.credentials.getCredential(CLAUDE_OAUTH_EXPIRES_AT);
    const expiresAt = expiresAtStr ? Number(expiresAtStr) : 0;

    // Refresh when within 60s of expiry (or already expired).
    if (expiresAt > 0 && Date.now() > expiresAt - 60_000) {
      try {
        await this.refresh();
        return await this.credentials.getCredential(CLAUDE_OAUTH_ACCESS_TOKEN);
      } catch (err) {
        log.warn({ err }, 'Claude OAuth token refresh failed');
        return null;
      }
    }

    return access;
  }

  /** Refresh tokens using the stored refresh_token. */
  private async refresh(): Promise<void> {
    const refreshToken = await this.credentials.getCredential(CLAUDE_OAUTH_REFRESH_TOKEN);
    if (!refreshToken) throw new Error('No refresh token stored');

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.getClientId(),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Refresh failed: ${res.status} ${body.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    await this.persistTokens(data);
    log.info('Claude OAuth tokens refreshed');
  }

  /**
   * Start the authorization code + PKCE flow:
   *   - spin up a loopback callback server,
   *   - open the browser,
   *   - wait for the redirect carrying the auth code.
   * Returns the authorize URL immediately so the caller can surface it in the
   * UI (useful if the browser didn't auto-open).
   */
  async startAuthFlow(): Promise<ClaudeOAuthStartResult> {
    // If a flow is already in progress, cancel it first.
    if (this.pendingFlow) {
      try { this.pendingFlow.server.close(); } catch { /* ignore */ }
      this.pendingFlow.reject(new Error('Superseded by new auth flow'));
      this.pendingFlow = null;
    }

    const verifier = generateVerifier();
    const challenge = generateChallenge(verifier);
    const state = base64Url(crypto.randomBytes(16));

    // 1. Start loopback callback server on an OS-assigned port.
    const { server, port } = await this.startCallbackServer(verifier, state);

    // 2. Build the authorize URL.
    const redirectUri = `http://localhost:${port}/callback`;
    const params = new URLSearchParams({
      code: 'true',
      client_id: this.getClientId(),
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: DEFAULT_SCOPES.join(' '),
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const authUrl = `${AUTHORIZE_URL}?${params.toString()}`;

    // 3. Create the completion promise + resolve/reject handles.
    let resolveFn!: (s: ClaudeOAuthStatus) => void;
    let rejectFn!: (e: Error) => void;
    const completion = new Promise<ClaudeOAuthStatus>((resolve, reject) => {
      resolveFn = resolve;
      rejectFn = reject;
    });

    this.pendingFlow = { verifier, state, server, port, resolve: resolveFn, reject: rejectFn };

    // 4. Safety timeout — close the callback server after 5 minutes.
    const timeout = setTimeout(() => {
      if (this.pendingFlow && this.pendingFlow.server === server) {
        log.warn('Claude OAuth flow timed out (no callback within 5 min)');
        try { server.close(); } catch { /* ignore */ }
        this.pendingFlow.reject(new Error('OAuth flow timed out'));
        this.pendingFlow = null;
      }
    }, 5 * 60_000);
    server.on('close', () => clearTimeout(timeout));

    // 5. Open browser (best effort).
    openBrowser(authUrl);

    log.info({ port, authUrl: `${AUTHORIZE_URL}?...` }, 'Claude OAuth flow started');

    return {
      authUrl,
      state,
      callbackPort: port,
      waitForCompletion: () => completion,
    };
  }

  /**
   * Spins up a one-shot HTTP server bound to 127.0.0.1 on a random free port.
   * Resolves with the server + port immediately; the server handles:
   *   GET /callback?code=...&state=... → exchange code, close server.
   */
  private async startCallbackServer(
    verifier: string,
    expectedState: string,
  ): Promise<{ server: http.Server; port: number }> {
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          const url = new URL(req.url ?? '/', `http://127.0.0.1`);
          if (url.pathname !== '/callback') {
            res.writeHead(404);
            res.end('Not Found');
            return;
          }

          const code = url.searchParams.get('code');
          const state = url.searchParams.get('state');
          const error = url.searchParams.get('error');

          if (error) {
            this.respondHTML(res, 'Authorization denied', error, false);
            const pending = this.pendingFlow;
            if (pending) {
              pending.reject(new Error(`OAuth error: ${error}`));
              this.pendingFlow = null;
            }
            server.close();
            return;
          }

          if (!code || state !== expectedState) {
            this.respondHTML(res, 'Authorization mismatch', 'state mismatch or missing code', false);
            const pending = this.pendingFlow;
            if (pending) {
              pending.reject(new Error('State mismatch or missing code'));
              this.pendingFlow = null;
            }
            server.close();
            return;
          }

          // Exchange the code for tokens.
          try {
            const tokens = await this.exchangeCode(code, verifier, `http://localhost:${(server.address() as any)?.port}/callback`);
            await this.persistTokens(tokens);
            this.respondHTML(res, 'Connected!', 'AgentX is now connected to your Claude subscription. You can close this tab.', true);

            const status = await this.getStatus();
            const pending = this.pendingFlow;
            if (pending) {
              pending.resolve(status);
              this.pendingFlow = null;
            }
            server.close();
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.respondHTML(res, 'Token exchange failed', msg, false);
            const pending = this.pendingFlow;
            if (pending) {
              pending.reject(err as Error);
              this.pendingFlow = null;
            }
            server.close();
          }
        } catch (err) {
          log.error({ err }, 'Callback handler error');
          try { res.writeHead(500); res.end('Internal error'); } catch { /* ignore */ }
          server.close();
        }
      });

      server.on('error', (err) => {
        log.error({ err }, 'Callback server error');
        reject(err);
      });

      // Bind to 127.0.0.1 only, OS-assigned port.
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        const port = typeof addr === 'object' && addr ? addr.port : 0;
        if (!port) {
          reject(new Error('Failed to allocate callback port'));
          return;
        }
        resolve({ server, port });
      });
    });
  }

  private async exchangeCode(code: string, verifier: string, redirectUri: string): Promise<{
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    account?: { email_address?: string };
  }> {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
        client_id: this.getClientId(),
        code_verifier: verifier,
        state: this.pendingFlow?.state,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Token exchange failed: ${res.status} ${body.slice(0, 300)}`);
    }
    return res.json() as any;
  }

  private async persistTokens(data: {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    account?: { email_address?: string };
  }): Promise<void> {
    await this.credentials.setCredential(CLAUDE_OAUTH_ACCESS_TOKEN, data.access_token);

    if (data.refresh_token) {
      await this.credentials.setCredential(CLAUDE_OAUTH_REFRESH_TOKEN, data.refresh_token);
    }

    if (typeof data.expires_in === 'number' && data.expires_in > 0) {
      const expiresAt = Date.now() + data.expires_in * 1000;
      await this.credentials.setCredential(CLAUDE_OAUTH_EXPIRES_AT, String(expiresAt));
    }

    const email = data.account?.email_address;
    if (email) {
      await this.credentials.setCredential(CLAUDE_OAUTH_EMAIL, email);
    }
  }

  private respondHTML(res: http.ServerResponse, title: string, body: string, success: boolean): void {
    const color = success ? '#10b981' : '#ef4444';
    const html = `<!doctype html>
<html><head><title>${title} — AgentX</title></head>
<body style="font-family: -apple-system, Helvetica, Arial; background: #0a0e27; color: #e0e0e0; padding: 40px; text-align: center;">
  <h1 style="color: ${color}; margin-bottom: 12px;">${title}</h1>
  <p style="color: #9ca3af; font-size: 14px;">${body}</p>
  <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">You can close this tab.</p>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
  }

  private getClientId(): string {
    return process.env['ANTHROPIC_OAUTH_CLIENT_ID'] ?? DEFAULT_CLIENT_ID;
  }
}
