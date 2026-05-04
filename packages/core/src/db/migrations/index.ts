import type Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createLogger } from '../../logger.js';

const log = createLogger('memory:migrations');

interface MigrationResult {
  count: number;
  ftsAvailable: boolean;
}

export function runCognitiveMemoryMigrations(db: Database.Database): MigrationResult {
  const migrations = [
    { id: '001_cognitive_memory',  sql: fs.readFileSync(path.join(import.meta.dirname, '001_cognitive_memory.sql'),  'utf-8') },
    { id: '002_learning_signals',  sql: fs.readFileSync(path.join(import.meta.dirname, '002_learning_signals.sql'),  'utf-8') },
    { id: '003_entity_aliases',    sql: fs.readFileSync(path.join(import.meta.dirname, '003_entity_aliases.sql'),    'utf-8') },
    { id: '005_lifelong_memory',   sql: fs.readFileSync(path.join(import.meta.dirname, '005_lifelong_memory.sql'),   'utf-8') },
    { id: '006_document_identity', sql: fs.readFileSync(path.join(import.meta.dirname, '006_document_identity.sql'), 'utf-8') },
  ];

  const schemaTable = 'schema_migrations_cognitive';

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${schemaTable} (
      migration_id TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `);

  let ftsAvailable = false;
  let appliedCount = 0;

  for (const migration of migrations) {
    const existing = db.prepare(`SELECT migration_id FROM ${schemaTable} WHERE migration_id = ?`).get(migration.id);

    if (!existing) {
      try {
        db.exec(migration.sql);
        db.prepare(`INSERT INTO ${schemaTable} (migration_id, applied_at) VALUES (?, ?)`).run(
          migration.id,
          Date.now(),
        );
        appliedCount++;
        log.info({ migrationId: migration.id }, 'Migration applied');

        if (migration.id === '001_cognitive_memory') {
          ftsAvailable = true;
        }
      } catch (error) {
        log.error({ migrationId: migration.id, error }, 'Migration failed');
        throw error;
      }
    }
  }

  return { count: appliedCount, ftsAvailable };
}
