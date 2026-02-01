import type Database from 'better-sqlite3';
import { v4 as uuid } from 'uuid';
import type { LongTermMemory } from '../types.js';
import { createLogger } from '../logger.js';

const log = createLogger('memory:longterm');

export class LongTermMemoryStore {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  store(content: string, tags: string[] = [], embedding?: number[]): string {
    const id = uuid();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO long_term_memory (id, content, embedding, tags, created_at, accessed_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      content,
      embedding ? Buffer.from(new Float64Array(embedding).buffer) : null,
      JSON.stringify(tags),
      now,
      now,
    );

    log.debug({ id, tags }, 'Stored long-term memory');
    return id;
  }

  retrieve(id: string): LongTermMemory | undefined {
    const stmt = this.db.prepare('SELECT * FROM long_term_memory WHERE id = ?');
    const row = stmt.get(id) as {
      id: string;
      content: string;
      embedding: Buffer | null;
      tags: string;
      created_at: number;
      accessed_at: number;
    } | undefined;

    if (!row) return undefined;

    // Update access time
    this.db.prepare('UPDATE long_term_memory SET accessed_at = ? WHERE id = ?').run(Date.now(), id);

    return {
      id: row.id,
      content: row.content,
      embedding: row.embedding
        ? Array.from(new Float64Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 8))
        : undefined,
      tags: JSON.parse(row.tags),
      createdAt: row.created_at,
      accessedAt: row.accessed_at,
    };
  }

  searchByTags(tags: string[], limit = 10): LongTermMemory[] {
    // SQLite doesn't have native array search, so we filter in JS
    const stmt = this.db.prepare(`
      SELECT * FROM long_term_memory
      ORDER BY accessed_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(limit * 5) as Array<{
      id: string;
      content: string;
      embedding: Buffer | null;
      tags: string;
      created_at: number;
      accessed_at: number;
    }>;

    return rows
      .filter((row) => {
        const rowTags = JSON.parse(row.tags) as string[];
        return tags.some((t) => rowTags.includes(t));
      })
      .slice(0, limit)
      .map((row) => ({
        id: row.id,
        content: row.content,
        tags: JSON.parse(row.tags),
        createdAt: row.created_at,
        accessedAt: row.accessed_at,
      }));
  }

  searchByContent(query: string, limit = 10): LongTermMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM long_term_memory
      WHERE content LIKE ?
      ORDER BY accessed_at DESC
      LIMIT ?
    `);

    const rows = stmt.all(`%${query}%`, limit) as Array<{
      id: string;
      content: string;
      embedding: Buffer | null;
      tags: string;
      created_at: number;
      accessed_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      tags: JSON.parse(row.tags),
      createdAt: row.created_at,
      accessedAt: row.accessed_at,
    }));
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM long_term_memory WHERE id = ?').run(id);
  }

  listAll(limit = 50): LongTermMemory[] {
    const stmt = this.db.prepare(`
      SELECT * FROM long_term_memory ORDER BY accessed_at DESC LIMIT ?
    `);

    const rows = stmt.all(limit) as Array<{
      id: string;
      content: string;
      embedding: Buffer | null;
      tags: string;
      created_at: number;
      accessed_at: number;
    }>;

    return rows.map((row) => ({
      id: row.id,
      content: row.content,
      tags: JSON.parse(row.tags),
      createdAt: row.created_at,
      accessedAt: row.accessed_at,
    }));
  }
}
