import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SessionResetManager } from '../../src/sessions/reset.js';
import type { SessionEntry, SessionResetConfig } from '../../src/types.js';

function makeConfig(overrides: Partial<SessionResetConfig> = {}): SessionResetConfig {
  return {
    reset: { mode: 'daily', atHour: 4 },
    resetTriggers: ['/new', '/reset'],
    ...overrides,
  };
}

function makeEntry(updatedAt: string): SessionEntry {
  return {
    sessionId: 'sid-1',
    sessionKey: 'key-1',
    updatedAt,
    createdAt: updatedAt,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    origin: { label: 'test', provider: 'telegram', from: 'user1', to: 'bot' },
  };
}

describe('SessionResetManager', () => {
  let manager: SessionResetManager;

  describe('shouldReset - daily mode', () => {
    // Pin the system clock to a known time AFTER the 4am reset hour so the
    // "boundary crossed" assertions are deterministic regardless of the
    // wall clock when CI happens to run. Without this the test was flaky
    // whenever CI executed between midnight and 4am UTC.
    beforeEach(() => {
      manager = new SessionResetManager(makeConfig({ reset: { mode: 'daily', atHour: 4 } }));
      vi.useFakeTimers();
      // Pin to 2024-06-15 10:00:00 UTC — well after the 4am reset.
      vi.setSystemTime(new Date('2024-06-15T10:00:00Z'));
    });

    afterEach(() => { vi.useRealTimers(); });

    it('resets when daily boundary has been crossed', () => {
      // Create an entry last updated yesterday at 3am, and current time is today at 10am.
      const yesterday3am = new Date('2024-06-14T03:00:00Z');
      const entry = makeEntry(yesterday3am.toISOString());
      expect(manager.shouldReset(entry, 'dm', 'telegram')).toBe(true);
    });

    it('does not reset when updated today after reset hour', () => {
      const todayAfterReset = new Date('2024-06-15T05:00:00Z'); // after 4am reset hour
      const entry = makeEntry(todayAfterReset.toISOString());
      expect(manager.shouldReset(entry, 'dm', 'telegram')).toBe(false);
    });
  });

  describe('shouldReset - idle mode', () => {
    beforeEach(() => {
      manager = new SessionResetManager(makeConfig({ reset: { mode: 'idle', idleMinutes: 30 } }));
    });

    it('resets after idle timeout', () => {
      const old = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 mins ago
      expect(manager.shouldReset(makeEntry(old), 'dm', 'telegram')).toBe(true);
    });

    it('does not reset within idle timeout', () => {
      const recent = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 mins ago
      expect(manager.shouldReset(makeEntry(recent), 'dm', 'telegram')).toBe(false);
    });
  });

  describe('shouldReset - never mode', () => {
    it('never resets', () => {
      manager = new SessionResetManager(makeConfig({ reset: { mode: 'never' } }));
      const old = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString();
      expect(manager.shouldReset(makeEntry(old), 'dm', 'telegram')).toBe(false);
    });
  });

  describe('shouldReset - daily with idle fallback', () => {
    it('resets on idle even when daily boundary not crossed', () => {
      manager = new SessionResetManager(makeConfig({
        reset: { mode: 'daily', atHour: 4, idleMinutes: 30 },
      }));

      const recentButIdle = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // 60 mins ago
      expect(manager.shouldReset(makeEntry(recentButIdle), 'dm', 'telegram')).toBe(true);
    });
  });

  describe('parseResetTrigger', () => {
    beforeEach(() => {
      manager = new SessionResetManager(makeConfig());
    });

    it('detects exact /new trigger', () => {
      const result = manager.parseResetTrigger('/new');
      expect(result.isReset).toBe(true);
      expect(result.remainder).toBe('');
    });

    it('detects exact /reset trigger', () => {
      const result = manager.parseResetTrigger('/reset');
      expect(result.isReset).toBe(true);
      expect(result.remainder).toBe('');
    });

    it('extracts model name from /new model-name', () => {
      const result = manager.parseResetTrigger('/new claude-3-opus');
      expect(result.isReset).toBe(true);
      expect(result.newModel).toBe('claude-3-opus');
      expect(result.remainder).toBe('');
    });

    it('extracts model and remainder', () => {
      const result = manager.parseResetTrigger('/new gpt-4o hello there');
      expect(result.isReset).toBe(true);
      expect(result.newModel).toBe('gpt-4o');
      expect(result.remainder).toBe('hello there');
    });

    it('treats non-model word as remainder', () => {
      const result = manager.parseResetTrigger('/new hello world');
      expect(result.isReset).toBe(true);
      expect(result.newModel).toBeUndefined();
      expect(result.remainder).toBe('hello world');
    });

    it('returns non-reset for normal messages', () => {
      const result = manager.parseResetTrigger('Hello, how are you?');
      expect(result.isReset).toBe(false);
      expect(result.remainder).toBe('Hello, how are you?');
    });
  });

  describe('getPolicy', () => {
    it('returns channel-specific policy when configured', () => {
      manager = new SessionResetManager(makeConfig({
        reset: { mode: 'daily', atHour: 4 },
        resetByChannel: {
          telegram: { mode: 'idle', idleMinutes: 60 },
        },
      }));

      const policy = manager.getPolicy('dm', 'telegram');
      expect(policy.mode).toBe('idle');
      expect(policy.idleMinutes).toBe(60);
    });

    it('returns type-specific policy when configured', () => {
      manager = new SessionResetManager(makeConfig({
        reset: { mode: 'daily', atHour: 4 },
        resetByType: {
          group: { mode: 'never' },
        },
      }));

      const policy = manager.getPolicy('group', 'telegram');
      expect(policy.mode).toBe('never');
    });

    it('falls back to default policy', () => {
      const policy = new SessionResetManager(makeConfig()).getPolicy('dm', 'slack');
      expect(policy.mode).toBe('daily');
    });
  });
});
