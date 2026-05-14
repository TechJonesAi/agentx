import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { FeedbackStore } from '../../src/memory/feedback-store.js';

let tmpDir: string;
let db: Database.Database;
let store: FeedbackStore;

// Windows IO budget — better-sqlite3 cold open + FeedbackStore schema
// bootstrap routinely takes 6-12s on GitHub Windows runners under load
// (vs ~30ms on Unix). Default 10000ms hook budget is insufficient.
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-fbk-'));
  db = new Database(path.join(tmpDir, 'fbk.db'));
  store = new FeedbackStore(db);
}, 60_000);

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('FeedbackStore — schema bootstrap', () => {
  it('creates the chat_feedback table on construction', () => {
    const row = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chat_feedback'"
    ).get();
    expect(row).toBeDefined();
  });
});

describe('FeedbackStore.validate', () => {
  const minimal = {
    messageId: 'msg-1',
    userQuery: 'q',
    assistantResponse: 'a',
    rating: 'up' as const,
  };

  it('accepts a valid minimal payload', () => {
    expect(() => FeedbackStore.validate(minimal)).not.toThrow();
  });

  it.each([
    ['messageId', { ...minimal, messageId: '' }],
    ['userQuery missing', { ...minimal, userQuery: undefined }],
    ['assistantResponse missing', { ...minimal, assistantResponse: 123 }],
    ['rating wrong', { ...minimal, rating: 'meh' }],
  ])('rejects invalid payload: %s', (_label, bad) => {
    expect(() => FeedbackStore.validate(bad as never)).toThrow();
  });

  it('rejects non-object payload', () => {
    expect(() => FeedbackStore.validate(null as never)).toThrow();
    expect(() => FeedbackStore.validate('string' as never)).toThrow();
  });

  it('accepts optional comment + retrieval fields', () => {
    expect(() => FeedbackStore.validate({
      ...minimal,
      rating: 'down',
      comment: 'wrong',
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'entity',
      retrievalMatchCount: 5,
      retrievalDocumentIds: ['d1', 'd2'],
      sessionId: 's-1',
    })).not.toThrow();
  });

  it('rejects non-string elements in retrievalDocumentIds', () => {
    expect(() => FeedbackStore.validate({
      ...minimal,
      retrievalDocumentIds: ['d1', 42 as unknown as string, 'd3'],
    })).toThrow();
  });
});

describe('FeedbackStore.record — upvote', () => {
  it('persists a minimal upvote', () => {
    const r = store.record({
      messageId: 'msg-1', userQuery: 'q', assistantResponse: 'a', rating: 'up',
    });
    expect(r.feedbackId).toBeDefined();
    expect(r.messageId).toBe('msg-1');
    expect(r.rating).toBe('up');
    expect(r.comment).toBeNull();
    expect(r.retrievalDocumentIds).toBeNull();
    expect(r.createdAt).toBeGreaterThan(0);
  });

  it('list() returns the record (newest first)', () => {
    store.record({ messageId: 'm1', userQuery: 'q1', assistantResponse: 'a1', rating: 'up' });
    store.record({ messageId: 'm2', userQuery: 'q2', assistantResponse: 'a2', rating: 'up' });
    const list = store.list();
    expect(list.length).toBe(2);
    expect(list[0].messageId).toBe('m2');
    expect(list[1].messageId).toBe('m1');
  });
});

describe('FeedbackStore.record — downvote', () => {
  it('persists a downvote with a comment', () => {
    const r = store.record({
      messageId: 'msg-2',
      userQuery: 'who is robert moyes',
      assistantResponse: 'I do not know',
      rating: 'down',
      comment: 'should have used FTS',
    });
    expect(r.rating).toBe('down');
    expect(r.comment).toBe('should have used FTS');
  });

  it('persists a downvote WITHOUT a comment', () => {
    const r = store.record({
      messageId: 'msg-2', userQuery: 'q', assistantResponse: 'a', rating: 'down',
    });
    expect(r.rating).toBe('down');
    expect(r.comment).toBeNull();
  });
});

describe('FeedbackStore.record — retrieval metadata', () => {
  it('stores retrieval intent / source / matchCount / documentIds', () => {
    const r = store.record({
      messageId: 'm1', userQuery: 'q', assistantResponse: 'a', rating: 'up',
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'entity',
      retrievalMatchCount: 12,
      retrievalDocumentIds: ['doc-a', 'doc-b', 'doc-c'],
      sessionId: 's-99',
    });
    expect(r.retrievalIntent).toBe('EXACT_SEARCH');
    expect(r.retrievalSource).toBe('entity');
    expect(r.retrievalMatchCount).toBe(12);
    expect(r.retrievalDocumentIds).toEqual(['doc-a', 'doc-b', 'doc-c']);
    expect(r.sessionId).toBe('s-99');
  });

  it('stores feedback cleanly when retrieval metadata is absent', () => {
    const r = store.record({
      messageId: 'm1', userQuery: 'q', assistantResponse: 'a', rating: 'up',
    });
    expect(r.retrievalIntent).toBeNull();
    expect(r.retrievalSource).toBeNull();
    expect(r.retrievalMatchCount).toBeNull();
    expect(r.retrievalDocumentIds).toBeNull();
  });

  it('list() round-trips JSON document_ids', () => {
    store.record({
      messageId: 'm1', userQuery: 'q', assistantResponse: 'a', rating: 'up',
      retrievalDocumentIds: ['doc-x', 'doc-y'],
    });
    const list = store.list();
    expect(list[0].retrievalDocumentIds).toEqual(['doc-x', 'doc-y']);
  });
});

describe('FeedbackStore.count', () => {
  it('returns the total row count', () => {
    expect(store.count()).toBe(0);
    store.record({ messageId: 'm1', userQuery: 'q', assistantResponse: 'a', rating: 'up' });
    store.record({ messageId: 'm2', userQuery: 'q', assistantResponse: 'a', rating: 'down' });
    expect(store.count()).toBe(2);
  });
});

describe('FeedbackStore.record — bad payload throws', () => {
  it('throws when rating is invalid (caught by API layer for 400 response)', () => {
    expect(() => store.record({
      messageId: 'm', userQuery: 'q', assistantResponse: 'a',
      rating: 'maybe' as never,
    })).toThrow();
  });
});
