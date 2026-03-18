import Database from 'better-sqlite3';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { createLogger } from '../logger.js';
import { runCognitiveMemoryMigrations } from './migrations/index.js';

const log = createLogger('memory:sqlite');

export interface TransactionOptions {
  readonly isolationLevel?: 'DEFERRED' | 'IMMEDIATE' | 'EXCLUSIVE';
}

export class SqliteMemoryDb {
  private db: Database.Database;
  private dataDir: string;

  constructor(dataDir: string) {
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    this.dataDir = dataDir;
    const dbPath = path.join(dataDir, 'cognitive-memory.db');
    log.info({ dbPath }, 'Initializing cognitive memory database');

    this.db = new Database(dbPath);
    this.configurePragmas();
    this.runMigrations();
  }

  private configurePragmas(): void {
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('cache_size = -64000');
    this.db.pragma('temp_store = MEMORY');
    this.db.pragma('mmap_size = 30000000000');
    this.db.pragma('page_size = 4096');
    this.db.pragma('busy_timeout = 5000');
  }

  private runMigrations(): void {
    const migrationResult = runCognitiveMemoryMigrations(this.db);
    log.info({ migrationCount: migrationResult.count, ftsAvailable: migrationResult.ftsAvailable },
      'Cognitive memory migrations completed');
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  transaction<T>(fn: (db: Database.Database) => T, options?: TransactionOptions): T {
    const isolation = options?.isolationLevel || 'DEFERRED';
    const transaction = this.db.transaction(fn);
    return transaction(this.db);
  }

  prepare<T extends Database.RunResult | Database.ParamsObject[]>(
    sql: string,
  ): Database.Statement<T> {
    return this.db.prepare(sql) as Database.Statement<T>;
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
    log.info('Cognitive memory database closed');
  }

  getDataDir(): string {
    return this.dataDir;
  }

  backup(backupPath: string): void {
    this.db.backup(backupPath).then(() => {
      log.info({ backupPath }, 'Database backup completed');
    }).catch((err) => {
      log.error({ backupPath, error: err }, 'Database backup failed');
      throw err;
    });
  }
}

export function createSqliteMemoryDb(dataDir: string): SqliteMemoryDb {
  return new SqliteMemoryDb(dataDir);
}
