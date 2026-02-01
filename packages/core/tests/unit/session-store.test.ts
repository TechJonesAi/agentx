import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SessionStore } from '../../src/sessions/store.js';
import type { SessionEntry } from '../../src/types.js';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-test-'));
}

function makeEntry(key: string, overrides: Partial<SessionEntry> = {}): SessionEntry {
  const now = new Date().toISOString();
  return {
    sessionId: `sid-${key}`,
    sessionKey: key,
    updatedAt: now,
    createdAt: now,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    contextTokens: 0,
    origin: { label: 'test', provider: 'cli', from: 'user1', to: 'bot' },
    ...overrides,
  };
}

describe('SessionStore', () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storePath = path.join(tmpDir, 'sessions.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('starts empty', () => {
    const store = new SessionStore('test', storePath);
    expect(store.size()).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it('stores and retrieves entries', () => {
    const store = new SessionStore('test', storePath);
    const entry = makeEntry('key1');
    store.set('key1', entry);
    expect(store.get('key1')).toEqual(entry);
    expect(store.size()).toBe(1);
  });

  it('persists to disk and reloads', () => {
    const store1 = new SessionStore('test', storePath);
    store1.set('key1', makeEntry('key1'));
    store1.set('key2', makeEntry('key2'));

    const store2 = new SessionStore('test', storePath);
    expect(store2.size()).toBe(2);
    expect(store2.get('key1')).toBeTruthy();
    expect(store2.get('key2')).toBeTruthy();
  });

  it('deletes entries', () => {
    const store = new SessionStore('test', storePath);
    store.set('key1', makeEntry('key1'));
    expect(store.delete('key1')).toBe(true);
    expect(store.get('key1')).toBeNull();
    expect(store.delete('nonexistent')).toBe(false);
  });

  it('filters by provider', () => {
    const store = new SessionStore('test', storePath);
    store.set('k1', makeEntry('k1', { origin: { label: 'test', provider: 'telegram', from: 'a', to: 'b' } }));
    store.set('k2', makeEntry('k2', { origin: { label: 'test', provider: 'discord', from: 'a', to: 'b' } }));

    const telegramSessions = store.list({ provider: 'telegram' });
    expect(telegramSessions).toHaveLength(1);
    expect(telegramSessions[0]!.sessionKey).toBe('k1');
  });

  it('filters by keyPrefix', () => {
    const store = new SessionStore('test', storePath);
    store.set('agent:bot1:telegram:dm:alice', makeEntry('agent:bot1:telegram:dm:alice'));
    store.set('agent:bot1:discord:dm:bob', makeEntry('agent:bot1:discord:dm:bob'));

    const result = store.list({ keyPrefix: 'agent:bot1:telegram' });
    expect(result).toHaveLength(1);
  });

  it('updates token counts', () => {
    const store = new SessionStore('test', storePath);
    store.set('key1', makeEntry('key1'));
    store.updateTokens('key1', 100, 200, 50);

    const entry = store.get('key1')!;
    expect(entry.inputTokens).toBe(100);
    expect(entry.outputTokens).toBe(200);
    expect(entry.totalTokens).toBe(300);
    expect(entry.contextTokens).toBe(50);
  });

  it('returns active sessions within timeframe', () => {
    const store = new SessionStore('test', storePath);
    const recent = makeEntry('recent', { updatedAt: new Date().toISOString() });
    const old = makeEntry('old', { updatedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() });

    store.set('recent', recent);
    store.set('old', old);

    const active = store.getActive(60); // within last 60 minutes
    expect(active).toHaveLength(1);
    expect(active[0]!.sessionKey).toBe('recent');
  });
});
