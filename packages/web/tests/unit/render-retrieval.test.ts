/**
 * R7 — retrieval UI renderer tests.
 *
 * Verifies the pure renderer (renderRetrievalPanelHtml) produces the
 * required structure for each retrieval source/intent combination, and
 * that the embedded HTML in WebServer wires the renderer correctly.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderRetrievalPanelHtml, type RetrievalMetadataLike } from '../../src/client/render-retrieval.js';

// Read the embedded HTML by parsing server/index.ts directly. This avoids
// importing the server module (which transitively imports @agentx/core
// and trips a stale alias in vitest.config.ts).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'server', 'index.ts'),
  'utf-8',
);

describe('renderRetrievalPanelHtml — null/empty input', () => {
  it('returns "" when metadata is null', () => {
    expect(renderRetrievalPanelHtml(null)).toBe('');
  });

  it('returns "" when metadata is undefined', () => {
    expect(renderRetrievalPanelHtml(undefined)).toBe('');
  });
});

describe('renderRetrievalPanelHtml — COUNT intent', () => {
  it('renders the SQL count value prominently', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'COUNT',
      retrievalSource: 'sql',
      retrievalMatchCount: 7,
      retrievalCount: 7,
      retrievalDocuments: [],
    });
    expect(html).toContain('class="retrieval-panel"');
    expect(html).toContain('data-intent="COUNT"');
    expect(html).toContain('data-source="sql"');
    expect(html).toContain('SQL count');
    expect(html).toContain('<strong>7</strong>');
    expect(html).toContain('source-sql');
  });

  it('does not render document chips for COUNT', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'COUNT',
      retrievalSource: 'sql',
      retrievalMatchCount: 5,
      retrievalCount: 5,
      retrievalDocuments: [],
    });
    expect(html).not.toContain('source-chip');
  });
});

describe('renderRetrievalPanelHtml — EXACT_SEARCH with documents', () => {
  const meta: RetrievalMetadataLike = {
    retrievalIntent: 'EXACT_SEARCH',
    retrievalSource: 'entity',
    retrievalMatchCount: 2,
    retrievalDocuments: [
      { document_id: 'doc-1', file_name: 'letter-1.pdf', title: 'Indemnity Letter', file_type: 'pdf', sender: 'Robert Moyes' },
      { document_id: 'doc-2', file_name: 'memo-2.pdf', file_type: 'pdf' },
    ],
  };

  it('renders intent + source badges', () => {
    const html = renderRetrievalPanelHtml(meta);
    expect(html).toContain('class="retrieval-badge intent">EXACT_SEARCH<');
    expect(html).toContain('source-entity');
  });

  it('renders one source-chip per document', () => {
    const html = renderRetrievalPanelHtml(meta);
    const chips = (html.match(/source-chip/g) || []).length;
    expect(chips).toBe(2);
    expect(html).toContain('letter-1.pdf');
    expect(html).toContain('memo-2.pdf');
    expect(html).toContain('Indemnity Letter');
  });

  it('renders the match count phrase', () => {
    const html = renderRetrievalPanelHtml(meta);
    expect(html).toContain('2 matches');
  });

  it('uses singular "match" for count=1', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [{ document_id: 'd', file_name: 'a.pdf' }],
    });
    expect(html).toContain('1 match<');
    expect(html).not.toContain('1 matches');
  });

  it('source label "fts" produces source-fts class', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [{ document_id: 'd', file_name: 'a.pdf' }],
    });
    expect(html).toContain('source-fts');
  });

  it('source label "mixed" produces source-mixed class', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'mixed',
      retrievalMatchCount: 3,
      retrievalDocuments: [
        { document_id: 'a', file_name: 'a.pdf' },
        { document_id: 'b', file_name: 'b.pdf' },
        { document_id: 'c', file_name: 'c.pdf' },
      ],
    });
    expect(html).toContain('source-mixed');
    expect(html).toContain('3 matches');
  });
});

describe('renderRetrievalPanelHtml — escaping', () => {
  it('escapes HTML in file_name and title', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [
        { document_id: 'd', file_name: '<script>x</script>.pdf', title: 'Title&Co' },
      ],
    });
    expect(html).not.toContain('<script>x</script>.pdf');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;.pdf');
    expect(html).toContain('Title&amp;Co');
  });

  it('escapes injection attempts in source label', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: '"><img src=x>' as never,
      retrievalMatchCount: 0,
      retrievalDocuments: [],
    });
    expect(html).not.toContain('<img src=x>');
    expect(html).toContain('&quot;&gt;&lt;img src=x&gt;');
  });
});

describe('renderRetrievalPanelHtml — limits document chips', () => {
  it('caps chip rendering at 50 documents', () => {
    const docs = Array.from({ length: 100 }, (_, i) => ({
      document_id: `doc-${i}`, file_name: `file-${i}.pdf`,
    }));
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'fts',
      retrievalMatchCount: 100,
      retrievalDocuments: docs,
    });
    const chipCount = (html.match(/source-chip/g) || []).length;
    expect(chipCount).toBe(50);
    // The match count badge still reports the full 100 — chip limit is a UI cap
    expect(html).toContain('100 matches');
  });
});

describe('embedded HTML wiring (parsed from server/index.ts source)', () => {
  it('contains retrieval-panel CSS class', () => {
    expect(SERVER_TS).toContain('.retrieval-panel');
  });

  it('contains source-chip CSS class', () => {
    expect(SERVER_TS).toContain('.source-chip');
  });

  it('contains a per-source CSS class for each source label', () => {
    expect(SERVER_TS).toContain('source-sql');
    expect(SERVER_TS).toContain('source-entity');
    expect(SERVER_TS).toContain('source-fts');
    expect(SERVER_TS).toContain('source-vector');
    expect(SERVER_TS).toContain('source-mixed');
  });

  it('defines a renderRetrievalPanel function in inline JS', () => {
    expect(SERVER_TS).toContain('function renderRetrievalPanel');
  });

  it('handles event.type === "retrieval" in the SSE parser', () => {
    expect(SERVER_TS).toContain("event.type === 'retrieval'");
  });

  it('inserts the panel BEFORE the assistant message in the DOM', () => {
    // The handler uses insertBefore(panel, msgDiv) — confirming render-before-tokens ordering
    expect(SERVER_TS).toContain('insertBefore(panel, msgDiv)');
  });

  it('reads metadata from the SSE retrieval event payload', () => {
    expect(SERVER_TS).toContain('renderRetrievalPanel(event.retrieval)');
  });

  it('SSE retrieval branch is BEFORE the token branch (panel renders first)', () => {
    const retrievalIdx = SERVER_TS.indexOf("event.type === 'retrieval'");
    const tokenIdx = SERVER_TS.indexOf("event.type === 'token'");
    expect(retrievalIdx).toBeGreaterThan(0);
    expect(tokenIdx).toBeGreaterThan(retrievalIdx); // retrieval comes first
  });
});

describe('R7 — flag-off invariant', () => {
  it('renderer returns empty string for null metadata (renders nothing)', () => {
    expect(renderRetrievalPanelHtml(null)).toBe('');
    expect(renderRetrievalPanelHtml(undefined)).toBe('');
  });
});

describe('R9 — snippet rendering with safe highlighting', () => {
  it('renders a chip-snippet containing the snippet text', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'entity',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'd1',
        file_name: 'memo.pdf',
        snippet: '…earlier in the day, Robert Moyes signed the indemnity agreement…',
        matchedPhrase: 'Robert Moyes',
      }],
    });
    expect(html).toContain('class="chip-snippet"');
    expect(html).toContain('Robert Moyes');
  });

  it('wraps the matched phrase in <mark class="match">', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'd1', file_name: 'a.pdf',
        snippet: 'context Robert Moyes context',
        matchedPhrase: 'Robert Moyes',
      }],
    });
    expect(html).toContain('<mark class="match">Robert Moyes</mark>');
  });

  it('escapes HTML inside the snippet (XSS guard)', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'd1', file_name: 'evil.pdf',
        snippet: '<script>alert(1)</script> <img onerror=x>',
      }],
    });
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).not.toContain('<img onerror=x>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('escapes HTML inside matchedPhrase before wrapping', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'd1', file_name: 'a.pdf',
        snippet: 'before <evil> after',
        matchedPhrase: '<evil>',
      }],
    });
    expect(html).not.toContain('<mark class="match"><evil></mark>');
    expect(html).toContain('<mark class="match">&lt;evil&gt;</mark>');
  });

  it('omits chip-snippet when document has no snippet field', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'fts',
      retrievalMatchCount: 1,
      retrievalDocuments: [{ document_id: 'd1', file_name: 'a.pdf' }],
    });
    expect(html).not.toContain('chip-snippet');
  });

  it('snippet without matchedPhrase still renders (escaped, no <mark>)', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'SEMANTIC',
      retrievalSource: 'vector',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'd1', file_name: 'a.pdf',
        snippet: 'a generic semantic excerpt',
      }],
    });
    expect(html).toContain('class="chip-snippet"');
    expect(html).toContain('a generic semantic excerpt');
    expect(html).not.toContain('<mark');
  });

  it('multiple occurrences of matchedPhrase all wrapped', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'mixed',
      retrievalMatchCount: 1,
      retrievalDocuments: [{
        document_id: 'd1', file_name: 'a.pdf',
        snippet: 'Robert Moyes spoke. Robert Moyes signed. Robert Moyes left.',
        matchedPhrase: 'Robert Moyes',
      }],
    });
    expect((html.match(/<mark class="match">Robert Moyes<\/mark>/g) ?? []).length).toBe(3);
  });

  it('embedded HTML mirrors snippet rendering with mark wrapper', () => {
    expect(SERVER_TS).toContain('chip-snippet');
    expect(SERVER_TS).toContain('mark class="match"');
    expect(SERVER_TS).toContain('split(escMatch).join');
  });

  it('embedded HTML mirrors split-join (no regex) replacement', () => {
    // Confirm we do NOT use regex on attacker-controlled phrase data
    expect(SERVER_TS).not.toMatch(/new RegExp\(.*matchedPhrase/);
  });

  it('COUNT intent never renders chip-snippet (no documents to attach to)', () => {
    const html = renderRetrievalPanelHtml({
      retrievalIntent: 'COUNT',
      retrievalSource: 'sql',
      retrievalMatchCount: 7,
      retrievalCount: 7,
      retrievalDocuments: [],
    });
    expect(html).not.toContain('chip-snippet');
    expect(html).not.toContain('<mark');
  });
});
