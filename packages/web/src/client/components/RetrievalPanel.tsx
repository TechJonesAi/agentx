import React from 'react';

/**
 * R7/R9 — React wrapper around the existing pure renderer.
 *
 * The renderer (`render-retrieval.ts`) returns a sanitised HTML string with
 * snippets escaped and `<mark>` wrapping the matched phrase via split-join.
 * We can safely use `dangerouslySetInnerHTML` here because *all* user/document
 * content is escaped inside the renderer; only the wrapper tags it emits are
 * trusted.
 */

import {
  renderRetrievalPanelHtml,
  type RetrievalMetadataLike,
} from '../render-retrieval.js';

export type RetrievalMetadata = RetrievalMetadataLike;

export function RetrievalPanel({
  metadata,
}: {
  metadata: RetrievalMetadata | null | undefined;
}): React.JSX.Element | null {
  const html = renderRetrievalPanelHtml(metadata);
  if (!html) return null;
  return <div className="retrieval-host" dangerouslySetInnerHTML={{ __html: html }} />;
}
