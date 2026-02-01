import { describe, it, expect, beforeEach } from 'vitest';
import { parseCommand } from '../../src/sessions/commands.js';
import { SessionResetManager } from '../../src/sessions/reset.js';
import type { CommandContext } from '../../src/sessions/commands.js';
import type { Message, AgentConfig, SessionEntry } from '../../src/types.js';

/**
 * E2E simulation of CLI command processing.
 * Tests the full command pipeline from user input to parsed result.
 */

function makeCommandContext(overrides: Partial<CommandContext> = {}): CommandContext {
  return {
    sessionId: 'test-session',
    sessionKey: 'agent:bot1:cli:dm:user1',
    sessionEntry: null,
    messages: [],
    config: {
      agent: { name: 'bot1', defaultProvider: 'anthropic', model: 'claude-3-opus' },
      providers: {},
      memory: { maxConversationHistory: 100, summarizeAfter: 50, embeddingProvider: 'none' },
      sessions: { persistToDisk: false, ttlMinutes: 60 },
      skills: { directory: './skills', autoReload: false },
      browser: { headless: true, timeout: 30000 },
      voice: { ttsProvider: 'none', sttProvider: 'none', whisperModel: 'base' },
      scheduler: { enabled: false, heartbeatIntervalMinutes: 60 },
      security: {
        sandboxShell: true, shellPermissionLevel: 'ask-confirm', maxShellTimeout: 30000,
        encryptStorage: false, auditLog: false, auditRetentionDays: 30,
        localAuth: false, autoLockMinutes: 0, multiUserMode: false,
        requireOwnerApproval: false, ownerPlatformId: '',
      },
      health: { enabled: false, port: 3100 },
    } as AgentConfig,
    contextTokens: 5000,
    maxContextTokens: 200000,
    ...overrides,
  };
}

describe('CLI command processing', () => {
  describe('parseCommand', () => {
    it('parses /new command', () => {
      const result = parseCommand('/new', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.command).toBe('reset');
      expect(result!.shouldReset).toBe(true);
    });

    it('parses /reset command', () => {
      const result = parseCommand('/reset', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.command).toBe('reset');
      expect(result!.shouldReset).toBe(true);
    });

    it('parses /stop command', () => {
      const result = parseCommand('/stop', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.command).toBe('stop');
      expect(result!.shouldStop).toBe(true);
    });

    it('parses /status command', () => {
      const result = parseCommand('/status', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.command).toBe('status');
      expect(result!.response).toContain('Session Status');
    });

    it('parses /context command', () => {
      const ctx = makeCommandContext({
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() },
          { role: 'assistant', content: 'Hi!', timestamp: Date.now() },
        ],
      });
      const result = parseCommand('/context', ctx);
      expect(result).not.toBeNull();
      expect(result!.command).toBe('context');
      expect(result!.response).toContain('Context Summary');
    });

    it('parses /context detail command', () => {
      const ctx = makeCommandContext({
        messages: [
          { role: 'user', content: 'Hello', timestamp: Date.now() },
          { role: 'assistant', content: 'Hi!', timestamp: Date.now() },
        ],
      });
      const result = parseCommand('/context detail', ctx);
      expect(result).not.toBeNull();
      expect(result!.response).toContain('Context Detail');
    });

    it('parses /compact command', () => {
      const result = parseCommand('/compact', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.command).toBe('compact');
      expect(result!.shouldCompact).toBe(true);
    });

    it('parses /compact with instructions', () => {
      const result = parseCommand('/compact keep last 5 messages', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.shouldCompact).toBe(true);
      expect(result!.compactInstructions).toBe('keep last 5 messages');
    });

    it('parses /send on command', () => {
      const result = parseCommand('/send on', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.command).toBe('send');
      expect(result!.response).toContain('on');
    });

    it('returns null for non-commands', () => {
      expect(parseCommand('Hello, how are you?', makeCommandContext())).toBeNull();
    });

    it('returns null for empty input', () => {
      expect(parseCommand('', makeCommandContext())).toBeNull();
    });

    it('returns null for unknown slash commands', () => {
      expect(parseCommand('/unknown', makeCommandContext())).toBeNull();
    });

    it('handles /new with model argument', () => {
      const result = parseCommand('/new claude-3-opus', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.shouldReset).toBe(true);
      expect(result!.newModel).toBe('claude-3-opus');
    });

    it('handles /new with model and follow-up message', () => {
      const result = parseCommand('/new gpt-4o Tell me a joke', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.newModel).toBe('gpt-4o');
      expect(result!.remainder).toBe('Tell me a joke');
    });

    it('handles /new with plain text (no model)', () => {
      const result = parseCommand('/new Tell me a joke', makeCommandContext());
      expect(result).not.toBeNull();
      expect(result!.newModel).toBeUndefined();
      expect(result!.remainder).toBe('Tell me a joke');
    });
  });

  describe('status with session data', () => {
    it('includes session entry details when available', () => {
      const entry: SessionEntry = {
        sessionId: 'sid-12345678',
        sessionKey: 'agent:bot1:cli:dm:user1',
        updatedAt: '2025-01-15T10:00:00.000Z',
        createdAt: '2025-01-15T09:00:00.000Z',
        inputTokens: 5000,
        outputTokens: 10000,
        totalTokens: 15000,
        contextTokens: 3000,
        origin: { label: 'CLI', provider: 'cli', from: 'user1', to: 'bot1' },
        displayName: 'Test Session',
      };

      const result = parseCommand('/status', makeCommandContext({ sessionEntry: entry }));
      expect(result!.response).toContain('Test Session');
      expect(result!.response).toContain('15000');
    });
  });

  describe('reset trigger flow integration', () => {
    let resetManager: SessionResetManager;

    beforeEach(() => {
      resetManager = new SessionResetManager({
        reset: { mode: 'daily', atHour: 4 },
        resetTriggers: ['/new', '/reset'],
      });
    });

    it('command parser and reset manager agree on /new', () => {
      const input = '/new gpt-4o';

      // Command parser route
      const cmdResult = parseCommand(input, makeCommandContext());
      expect(cmdResult!.shouldReset).toBe(true);
      expect(cmdResult!.newModel).toBe('gpt-4o');

      // Reset manager route
      const resetResult = resetManager.parseResetTrigger(input);
      expect(resetResult.isReset).toBe(true);
      expect(resetResult.newModel).toBe('gpt-4o');
    });
  });
});
