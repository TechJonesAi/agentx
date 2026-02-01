import type { DmScope, InboundContext, SessionConfig } from '../types.js';

/**
 * Generate a deterministic session key based on scope and context.
 *
 * Session key formats:
 * - DM (main):                    agent:<agentId>:<mainKey>
 * - DM (per-peer):                agent:<agentId>:dm:<peerId>
 * - DM (per-channel-peer):        agent:<agentId>:<channel>:dm:<peerId>
 * - DM (per-account-channel-peer): agent:<agentId>:<channel>:<accountId>:dm:<peerId>
 * - Group:                        agent:<agentId>:<channel>:group:<groupId>
 * - Thread (appended):            ...:topic:<threadId>
 */
export function generateSessionKey(
  agentId: string,
  context: InboundContext,
  config: Pick<SessionConfig, 'dmScope' | 'mainKey' | 'identityLinks'>,
): string {
  const peerId = resolveIdentity(context.from, context.provider, config.identityLinks);
  let key: string;

  if (context.chatType === 'group') {
    // Group chats always isolate by group
    key = `agent:${agentId}:${context.provider}:group:${context.groupId ?? 'unknown'}`;
  } else {
    // DM routing follows dmScope
    key = generateDmKey(agentId, context, config.dmScope, config.mainKey, peerId);
  }

  // Append thread/topic if present
  if (context.threadId) {
    key += `:topic:${context.threadId}`;
  }

  return key;
}

function generateDmKey(
  agentId: string,
  context: InboundContext,
  scope: DmScope,
  mainKey: string,
  peerId: string,
): string {
  switch (scope) {
    case 'main':
      return `agent:${agentId}:${mainKey}`;

    case 'per-peer':
      return `agent:${agentId}:dm:${peerId}`;

    case 'per-channel-peer':
      return `agent:${agentId}:${context.provider}:dm:${peerId}`;

    case 'per-account-channel-peer':
      return `agent:${agentId}:${context.provider}:${context.accountId ?? 'default'}:dm:${peerId}`;

    default:
      return `agent:${agentId}:${mainKey}`;
  }
}

/**
 * Resolve a platform-specific ID to a canonical identity.
 * Returns the canonical name if found in identityLinks, otherwise the raw fromId.
 *
 * NOTE: We return just `fromId` (not `provider:fromId`) when unmapped to avoid
 * double-prefixing in per-channel-peer scope where provider is already in the key.
 */
function resolveIdentity(
  fromId: string,
  provider: string,
  identityLinks: Record<string, string[]>,
): string {
  const platformId = `${provider}:${fromId}`;

  for (const [canonical, ids] of Object.entries(identityLinks)) {
    if (ids.includes(platformId)) {
      return canonical;
    }
  }

  // Return raw fromId — the provider prefix is already part of the key
  // in per-channel-peer and per-account-channel-peer modes.
  return fromId;
}

/**
 * Normalize legacy session keys to the current format.
 * Converts old-style `group:<id>` keys to `agent:<agentId>:<channel>:group:<id>`.
 */
export function normalizeLegacyKey(key: string, agentId: string, channel: string): string {
  // Legacy format: group:<groupId>
  if (key.startsWith('group:')) {
    const groupId = key.slice(6);
    return `agent:${agentId}:${channel}:group:${groupId}`;
  }

  // Legacy format: dm:<peerId>
  if (key.startsWith('dm:')) {
    const peerId = key.slice(3);
    return `agent:${agentId}:dm:${peerId}`;
  }

  // Already in new format
  return key;
}

/**
 * Parse a session key to extract its components.
 */
export function parseSessionKey(key: string): {
  agentId: string;
  channel?: string;
  chatType: 'dm' | 'group' | 'thread' | 'main';
  peerId?: string;
  groupId?: string;
  threadId?: string;
} {
  const parts = key.split(':');

  // Find topic suffix
  const topicIdx = parts.indexOf('topic');
  const threadId = topicIdx >= 0 ? parts.slice(topicIdx + 1).join(':') : undefined;
  const mainParts = topicIdx >= 0 ? parts.slice(0, topicIdx) : parts;

  // agent:<agentId>:...
  const agentId = mainParts[1] ?? '';

  const groupIdx = mainParts.indexOf('group');
  if (groupIdx >= 0) {
    return {
      agentId,
      channel: mainParts[2],
      chatType: 'group',
      groupId: mainParts.slice(groupIdx + 1).join(':'),
      threadId,
    };
  }

  const dmIdx = mainParts.indexOf('dm');
  if (dmIdx >= 0) {
    return {
      agentId,
      channel: dmIdx > 2 ? mainParts[2] : undefined,
      chatType: threadId ? 'thread' : 'dm',
      peerId: mainParts.slice(dmIdx + 1).join(':'),
      threadId,
    };
  }

  // Main key (no dm/group)
  return {
    agentId,
    chatType: 'main',
    threadId,
  };
}
