import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';

let dbPath: string;
let db: Database.Database;

beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-migrations-'));
  dbPath = path.join(tmp, 'cog.db');
  db = new Database(dbPath);
});

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

function tableExists(database: Database.Database, name: string): boolean {
  const row = database.prepare(`SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name = ?`).get(name);
  return !!row;
}

function columnNames(database: Database.Database, tableName: string): string[] {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.map(r => r.name);
}

// Each `it` here invokes runCognitiveMemoryMigrations() once on a fresh
// SQLite, which applies 6 migrations including 007_fts_contentless's FTS5
// virtual table + INSERT/DELETE triggers. On Windows GitHub-hosted runners
// the sync better-sqlite3 + filesystem IO routinely takes 5–8 s for a single
// run; Linux/macOS finishes in ~50–100 ms. Per-test budget bumped to 30 s
// so platform IO speed isn't a fairness gate.
// Round-5 bump (CI run 25846558591): a slow windows-22 runner (6m46s
// total job time) exceeded the 30s per-`it` budget for the very first
// migrations test. 60s matches the harness's SLOW budget and gives
// headroom for the most-loaded Windows runner seen so far. Same class
// of fix as document-ingestion-entities (e74e671).
const SLOW_IO_TIMEOUT_MS = 60_000;

describe('cognitive memory migrations', () => {
  it('applies all migrations cleanly on a fresh database', () => {
    const result = runCognitiveMemoryMigrations(db);
    // Batch 6A added 008_workflow_runs; Batch 9 added 009_provider_benchmarks
    // — total is now 8.
    expect(result.count).toBe(8);
    expect(result.ftsAvailable).toBe(true);
  }, SLOW_IO_TIMEOUT_MS);

  it('is idempotent — re-running applies zero new migrations', () => {
    runCognitiveMemoryMigrations(db);
    const second = runCognitiveMemoryMigrations(db);
    expect(second.count).toBe(0);
  }, SLOW_IO_TIMEOUT_MS);

  it('records every migration in the schema_migrations_cognitive table', () => {
    runCognitiveMemoryMigrations(db);
    const rows = db.prepare(`SELECT migration_id FROM schema_migrations_cognitive ORDER BY migration_id`).all() as Array<{ migration_id: string }>;
    expect(rows.map(r => r.migration_id)).toEqual([
      '001_cognitive_memory',
      '002_learning_signals',
      '003_entity_aliases',
      '005_lifelong_memory',
      '006_document_identity',
      '007_fts_contentless',
      '008_workflow_runs',
      '009_provider_benchmarks',
    ]);
  }, SLOW_IO_TIMEOUT_MS);

  it('migration 002 — creates learning_signals table', () => {
    runCognitiveMemoryMigrations(db);
    expect(tableExists(db, 'learning_signals')).toBe(true);
    const cols = columnNames(db, 'learning_signals');
    expect(cols).toContain('signal_id');
    expect(cols).toContain('signal_type');
  }, SLOW_IO_TIMEOUT_MS);

  it('migration 003 — creates entity_aliases table', () => {
    runCognitiveMemoryMigrations(db);
    expect(tableExists(db, 'entity_aliases')).toBe(true);
    const cols = columnNames(db, 'entity_aliases');
    expect(cols).toContain('alias_id');
    expect(cols).toContain('canonical_entity_id');
    expect(cols).toContain('alias_name');
  }, SLOW_IO_TIMEOUT_MS);

  it('migration 005 — creates episodes and episode_events tables', () => {
    runCognitiveMemoryMigrations(db);
    expect(tableExists(db, 'episodes')).toBe(true);
    expect(tableExists(db, 'episode_events')).toBe(true);
    const epCols = columnNames(db, 'episodes');
    expect(epCols).toEqual(expect.arrayContaining(['id', 'session_id', 'status', 'started_at']));
    const evCols = columnNames(db, 'episode_events');
    expect(evCols).toEqual(expect.arrayContaining(['id', 'episode_id', 'event_type', 'content']));
  }, SLOW_IO_TIMEOUT_MS);

  it('migration 006 — adds source_type and parent_document_id to documents', () => {
    runCognitiveMemoryMigrations(db);
    const cols = columnNames(db, 'documents');
    expect(cols).toContain('source_type');
    expect(cols).toContain('parent_document_id');
  }, SLOW_IO_TIMEOUT_MS);

  it('partial application — pre-existing migration_id rows are skipped', () => {
    db.exec(`CREATE TABLE schema_migrations_cognitive (migration_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)`);
    db.prepare(`INSERT INTO schema_migrations_cognitive (migration_id, applied_at) VALUES (?, ?)`).run('001_cognitive_memory', Date.now());
    // Apply 001 directly so the rest of the chain has its tables.
    db.exec(fs.readFileSync(path.join(__dirname, '../../src/db/migrations/001_cognitive_memory.sql'), 'utf-8'));
    const result = runCognitiveMemoryMigrations(db);
    expect(result.count).toBe(7); // 002, 003, 005, 006, 007, 008, 009 applied, 001 skipped
  }, SLOW_IO_TIMEOUT_MS);
});
