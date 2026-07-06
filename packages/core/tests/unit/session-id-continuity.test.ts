/**
 * Regression — SessionManager.getOrCreate must honour the caller's session ID.
 *
 * Previously an unknown sessionId fell through to create() which generated a
 * fresh uuid, so every /api/chat call with a client-side sessionId landed in
 * its own brand-new session: history never accumulated and the agent
 * "forgot" the whole conversation between messages.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import { SessionManager } from '../../src/sessions/manager.js';
import { createDatabase } from '../../src/memory/database.js';

describe('SessionManager session-ID continuity', () => {
  let db: Database.Database;
  let mgr: SessionManager;
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-sess-'));
    db = createDatabase(dir);
    mgr = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('creates the session under the REQUESTED id when unknown', () => {
    const s = mgr.getOrCreate('client-abc');
    expect(s.id).toBe('client-abc');
  });

  it('returns the same session on repeat calls with the same id', () => {
    const first = mgr.getOrCreate('client-abc');
    const second = mgr.getOrCreate('client-abc');
    expect(second.id).toBe(first.id);
    expect(mgr.listActive()).toHaveLength(1);
  });

  it('still generates a uuid when no id is requested', () => {
    const s = mgr.getOrCreate();
    expect(s.id).toBeTruthy();
    expect(s.id).not.toBe('');
  });

  it('two different requested ids create two distinct sessions', () => {
    const a = mgr.getOrCreate('one');
    const b = mgr.getOrCreate('two');
    expect(a.id).not.toBe(b.id);
  });

  it('re-persisting a session MUST NOT cascade-delete its messages', () => {
    // persistSession used INSERT OR REPLACE; REPLACE deletes the old row
    // and messages.session_id is ON DELETE CASCADE — every chat turn wiped
    // the session's entire history. Pin the upsert behaviour.
    const s = mgr.getOrCreate('cascade-check');
    db.prepare(
      "INSERT INTO messages (session_id, role, content, timestamp) VALUES ('cascade-check','user','hello',?)",
    ).run(Date.now());
    expect(
      db.prepare("SELECT count(*) c FROM messages WHERE session_id='cascade-check'").get(),
    ).toEqual({ c: 1 });

    // update() → persistSession — the moment the messages used to vanish.
    mgr.update(s.id, []);
    expect(
      db.prepare("SELECT count(*) c FROM messages WHERE session_id='cascade-check'").get(),
    ).toEqual({ c: 1 });
  });
});
