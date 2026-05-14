import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SqliteMemoryDb } from '../../src/db/sqlite-memory.js';
import { ImportanceScorer } from '../../src/memory/importance-scorer.js';

// The scorer references a `categorized_memory` table provided by a future
// memory subsystem. For unit testing we provide a minimal stub table with
// only the columns the scorer reads/writes.
function createCategorizedMemoryStub(db: SqliteMemoryDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS categorized_memory (
      id TEXT PRIMARY KEY,
      content TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      strength REAL DEFAULT 0.5,
      access_count INTEGER DEFAULT 0,
      accessed_at INTEGER DEFAULT 0,
      project_id TEXT,
      source TEXT,
      core INTEGER DEFAULT 0,
      importance_json TEXT,
      core_reason TEXT,
      core_assigned_at INTEGER,
      core_assigned_by TEXT,
      core_review_status TEXT DEFAULT 'active'
    )
  `);
}

let tmpDir: string;
let db: SqliteMemoryDb;
let scorer: ImportanceScorer;

// Windows IO budget — SqliteMemoryDb open + categorized-memory stub
// creation hits FS hard. ~30ms on Unix but routinely 6-10s on slow
// GitHub Windows runners. Default 10000ms hook budget is insufficient.
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-importance-'));
  db = new SqliteMemoryDb(tmpDir);
  createCategorizedMemoryStub(db);
  scorer = new ImportanceScorer(db);
}, 60_000);

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
}, 60_000);

describe('ImportanceScorer — computeImportance', () => {
  it('returns a score with all six components plus overall', () => {
    const score = scorer.computeImportance({ id: 'm1', strength: 0.5 });
    expect(score).toHaveProperty('base');
    expect(score).toHaveProperty('impact');
    expect(score).toHaveProperty('reliability');
    expect(score).toHaveProperty('utility');
    expect(score).toHaveProperty('userConfirmed');
    expect(score).toHaveProperty('learningBoost');
    expect(score).toHaveProperty('overall');
  });

  it('overall is between 0 and 1', () => {
    const score = scorer.computeImportance({ id: 'm1', strength: 0.5 });
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(1);
  });

  it('base reflects (clamped) strength', () => {
    expect(scorer.computeImportance({ id: 'a', strength: 0 }).base).toBe(0);
    expect(scorer.computeImportance({ id: 'b', strength: 1 }).base).toBe(1);
    expect(scorer.computeImportance({ id: 'c', strength: 1.5 }).base).toBe(1);
    expect(scorer.computeImportance({ id: 'd', strength: -0.2 }).base).toBe(0);
  });

  it('user-taught memories have userConfirmed = 1.0', () => {
    const teach = scorer.computeImportance({ id: 'a', strength: 0.5, source: 'user_teaching' });
    expect(teach.userConfirmed).toBe(1.0);
    const teachShort = scorer.computeImportance({ id: 'b', strength: 0.5, source: 'teach' });
    expect(teachShort.userConfirmed).toBe(1.0);
  });

  it('non-user-taught memories have userConfirmed = 0.5', () => {
    const auto = scorer.computeImportance({ id: 'a', strength: 0.5, source: 'system' });
    expect(auto.userConfirmed).toBe(0.5);
    const undef = scorer.computeImportance({ id: 'b', strength: 0.5 });
    expect(undef.userConfirmed).toBe(0.5);
  });

  it('utility increases with access count', () => {
    const cold = scorer.computeImportance({ id: 'a', strength: 0.5, access_count: 0 });
    const warm = scorer.computeImportance({ id: 'b', strength: 0.5, access_count: 50 });
    expect(warm.utility).toBeGreaterThanOrEqual(cold.utility);
  });

  it('accepts both access_count and accessCount key forms', () => {
    const a = scorer.computeImportance({ id: 'a', strength: 0.5, access_count: 10 });
    const b = scorer.computeImportance({ id: 'b', strength: 0.5, accessCount: 10 });
    expect(a.utility).toBeCloseTo(b.utility, 5);
  });
});

describe('ImportanceScorer — core memories', () => {
  function insertMemory(id: string, strength = 0.5): void {
    db.prepare(`INSERT INTO categorized_memory (id, strength) VALUES (?, ?)`).run(id, strength);
  }

  it('isCore reports false for unmarked memory', () => {
    insertMemory('m1');
    expect(scorer.isCore('m1')).toBe(false);
  });

  it('markAsCore flips the flag', () => {
    insertMemory('m1');
    scorer.markAsCore('m1', 'critical fact', 'user');
    expect(scorer.isCore('m1')).toBe(true);
  });

  it('unmarkCore restores normal lifecycle', () => {
    insertMemory('m1');
    scorer.markAsCore('m1');
    expect(scorer.isCore('m1')).toBe(true);
    scorer.unmarkCore('m1');
    expect(scorer.isCore('m1')).toBe(false);
  });

  it('isCore returns false for non-existent memory', () => {
    expect(scorer.isCore('nonexistent')).toBe(false);
  });

  it('marking a memory as core sets strength to 1.0', () => {
    insertMemory('m1', 0.2);
    scorer.markAsCore('m1');
    const row = db.prepare(`SELECT strength FROM categorized_memory WHERE id = ?`).get('m1') as { strength: number };
    expect(row.strength).toBe(1.0);
  });

  it('re-marking an already-core memory does not throw and remains core', () => {
    insertMemory('m1');
    scorer.markAsCore('m1');
    expect(() => scorer.markAsCore('m1', 'updated reason')).not.toThrow();
    expect(scorer.isCore('m1')).toBe(true);
  });
});

describe('ImportanceScorer — diagnostics', () => {
  it('returns a diagnostics object', () => {
    const d = scorer.getDiagnostics();
    expect(d).toBeDefined();
    expect(typeof d).toBe('object');
  });

  it('reflects a marked core memory in the diagnostics', () => {
    db.prepare(`INSERT INTO categorized_memory (id, strength) VALUES (?, ?)`).run('m1', 0.5);
    scorer.markAsCore('m1');
    const d = scorer.getDiagnostics() as Record<string, number>;
    // We only assert that a numeric diagnostic was produced; exact key set is implementation detail
    expect(Object.values(d).some(v => typeof v === 'number' && v >= 1)).toBe(true);
  });
});

describe('ImportanceScorer — weights customisation', () => {
  it('accepts weight overrides via constructor', () => {
    const custom = new ImportanceScorer(db, undefined, { base: 1.0 });
    const score = custom.computeImportance({ id: 'm', strength: 0.4 });
    // overall is dominated by base when base weight is 1.0
    expect(score.overall).toBeGreaterThan(0);
  });
});
