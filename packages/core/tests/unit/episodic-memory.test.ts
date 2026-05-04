import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteMemoryDb } from '../../src/db/sqlite-memory.js';
import { EpisodeStore } from '../../src/memory/episodic-memory.js';

let tmpDir: string;
let db: SqliteMemoryDb;
let store: EpisodeStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-episodic-'));
  db = new SqliteMemoryDb(tmpDir);
  store = new EpisodeStore(db);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('EpisodeStore — create/get', () => {
  it('creates an episode in active status', () => {
    const ep = store.createEpisode('session-1');
    expect(ep.id).toBeDefined();
    expect(ep.sessionId).toBe('session-1');
    expect(ep.status).toBe('active');
    expect(ep.steps).toEqual([]);
    expect(ep.linkedMemoryIds).toEqual([]);
  });

  it('round-trips an episode through getEpisode', () => {
    const ep = store.createEpisode('session-2', 'project-A', 'My Episode');
    const got = store.getEpisode(ep.id);
    expect(got).not.toBeNull();
    expect(got!.id).toBe(ep.id);
    expect(got!.sessionId).toBe('session-2');
    expect(got!.projectId).toBe('project-A');
    expect(got!.title).toBe('My Episode');
  });

  it('returns null for an unknown episode id', () => {
    expect(store.getEpisode('nonexistent')).toBeNull();
  });

  it('uses default title when not provided', () => {
    const ep = store.createEpisode('session-x');
    expect(ep.title).toBe('Untitled Episode');
  });
});

describe('EpisodeStore — addStep / getEpisodeChain', () => {
  it('adds a step and chain reflects it', () => {
    const ep = store.createEpisode('s');
    store.addStep(ep.id, 'observation', 'saw the request');
    const chain = store.getEpisodeChain(ep.id);
    expect(chain.length).toBe(1);
    expect(chain[0].eventType).toBe('observation');
    expect(chain[0].content).toBe('saw the request');
  });

  it('preserves chronological order', () => {
    const ep = store.createEpisode('s');
    store.addStep(ep.id, 'observation', 'first');
    store.addStep(ep.id, 'reasoning', 'second');
    store.addStep(ep.id, 'action', 'third');
    const chain = store.getEpisodeChain(ep.id);
    expect(chain.map(s => s.content)).toEqual(['first', 'second', 'third']);
  });

  it('records linked memory ids on steps', () => {
    const ep = store.createEpisode('s');
    store.addStep(ep.id, 'observation', 'recall', 'mem-42');
    const got = store.getEpisode(ep.id);
    expect(got!.linkedMemoryIds).toContain('mem-42');
  });
});

describe('EpisodeStore — closeEpisode', () => {
  it('marks episode as closed and records outcome', () => {
    const ep = store.createEpisode('s');
    store.closeEpisode(ep.id, 0.9, 'great success');
    const got = store.getEpisode(ep.id);
    expect(got!.status).toBe('closed');
    expect(got!.outcomeScore).toBe(0.9);
    expect(got!.outcomeSummary).toBe('great success');
  });

  it('appends an outcome step when outcomeSummary is provided', () => {
    const ep = store.createEpisode('s');
    store.closeEpisode(ep.id, 1.0, 'finished');
    const chain = store.getEpisodeChain(ep.id);
    expect(chain.some(s => s.eventType === 'outcome' && s.content === 'finished')).toBe(true);
  });
});

describe('EpisodeStore — listing', () => {
  it('getRecentEpisodes returns most-recent first', () => {
    const a = store.createEpisode('s', 'p', 'A');
    // Force a small clock delta so ordering is deterministic
    const b = store.createEpisode('s', 'p', 'B');
    const recent = store.getRecentEpisodes(10);
    expect(recent.length).toBeGreaterThanOrEqual(2);
    // Newest first
    expect([recent[0].id, recent[1].id]).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it('getEpisodesBySession filters by session', () => {
    store.createEpisode('s1');
    store.createEpisode('s2');
    const list = store.getEpisodesBySession('s1');
    expect(list.length).toBe(1);
  });

  it('getActiveEpisode returns the most-recent active one', () => {
    const a = store.createEpisode('s');
    const b = store.createEpisode('s');
    store.closeEpisode(a.id);
    const active = store.getActiveEpisode('s');
    expect(active).not.toBeNull();
    expect(active!.id).toBe(b.id);
  });

  it('getActiveEpisode returns null when none exists', () => {
    const a = store.createEpisode('s');
    store.closeEpisode(a.id);
    expect(store.getActiveEpisode('s')).toBeNull();
  });
});

describe('EpisodeStore — getEpisodesForMemory', () => {
  it('returns episodes that linked a given memory', () => {
    const ep = store.createEpisode('s');
    store.addStep(ep.id, 'observation', 'recall', 'mem-77');
    const result = store.getEpisodesForMemory('mem-77');
    expect(result.length).toBe(1);
    expect(result[0].id).toBe(ep.id);
  });

  it('returns empty list for unlinked memory', () => {
    expect(store.getEpisodesForMemory('mem-unknown')).toEqual([]);
  });
});

describe('EpisodeStore — diagnostics', () => {
  it('reports zero counts initially', () => {
    const d = store.getDiagnostics();
    expect(d.totalEpisodes).toBe(0);
    expect(d.activeEpisodes).toBe(0);
    expect(d.closedEpisodes).toBe(0);
    expect(d.totalEvents).toBe(0);
  });

  it('counts increment after activity', () => {
    const ep = store.createEpisode('s');
    store.addStep(ep.id, 'observation', 'x');
    const d = store.getDiagnostics();
    expect(d.totalEpisodes).toBe(1);
    expect(d.activeEpisodes).toBe(1);
    expect(d.totalEvents).toBe(1);
  });
});
