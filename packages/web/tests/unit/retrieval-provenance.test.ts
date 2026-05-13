/**
 * Tests for the retrieval provenance enrichment helper.
 *
 * Verifies the contract:
 *   - Result with a chunk match → pageNumber + provenanceLabel added.
 *   - Result without a chunk match → unchanged (no fake page).
 *   - Missing tables / null db → unchanged.
 *   - LIKE escape protects against pathological snippet content.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  enrichRetrievalMetadata,
  recordEnrichmentStats,
  getEnrichmentStats,
  _resetEnrichmentStatsForTests,
} from '../../src/server/routes/retrieval-provenance.js';
import { renderRetrievalPanelHtml } from '../../src/client/render-retrieval.js';

interface DbHandle {
  prepare(sql: string): {
    get(...p: unknown[]): unknown;
    all(...p: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  close(): void;
}

function makeDb(filePath: string): DbHandle {
  const db = new Database(filePath) as unknown as DbHandle;
  db.exec(`
    CREATE TABLE documents (
      document_id TEXT PRIMARY KEY,
      file_name TEXT NOT NULL,
      mime_type TEXT,
      created_at INTEGER
    );
    CREATE TABLE document_pages (
      page_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      content TEXT NOT NULL,
      ocr_confidence REAL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE document_chunks (
      chunk_id TEXT PRIMARY KEY,
      document_id TEXT NOT NULL,
      page_id TEXT,
      chunk_number INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    INSERT INTO documents VALUES ('doc-A', 'tribunal.pdf', 'application/pdf', 0);
    INSERT INTO document_pages VALUES ('p-A-12', 'doc-A', 12, 'Page 12 body here.', 0.91, 0);
    INSERT INTO document_pages VALUES ('p-A-13', 'doc-A', 13, 'Page 13 body here.', 0.88, 0);
    INSERT INTO document_chunks VALUES ('c-1', 'doc-A', 'p-A-12', 0,
      'Some prefix and the exact unique anchor phrase XENOPHILIA-7821 followed by trailing text.', 0);
    INSERT INTO document_chunks VALUES ('c-2', 'doc-A', NULL, 1,
      'Orphan chunk with no page link mentioning UNLINKED-PHRASE-7822.', 0);
  `);
  return db;
}

describe('enrichRetrievalMetadata', () => {
  let tmp: string;
  let dbPath: string;
  let db: DbHandle;

  beforeEach(() => {
    _resetEnrichmentStatsForTests();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-prov-'));
    dbPath = path.join(tmp, 'agentx.db');
    db = makeDb(dbPath);
  });
  afterEach(() => {
    try { db.close(); } catch { /* */ }
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('adds pageNumber + provenanceLabel when chunk content matches snippet', () => {
    const result = enrichRetrievalMetadata(db, {
      retrievalIntent: 'LOOKUP',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [
        { document_id: 'doc-A', file_name: 'tribunal.pdf',
          snippet: '...the exact unique anchor phrase XENOPHILIA-7821 followed by trailing...' },
      ],
    });
    expect(result.enrichedCount).toBe(1);
    expect(result.missingPageCount).toBe(0);
    expect(result.metadata.retrievalDocuments[0]?.pageNumber).toBe(12);
    expect(result.metadata.retrievalDocuments[0]?.pageId).toBe('p-A-12');
    expect(result.metadata.retrievalDocuments[0]?.provenanceLabel).toBe('p. 12');
  });

  it('leaves result unchanged when no chunk matches (no fake page)', () => {
    const result = enrichRetrievalMetadata(db, {
      retrievalIntent: 'LOOKUP',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [
        { document_id: 'doc-A', file_name: 'tribunal.pdf', snippet: 'NEVER-APPEARS-IN-ANY-CHUNK-ZZZZZ' },
      ],
    });
    expect(result.enrichedCount).toBe(0);
    expect(result.missingPageCount).toBe(1);
    expect(result.metadata.retrievalDocuments[0]?.pageNumber).toBeUndefined();
    expect(result.metadata.retrievalDocuments[0]?.provenanceLabel).toBeUndefined();
  });

  it('leaves result unchanged when matching chunk has NULL page_id', () => {
    const result = enrichRetrievalMetadata(db, {
      retrievalIntent: 'LOOKUP',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [
        { document_id: 'doc-A', file_name: 'tribunal.pdf', snippet: 'Orphan chunk with no page link mentioning UNLINKED-PHRASE-7822' },
      ],
    });
    expect(result.enrichedCount).toBe(0);
    expect(result.metadata.retrievalDocuments[0]?.pageNumber).toBeUndefined();
  });

  it('handles missing db gracefully', () => {
    const result = enrichRetrievalMetadata(null, {
      retrievalIntent: 'LOOKUP', retrievalSource: 'fts', retrievalMatchCount: 1,
      retrievalDocuments: [{ document_id: 'doc-A', file_name: 'x', snippet: 'whatever something' }],
    });
    expect(result.enrichedCount).toBe(0);
    expect(result.metadata.retrievalDocuments[0]?.pageNumber).toBeUndefined();
  });

  it('escapes LIKE wildcards in snippet so % and _ are literal', () => {
    // Insert a chunk whose content contains literal % and _ characters.
    (db.prepare("INSERT INTO document_chunks VALUES (?, ?, ?, ?, ?, 0)") as unknown as {
      run(...p: unknown[]): unknown;
    }).run('c-3', 'doc-A', 'p-A-13', 2, 'literal % wildcards _ here UNIQUE-PCT-99');
    const result = enrichRetrievalMetadata(db, {
      retrievalIntent: 'LOOKUP', retrievalSource: 'fts', retrievalMatchCount: 1,
      retrievalDocuments: [
        { document_id: 'doc-A', file_name: 'tribunal.pdf', snippet: 'literal % wildcards _ here UNIQUE-PCT-99' },
      ],
    });
    expect(result.enrichedCount).toBe(1);
    expect(result.metadata.retrievalDocuments[0]?.pageNumber).toBe(13);
  });

  it('records stats so /api/retrieval/diagnostics can surface them', () => {
    const r1 = enrichRetrievalMetadata(db, {
      retrievalIntent: 'LOOKUP', retrievalSource: 'fts', retrievalMatchCount: 2,
      retrievalDocuments: [
        { document_id: 'doc-A', file_name: 'tribunal.pdf', snippet: 'XENOPHILIA-7821' },
        { document_id: 'doc-A', file_name: 'tribunal.pdf', snippet: 'NEVER-APPEARS' },
      ],
    });
    recordEnrichmentStats(r1);
    const stats = getEnrichmentStats();
    expect(stats.lastEnrichedCount).toBe(1);
    expect(stats.lastMissingPageCount).toBe(1);
    expect(stats.totalEnrichedCount).toBe(1);
  });
});

describe('renderRetrievalPanelHtml — page badge', () => {
  it('renders chip-page when pageNumber is present', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'LOOKUP', retrievalSource: 'fts', retrievalMatchCount: 1,
      retrievalDocuments: [
        { document_id: 'd1', file_name: 'a.pdf', snippet: 'hi', pageNumber: 12, provenanceLabel: 'p. 12' },
      ],
    });
    expect(html).toContain('class="chip-page"');
    expect(html).toContain('p. 12');
    expect(html).toContain('data-page="12"');
  });

  it('omits chip-page when pageNumber is absent', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'LOOKUP', retrievalSource: 'fts', retrievalMatchCount: 1,
      retrievalDocuments: [
        { document_id: 'd1', file_name: 'a.pdf', snippet: 'hi' },
      ],
    });
    expect(html).not.toContain('chip-page');
  });

  it('escapes provenanceLabel so injected markup is inert', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'LOOKUP', retrievalSource: 'fts', retrievalMatchCount: 1,
      retrievalDocuments: [
        { document_id: 'd1', file_name: 'a.pdf', pageNumber: 5, provenanceLabel: '<script>x</script>' },
      ],
    });
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});
