/**
 * R7 — pure renderer for retrieval metadata.
 *
 * Returns an HTML fragment to be appended to the chat message container.
 * Used server-side for unit testing; the embedded HTML in `server/index.ts`
 * mirrors the same logic in inline browser JS.
 *
 * Returns the empty string when `metadata` is null/undefined or has no
 * retrievable signal — the caller should NOT render anything in that case.
 */

export interface RetrievalMetadataDocumentLike {
  document_id: string;
  file_name: string;
  title?: string;
  file_type?: string;
  sender?: string;
  snippet?: string;
  matchedPhrase?: string;
}

export interface RetrievalMetadataLike {
  retrievalIntent: string;
  retrievalSource: string;
  retrievalMatchCount: number;
  retrievalDocuments: RetrievalMetadataDocumentLike[];
  retrievalCount?: number;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * R9: escape `snippet` and wrap (escaped) `matchedPhrase` occurrences in
 * <mark>. Only the matched phrase is wrapped — everything else is plain
 * text after escape, so XSS through snippet content is impossible.
 */
function renderSnippetSafe(snippet: string, matchedPhrase?: string): string {
  const escaped = escapeHtml(snippet);
  if (!matchedPhrase) return escaped;
  const escapedMatch = escapeHtml(matchedPhrase);
  if (!escapedMatch || !escaped.includes(escapedMatch)) return escaped;
  // Replace ALL occurrences of the escaped match with the marked form.
  // Use a literal split-join so no regex meta-characters are interpreted.
  return escaped.split(escapedMatch).join(`<mark class="match">${escapedMatch}</mark>`);
}

/**
 * Render a retrieval-metadata panel as an HTML fragment.
 * Returns '' when nothing to render (null input or empty metadata).
 */
export function renderRetrievalPanelHtml(metadata: RetrievalMetadataLike | null | undefined): string {
  if (!metadata) return '';
  const intent = escapeHtml(String(metadata.retrievalIntent ?? ''));
  const source = escapeHtml(String(metadata.retrievalSource ?? ''));
  const count = Number(metadata.retrievalMatchCount ?? 0);
  const isCount = metadata.retrievalIntent === 'COUNT';

  // For COUNT, render the actual count value prominently.
  // For other intents, render document chips.
  let body = '';
  if (isCount) {
    const value = metadata.retrievalCount ?? count;
    body = `<div class="retrieval-count">SQL count: <strong>${escapeHtml(String(value))}</strong></div>`;
  } else if (Array.isArray(metadata.retrievalDocuments) && metadata.retrievalDocuments.length > 0) {
    const chips = metadata.retrievalDocuments.slice(0, 50).map(d => {
      const fn = escapeHtml(String(d.file_name ?? ''));
      const title = d.title ? escapeHtml(String(d.title)) : '';
      const ftype = d.file_type ? escapeHtml(String(d.file_type)) : '';
      const snippetHtml = d.snippet ? renderSnippetSafe(String(d.snippet), d.matchedPhrase) : '';
      return `<span class="source-chip" data-doc-id="${escapeHtml(String(d.document_id))}">` +
        `<span class="chip-row">` +
          `<span class="chip-name">${fn}</span>` +
          (title ? `<span class="chip-title">${title}</span>` : '') +
          (ftype ? `<span class="chip-type">${ftype}</span>` : '') +
        `</span>` +
        (snippetHtml ? `<span class="chip-snippet">${snippetHtml}</span>` : '') +
        `</span>`;
    }).join('');
    body = `<div class="retrieval-chips">${chips}</div>`;
  }

  return `<div class="retrieval-panel" data-intent="${intent}" data-source="${source}">` +
    `<span class="retrieval-badge intent">${intent}</span>` +
    `<span class="retrieval-badge source source-${source}">${source}</span>` +
    `<span class="retrieval-badge count">${count} match${count === 1 ? '' : 'es'}</span>` +
    body +
    `</div>`;
}
