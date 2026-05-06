/**
 * Pure payload builder for the R11 thumbs-feedback POST.
 *
 * Mirrors the contract enforced by `feedback-store.ts`:
 *   required: messageId, userQuery, assistantResponse, rating
 *   optional: comment, sessionId, retrieval projection
 *
 * Pulled out of `components/FeedbackBar.tsx` so it can be unit-tested without
 * a DOM. The component imports and POSTs the result.
 */

import type { RetrievalMetadataLike } from './render-retrieval.js';

export interface FeedbackContextLike {
  messageId: string;
  userQuery: string;
  assistantResponse: string;
  sessionId?: string;
  retrieval?: RetrievalMetadataLike | null;
}

export function buildFeedbackPayload(
  ctx: FeedbackContextLike,
  rating: 'up' | 'down',
  comment?: string,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    messageId: ctx.messageId,
    userQuery: ctx.userQuery,
    assistantResponse: ctx.assistantResponse,
    rating,
  };
  if (comment) payload['comment'] = comment;
  if (ctx.sessionId) payload['sessionId'] = ctx.sessionId;
  if (ctx.retrieval) {
    payload['retrievalIntent'] = ctx.retrieval.retrievalIntent;
    payload['retrievalSource'] = ctx.retrieval.retrievalSource;
    payload['retrievalMatchCount'] = ctx.retrieval.retrievalMatchCount;
    if (Array.isArray(ctx.retrieval.retrievalDocuments)) {
      payload['retrievalDocumentIds'] = ctx.retrieval.retrievalDocuments
        .map((d) => d.document_id)
        .filter(Boolean);
    }
  }
  return payload;
}
