import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSessionKey } from '../../src/sessions/keys.js';
import { SessionResetManager } from '../../src/sessions/reset.js';
import { ContextManager } from '../../src/context-manager.js';
import type { InboundContext, Message, SessionConfig, SessionResetConfig } from '../../src/types.js';

/**
 * End-to-end simulation of a Telegram bot conversation flow.
 * Tests the complete pipeline: context → key → reset check → context management.
 *
 * Note: This doesn't use the real Telegram API — it simulates the message flow
 * that a Telegram integration would trigger.
 */

const AGENT_ID = 'agentx';
const SESSION_CONFIG: Pick<SessionConfig, 'dmScope' | 'mainKey' | 'identityLinks'> = {
  dmScope: 'per-channel-peer',
  mainKey: 'main',
  identityLinks: {
    darren: ['telegram:123456789', 'discord:darren#1234'],
  },
};

const RESET_CONFIG: SessionResetConfig = {
  reset: { mode: 'idle', idleMinutes: 30 },
  resetTriggers: ['/new', '/reset'],
};

function simulateTelegramDM(userId: string, text: string): { context: InboundContext; message: string } {
  return {
    context: {
      label: `Telegram DM from ${userId}`,
      provider: 'telegram',
      from: userId,
      to: AGENT_ID,
      chatType: 'dm',
    },
    message: text,
  };
}

function simulateTelegramGroup(userId: string, groupId: string, text: string): { context: InboundContext; message: string } {
  return {
    context: {
      label: `Telegram group ${groupId}`,
      provider: 'telegram',
      from: userId,
      to: AGENT_ID,
      chatType: 'group',
      groupId,
    },
    message: text,
  };
}

describe('Telegram bot E2E simulation', () => {
  let resetManager: SessionResetManager;
  let contextManager: ContextManager;

  beforeEach(() => {
    resetManager = new SessionResetManager(RESET_CONFIG);
    contextManager = new ContextManager('anthropic');
  });

  describe('DM conversation flow', () => {
    it('routes known user to unified session via identity links', () => {
      const { context } = simulateTelegramDM('123456789', 'Hello');
      const key = generateSessionKey(AGENT_ID, context, SESSION_CONFIG);
      expect(key).toBe('agent:agentx:telegram:dm:darren');
    });

    it('routes unknown user by raw ID', () => {
      const { context } = simulateTelegramDM('unknown999', 'Hello');
      const key = generateSessionKey(AGENT_ID, context, SESSION_CONFIG);
      expect(key).toBe('agent:agentx:telegram:dm:unknown999');
    });

    it('handles /new command to reset session with model switch', () => {
      const { message } = simulateTelegramDM('123456789', '/new claude-3-opus Write a haiku');
      const trigger = resetManager.parseResetTrigger(message);

      expect(trigger.isReset).toBe(true);
      expect(trigger.newModel).toBe('claude-3-opus');
      expect(trigger.remainder).toBe('Write a haiku');
    });

    it('handles /reset command', () => {
      const { message } = simulateTelegramDM('123456789', '/reset');
      const trigger = resetManager.parseResetTrigger(message);
      expect(trigger.isReset).toBe(true);
      expect(trigger.remainder).toBe('');
    });

    it('passes regular messages through without reset', () => {
      const { message } = simulateTelegramDM('123456789', 'What is the weather?');
      const trigger = resetManager.parseResetTrigger(message);
      expect(trigger.isReset).toBe(false);
      expect(trigger.remainder).toBe('What is the weather?');
    });
  });

  describe('group conversation flow', () => {
    it('isolates group sessions by groupId', () => {
      const msg1 = simulateTelegramGroup('user1', 'group-abc', 'Hi');
      const msg2 = simulateTelegramGroup('user1', 'group-def', 'Hi');

      const key1 = generateSessionKey(AGENT_ID, msg1.context, SESSION_CONFIG);
      const key2 = generateSessionKey(AGENT_ID, msg2.context, SESSION_CONFIG);

      expect(key1).toBe('agent:agentx:telegram:group:group-abc');
      expect(key2).toBe('agent:agentx:telegram:group:group-def');
      expect(key1).not.toBe(key2);
    });

    it('multiple users in same group share one session', () => {
      const msg1 = simulateTelegramGroup('user1', 'group-abc', 'Hi');
      const msg2 = simulateTelegramGroup('user2', 'group-abc', 'Hello');

      const key1 = generateSessionKey(AGENT_ID, msg1.context, SESSION_CONFIG);
      const key2 = generateSessionKey(AGENT_ID, msg2.context, SESSION_CONFIG);

      expect(key1).toBe(key2);
    });
  });

  describe('context management in long conversations', () => {
    it('short conversation stays within budget', async () => {
      const messages: Message[] = [
        { role: 'user', content: 'Hello', timestamp: Date.now() },
        { role: 'assistant', content: 'Hi there! How can I help?', timestamp: Date.now() },
        { role: 'user', content: 'What is 2+2?', timestamp: Date.now() },
        { role: 'assistant', content: '2+2 = 4', timestamp: Date.now() },
      ];

      const result = await contextManager.prepareContext('session-1', messages);
      expect(result.wasTruncated).toBe(false);
      expect(result.summaryAdded).toBe(false);
      expect(result.messages).toHaveLength(4);
    });

    it('estimates token budget correctly', () => {
      const config = contextManager.getConfig();
      const budget = contextManager.getMessageBudget();
      expect(budget).toBe(config.maxContextTokens - config.reservedOutputTokens - config.systemPromptTokens);
      expect(budget).toBeGreaterThan(0);
    });
  });

  describe('cross-platform session continuity', () => {
    it('per-peer scope: same session across platforms', () => {
      const perPeerConfig = { ...SESSION_CONFIG, dmScope: 'per-peer' as const };

      const telegramKey = generateSessionKey(AGENT_ID,
        simulateTelegramDM('123456789', 'Hi').context,
        perPeerConfig,
      );

      const discordKey = generateSessionKey(AGENT_ID, {
        label: 'Discord DM',
        provider: 'discord',
        from: 'darren#1234',
        to: AGENT_ID,
        chatType: 'dm',
      }, perPeerConfig);

      // Both resolve to 'darren' via identity links
      expect(telegramKey).toBe(discordKey);
      expect(telegramKey).toBe('agent:agentx:dm:darren');
    });
  });
});
