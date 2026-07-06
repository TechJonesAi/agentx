/**
 * Regression — ConversationMemory.getMessages must keep the most RECENT
 * messages when a session exceeds maxHistory.
 *
 * The old query (ORDER BY timestamp ASC LIMIT n) kept the OLDEST n rows, so
 * once a chat grew past the limit the model stopped seeing its own latest
 * turns — users experienced AgentX "forgetting" what it had just created.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { ConversationMemory } from '../../src/memory/conversation.js';
import { createDatabase } from '../../src/memory/database.js';

describe('ConversationMemory recency window', () => {
  let db: Database.Database;
  let memory: ConversationMemory;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-conv-'));
    db = createDatabase(dir);
    memory = new ConversationMemory(db, 10); // small window for the test
    db.prepare(
      "INSERT INTO sessions (id, metadata, created_at, updated_at) VALUES ('s1', '{}', ?, ?)",
    ).run(Date.now(), Date.now());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function seed(count: number): void {
    const base = Date.now();
    for (let i = 0; i < count; i++) {
      memory.addMessage('s1', {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message-${i}`,
        timestamp: base + i * 1000,
      });
    }
  }

  it('returns everything (chronological) while under the limit', () => {
    seed(4);
    const msgs = memory.getMessages('s1');
    expect(msgs.map((m) => m.content)).toEqual(
      ['message-0', 'message-1', 'message-2', 'message-3']);
  });

  it('keeps the NEWEST maxHistory messages once the session grows past it', () => {
    seed(25);
    const msgs = memory.getMessages('s1');
    expect(msgs).toHaveLength(10);
    // Must be the last 10 (15..24) — the model must always see its own
    // most recent work, not the opening pleasantries.
    expect(msgs[0]!.content).toBe('message-15');
    expect(msgs[9]!.content).toBe('message-24');
  });

  it('still returns chronological order after windowing', () => {
    seed(25);
    const msgs = memory.getMessages('s1');
    const stamps = msgs.map((m) => m.timestamp);
    expect([...stamps].sort((a, b) => a - b)).toEqual(stamps);
  });

  it('explicit limit also selects from the newest end', () => {
    seed(6);
    const msgs = memory.getMessages('s1', 2);
    expect(msgs.map((m) => m.content)).toEqual(['message-4', 'message-5']);
  });

  it('breaks identical-timestamp ties by insertion order', () => {
    const t = Date.now();
    for (let i = 0; i < 12; i++) {
      memory.addMessage('s1', { role: 'user', content: `same-${i}`, timestamp: t });
    }
    const msgs = memory.getMessages('s1');
    expect(msgs).toHaveLength(10);
    expect(msgs[9]!.content).toBe('same-11'); // newest insertion survives
  });
});
