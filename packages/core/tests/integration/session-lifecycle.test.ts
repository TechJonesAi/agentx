import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../../src/sessions/store.js';
import { IdentityResolver } from '../../src/sessions/identity.js';
import { SessionResetManager } from '../../src/sessions/reset.js';
import { generateSessionKey } from '../../src/sessions/keys.js';
import type { InboundContext, SessionEntry, SessionResetConfig } from '../../src/types.js';

/**
 * Integration tests for the full session lifecycle:
 * context → key generation → store → reset checks
 */

function makeContext(overrides: Partial<InboundContext> = {}): InboundContext {
  return {
    label: 'test',
    provider: 'telegram',
    from: 'user123',
    to: 'bot',
    chatType: 'dm',
    ...overrides,
  };
}

function makeEntry(key: string, updatedAt?: string): SessionEntry {
  const now = updatedAt ?? new Date().toISOString();
  return {
    sessionId: `sid-${key}`,
    sessionKey: key,
    updatedAt: now,
    createdAt: now,
    inputTokens: 100,
    outputTokens: 200,
    totalTokens: 300,
    contextTokens: 50,
    origin: { label: 'test', provider: 'telegram', from: 'user123', to: 'bot' },
  };
}

describe('Session lifecycle', () => {
  let tmpDir: string;
  let store: SessionStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-lifecycle-'));
    store = new SessionStore('bot1', path.join(tmpDir, 'sessions.json'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('identity-aware key generation', () => {
    it('same user on different platforms gets same session with identity links', () => {
      const identityLinks = {
        darren: ['telegram:user123', 'discord:darren#1234'],
      };

      const telegramKey = generateSessionKey('bot1', makeContext({
        provider: 'telegram',
        from: 'user123',
      }), {
        dmScope: 'per-peer',
        mainKey: 'main',
        identityLinks,
      });

      const discordKey = generateSessionKey('bot1', makeContext({
        provider: 'discord',
        from: 'darren#1234',
      }), {
        dmScope: 'per-peer',
        mainKey: 'main',
        identityLinks,
      });

      // Both should resolve to canonical name 'darren'
      expect(telegramKey).toBe('agent:bot1:dm:darren');
      expect(discordKey).toBe('agent:bot1:dm:darren');
    });

    it('same user on different platforms gets separate sessions with per-channel-peer scope', () => {
      const identityLinks = {
        darren: ['telegram:user123', 'discord:darren#1234'],
      };

      const telegramKey = generateSessionKey('bot1', makeContext({
        provider: 'telegram',
        from: 'user123',
      }), {
        dmScope: 'per-channel-peer',
        mainKey: 'main',
        identityLinks,
      });

      const discordKey = generateSessionKey('bot1', makeContext({
        provider: 'discord',
        from: 'darren#1234',
      }), {
        dmScope: 'per-channel-peer',
        mainKey: 'main',
        identityLinks,
      });

      // Even though both resolve to 'darren', channel prefix makes them different
      expect(telegramKey).toBe('agent:bot1:telegram:dm:darren');
      expect(discordKey).toBe('agent:bot1:discord:dm:darren');
      expect(telegramKey).not.toBe(discordKey);
    });
  });

  describe('store + reset integration', () => {
    it('creates session, checks reset policy, then resets', () => {
      const resetConfig: SessionResetConfig = {
        reset: { mode: 'idle', idleMinutes: 30 },
        resetTriggers: ['/new', '/reset'],
      };
      const resetManager = new SessionResetManager(resetConfig);

      // Create a fresh session
      const key = 'agent:bot1:telegram:dm:user123';
      store.set(key, makeEntry(key));

      // Fresh session should NOT reset
      const freshEntry = store.get(key)!;
      expect(resetManager.shouldReset(freshEntry, 'dm', 'telegram')).toBe(false);

      // Simulate stale session (updated 2 hours ago)
      store.set(key, makeEntry(key, new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()));
      const staleEntry = store.get(key)!;
      expect(resetManager.shouldReset(staleEntry, 'dm', 'telegram')).toBe(true);
    });

    it('handles /new command to reset and switch model', () => {
      const resetConfig: SessionResetConfig = {
        reset: { mode: 'never' },
        resetTriggers: ['/new', '/reset'],
      };
      const resetManager = new SessionResetManager(resetConfig);

      const result = resetManager.parseResetTrigger('/new claude-3-opus Tell me a joke');
      expect(result.isReset).toBe(true);
      expect(result.newModel).toBe('claude-3-opus');
      expect(result.remainder).toBe('Tell me a joke');
    });
  });

  describe('session store persistence across restarts', () => {
    it('persists session data including token counts', () => {
      const key = 'agent:bot1:telegram:dm:user123';
      store.set(key, makeEntry(key));
      store.updateTokens(key, 500, 1000, 200);

      // Reload store
      const store2 = new SessionStore('bot1', path.join(tmpDir, 'sessions.json'));
      const entry = store2.get(key)!;

      expect(entry.inputTokens).toBe(600); // 100 initial + 500
      expect(entry.outputTokens).toBe(1200); // 200 initial + 1000
      expect(entry.totalTokens).toBe(1800);
      expect(entry.contextTokens).toBe(200);
    });
  });

  describe('identity resolver integration', () => {
    it('dynamically links new identities', () => {
      const resolver = new IdentityResolver({
        links: { darren: ['telegram:123'] },
      });

      // Link a new platform
      resolver.link('darren', 'discord:darren#1234');

      expect(resolver.resolve('discord:darren#1234')).toBe('darren');
      expect(resolver.getPlatformIds('darren')).toHaveLength(2);
    });

    it('creates unified sessions after identity discovery', () => {
      const resolver = new IdentityResolver({
        links: {},
      });

      // Initially, user is unknown — separate sessions
      const key1 = generateSessionKey('bot1', makeContext({ provider: 'telegram', from: 'user123' }), {
        dmScope: 'per-peer',
        mainKey: 'main',
        identityLinks: resolver.getConfig().links,
      });

      // Now we discover the identity
      resolver.link('darren', 'telegram:user123');
      resolver.link('darren', 'discord:darren#1234');

      // After linking, both platforms resolve to same key
      const key2 = generateSessionKey('bot1', makeContext({ provider: 'telegram', from: 'user123' }), {
        dmScope: 'per-peer',
        mainKey: 'main',
        identityLinks: resolver.getConfig().links,
      });

      const key3 = generateSessionKey('bot1', makeContext({ provider: 'discord', from: 'darren#1234' }), {
        dmScope: 'per-peer',
        mainKey: 'main',
        identityLinks: resolver.getConfig().links,
      });

      expect(key2).toBe('agent:bot1:dm:darren');
      expect(key3).toBe('agent:bot1:dm:darren');
      // key1 was generated before linking, so it used the raw ID
      expect(key1).toBe('agent:bot1:dm:user123');
    });
  });
});
