import { describe, it, expect } from 'vitest';
import { generateSessionKey, parseSessionKey, normalizeLegacyKey } from '../../src/sessions/keys.js';
import type { InboundContext, SessionConfig } from '../../src/types.js';

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

function makeConfig(overrides: Partial<SessionConfig> = {}): Pick<SessionConfig, 'dmScope' | 'mainKey' | 'identityLinks'> {
  return {
    dmScope: 'per-channel-peer',
    mainKey: 'main',
    identityLinks: {},
    ...overrides,
  };
}

describe('generateSessionKey', () => {
  describe('DM scopes', () => {
    it('generates main scope key', () => {
      const key = generateSessionKey('bot1', makeContext(), makeConfig({ dmScope: 'main', mainKey: 'inbox' }));
      expect(key).toBe('agent:bot1:inbox');
    });

    it('generates per-peer scope key', () => {
      const key = generateSessionKey('bot1', makeContext(), makeConfig({ dmScope: 'per-peer' }));
      expect(key).toBe('agent:bot1:dm:user123');
    });

    it('generates per-channel-peer scope key', () => {
      const key = generateSessionKey('bot1', makeContext(), makeConfig({ dmScope: 'per-channel-peer' }));
      expect(key).toBe('agent:bot1:telegram:dm:user123');
    });

    it('generates per-account-channel-peer scope key', () => {
      const ctx = makeContext({ accountId: 'acct1' });
      const key = generateSessionKey('bot1', ctx, makeConfig({ dmScope: 'per-account-channel-peer' }));
      expect(key).toBe('agent:bot1:telegram:acct1:dm:user123');
    });

    it('uses default accountId when not provided', () => {
      const key = generateSessionKey('bot1', makeContext(), makeConfig({ dmScope: 'per-account-channel-peer' }));
      expect(key).toBe('agent:bot1:telegram:default:dm:user123');
    });
  });

  describe('group chats', () => {
    it('generates group key with groupId', () => {
      const ctx = makeContext({ chatType: 'group', groupId: 'room42' });
      const key = generateSessionKey('bot1', ctx, makeConfig());
      expect(key).toBe('agent:bot1:telegram:group:room42');
    });

    it('uses unknown when groupId is missing', () => {
      const ctx = makeContext({ chatType: 'group' });
      const key = generateSessionKey('bot1', ctx, makeConfig());
      expect(key).toBe('agent:bot1:telegram:group:unknown');
    });
  });

  describe('threads', () => {
    it('appends thread suffix to DM key', () => {
      const ctx = makeContext({ threadId: 'topic99' });
      const key = generateSessionKey('bot1', ctx, makeConfig({ dmScope: 'per-channel-peer' }));
      expect(key).toBe('agent:bot1:telegram:dm:user123:topic:topic99');
    });

    it('appends thread suffix to group key', () => {
      const ctx = makeContext({ chatType: 'group', groupId: 'room42', threadId: 'topic99' });
      const key = generateSessionKey('bot1', ctx, makeConfig());
      expect(key).toBe('agent:bot1:telegram:group:room42:topic:topic99');
    });
  });

  describe('identity resolution', () => {
    it('resolves cross-platform identity via identityLinks', () => {
      const config = makeConfig({
        dmScope: 'per-peer',
        identityLinks: { darren: ['telegram:user123', 'discord:darren#1234'] },
      });
      const key = generateSessionKey('bot1', makeContext(), config);
      expect(key).toBe('agent:bot1:dm:darren');
    });

    it('falls back to raw fromId when no identity link matches', () => {
      const config = makeConfig({
        dmScope: 'per-peer',
        identityLinks: { alice: ['discord:alice#0001'] },
      });
      const key = generateSessionKey('bot1', makeContext(), config);
      expect(key).toBe('agent:bot1:dm:user123');
    });
  });
});

describe('parseSessionKey', () => {
  it('parses main key', () => {
    const result = parseSessionKey('agent:bot1:inbox');
    expect(result).toEqual({
      agentId: 'bot1',
      chatType: 'main',
      threadId: undefined,
    });
  });

  it('parses DM key without channel', () => {
    const result = parseSessionKey('agent:bot1:dm:user123');
    expect(result).toEqual({
      agentId: 'bot1',
      channel: undefined,
      chatType: 'dm',
      peerId: 'user123',
      threadId: undefined,
    });
  });

  it('parses DM key with channel', () => {
    const result = parseSessionKey('agent:bot1:telegram:dm:user123');
    expect(result).toEqual({
      agentId: 'bot1',
      channel: 'telegram',
      chatType: 'dm',
      peerId: 'user123',
      threadId: undefined,
    });
  });

  it('parses group key', () => {
    const result = parseSessionKey('agent:bot1:discord:group:room42');
    expect(result).toEqual({
      agentId: 'bot1',
      channel: 'discord',
      chatType: 'group',
      groupId: 'room42',
      threadId: undefined,
    });
  });

  it('parses DM key with thread', () => {
    const result = parseSessionKey('agent:bot1:telegram:dm:user123:topic:thread1');
    expect(result).toEqual({
      agentId: 'bot1',
      channel: 'telegram',
      chatType: 'thread',
      peerId: 'user123',
      threadId: 'thread1',
    });
  });
});

describe('normalizeLegacyKey', () => {
  it('converts legacy group key', () => {
    const result = normalizeLegacyKey('group:room42', 'bot1', 'telegram');
    expect(result).toBe('agent:bot1:telegram:group:room42');
  });

  it('converts legacy DM key', () => {
    const result = normalizeLegacyKey('dm:user123', 'bot1', 'telegram');
    expect(result).toBe('agent:bot1:dm:user123');
  });

  it('passes through already-normalized keys', () => {
    const key = 'agent:bot1:telegram:dm:user123';
    expect(normalizeLegacyKey(key, 'bot1', 'telegram')).toBe(key);
  });
});
