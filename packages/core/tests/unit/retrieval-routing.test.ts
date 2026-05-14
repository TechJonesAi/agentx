/**
 * R1.5 — retrieval routing acceptance tests.
 *
 * Validate that count-intent queries are answered from SQL (not vector / not LLM)
 * and that exact-search queries asking for "all" do not silently truncate at topK.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { runCognitiveMemoryMigrations } from '../../src/db/migrations/index.js';
import { RetrievalService } from '../../src/retrieval/retrieval-service.js';
import { DocumentRegistry } from '../../src/memory/document-registry.js';
import { FtsIndexService } from '../../src/memory/fts-index-service.js';

let dbPath: string;
let db: Database.Database;
let svc: RetrievalService;
let registry: DocumentRegistry;
let fts: FtsIndexService;

// Hook timeout — the migrations call inside this beforeEach takes 5–8 s
// on Windows GitHub runners (FTS5 contentless + sync better-sqlite3 + slow
// disk IO); ~50 ms on Linux/macOS. Vitest default 10 000 ms hook budget
// fires on Windows. Bump only this hook.
beforeEach(() => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-routing-'));
  dbPath = path.join(tmp, 'cog.db');
  db = new Database(dbPath);
  runCognitiveMemoryMigrations(db);
  svc = new RetrievalService(db);
  registry = new DocumentRegistry(db);
  fts = new FtsIndexService(db);
}, 60_000);

afterEach(() => {
  try { db.close(); } catch { /* ignore */ }
  try { fs.rmSync(path.dirname(dbPath), { recursive: true, force: true }); } catch { /* ignore */ }
});

function seedDoc(overrides: Partial<{
  file_name: string;
  file_type: string;
  mime_type: string;
  content_type: string;
  origin_type: string;
  title: string;
  sender: string;
  classification_label: string;
}> = {}) {
  const m = registry.create({
    file_name: overrides.file_name ?? 'doc.pdf',
    file_type: overrides.file_type ?? 'pdf',
    mime_type: overrides.mime_type ?? 'application/pdf',
    content_type: overrides.content_type ?? 'document',
    origin_type: overrides.origin_type ?? 'born_digital',
    title: overrides.title ?? 'Untitled',
    sender: overrides.sender ?? null as unknown as string,
    page_count: 1,
    chunk_count: 1,
    ocr_required: false,
    ocr_completed: false,
    classification_label: overrides.classification_label ?? 'document',
    classification_confidence: 1.0,
    classification_method: 'manual',
    extraction_status: 'extracted',
    indexing_status: 'indexed',
    content_hash: `hash-${Math.random()}`,
  });
  return m;
}

describe('R1.5 — count routing answers from SQL, not vector', () => {
  it('"how many documents" returns total count from registry', async () => {
    seedDoc({ file_type: 'pdf' });
    seedDoc({ file_type: 'txt' });
    seedDoc({ file_type: 'pdf' });
    const r = await svc.retrieve('how many documents do we have?');
    expect(r.intent).toBe('COUNT');
    expect(r.results.length).toBe(1);
    expect(r.results[0].score_type).toBe('count');
    expect(r.results[0].score).toBe(3);
  });

  it('"how many PDFs" filters by file_type', async () => {
    seedDoc({ file_type: 'pdf' });
    seedDoc({ file_type: 'pdf' });
    seedDoc({ file_type: 'txt' });
    seedDoc({ file_type: 'docx' });
    const r = await svc.retrieve('how many pdfs are stored?');
    expect(r.results[0].score).toBe(2);
  });

  it('"how many emails" filters by classification_label', async () => {
    seedDoc({ file_type: 'pdf', classification_label: 'email' });
    seedDoc({ file_type: 'txt', classification_label: 'email' });
    seedDoc({ file_type: 'pdf', classification_label: 'document' });
    const r = await svc.retrieve('how many emails?');
    expect(r.results[0].score).toBe(2);
  });

  it('"how many txt files" filters by file_type=txt', async () => {
    seedDoc({ file_type: 'txt' });
    seedDoc({ file_type: 'pdf' });
    const r = await svc.retrieve('how many txt files do we have');
    expect(r.results[0].score).toBe(1);
  });

  it('"how many scanned documents" filters by origin_type=scanned', async () => {
    seedDoc({ origin_type: 'scanned' });
    seedDoc({ origin_type: 'born_digital' });
    seedDoc({ origin_type: 'scanned' });
    const r = await svc.retrieve('how many scanned documents');
    expect(r.results[0].score).toBe(2);
  });

  it('parseCountFilters disambiguates file-type from content-type', () => {
    expect(svc.parseCountFilters('how many pdfs?')).toEqual({ file_type: 'pdf' });
    expect(svc.parseCountFilters('how many emails?')).toEqual({ classification_label: 'email' });
    expect(svc.parseCountFilters('how many scanned docs')).toEqual({ origin_type: 'scanned' });
    expect(svc.parseCountFilters('how many documents')).toEqual({});
  });

  it('count results never carry an LLM-generated number — score is a JS number from SQL COUNT(*)', async () => {
    seedDoc();
    const r = await svc.retrieve('how many documents');
    expect(typeof r.results[0].score).toBe('number');
    expect(Number.isInteger(r.results[0].score)).toBe(true);
  });
});

// Windows CI runners on slower disks routinely take 12–18 s for the
// 25-doc seed loops below (sync better-sqlite3 + FTS5 contentless triggers
// hit the filesystem on every insert; macOS/Linux finishes in ~1–2 s).
// Bump the per-test budget so platform-IO speed isn't a fairness gate.
// Round-5 bump (CI run 25846558591): a slow windows-22 runner exceeded
// the 30s budget on the "show all references" seed loop. 60s matches
// the harness's SLOW budget and the round-5 migrations bump.
const SEED_HEAVY_TIMEOUT_MS = 60_000;

describe('R1.5 — exact search does not silently truncate when query asks for "all"', () => {
  it('"show all references to robert moyes" returns all matches, not topK=10', async () => {
    // Seed 25 documents that mention robert moyes — more than the default topK.
    for (let i = 0; i < 25; i++) {
      const doc = seedDoc({
        file_name: `letter-${i}.pdf`,
        title: 'Correspondence',
        sender: 'robert moyes',
        classification_label: 'letter',
      });
      fts.upsertDocumentFts(doc.document_id, {
        title: 'Correspondence',
        sender: 'robert moyes',
        recipient: '',
        subject: '',
        content: 'this letter from robert moyes discusses the matter',
        file_name: doc.file_name,
      });
    }
    const r = await svc.retrieve('show all references to robert moyes');
    expect(r.intent).toBe('EXACT_SEARCH');
    expect(r.results.length).toBeGreaterThanOrEqual(25);
  }, SEED_HEAVY_TIMEOUT_MS);

  it('exact search WITHOUT "all" still respects topK', async () => {
    for (let i = 0; i < 25; i++) {
      const doc = seedDoc({ file_name: `note-${i}.pdf` });
      fts.upsertDocumentFts(doc.document_id, {
        title: '', sender: '', recipient: '', subject: '',
        content: 'mentions robert moyes',
        file_name: doc.file_name,
      });
    }
    const r = await svc.retrieve('which documents mention robert moyes', { topK: 5 });
    expect(r.intent).toBe('EXACT_SEARCH');
    expect(r.results.length).toBeLessThanOrEqual(5);
  }, SEED_HEAVY_TIMEOUT_MS);

  it('"every mention of grievance" returns all matches', async () => {
    for (let i = 0; i < 15; i++) {
      const doc = seedDoc({ file_name: `report-${i}.pdf` });
      fts.upsertDocumentFts(doc.document_id, {
        title: '', sender: '', recipient: '', subject: '',
        content: `report number ${i} discusses the grievance procedure`,
        file_name: doc.file_name,
      });
    }
    const r = await svc.retrieve('list every mention of grievance');
    expect(r.results.length).toBeGreaterThanOrEqual(15);
  }, SEED_HEAVY_TIMEOUT_MS);
});

describe('R1.5 — strict retrieval rules', () => {
  it('count queries do not invoke FTS or vector retrieval (only SQL COUNT)', async () => {
    seedDoc();
    const r = await svc.retrieve('how many documents');
    // No matching documents should appear; the result is a single COUNT row.
    expect(r.results.length).toBe(1);
    expect(r.results[0].document_id).toBe('');
    expect(r.results[0].score_type).toBe('count');
  });

  it('exact-name queries route to EXACT_SEARCH not SEMANTIC', async () => {
    const intents = [
      'show all references to robert moyes',
      'which documents mention grievance',
      'find every mention of jane doe',
      '"exact phrase"',
    ];
    for (const q of intents) {
      const r = await svc.retrieve(q);
      expect(r.intent).toBe('EXACT_SEARCH');
    }
  });

  it('semantic queries route to SEMANTIC', async () => {
    const r = await svc.retrieve('what do these documents say about workplace culture');
    expect(r.intent).toBe('SEMANTIC');
  });
});
