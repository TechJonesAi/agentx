/**
 * Unit tests — R11 feedback POST payload builder.
 *
 * Locks in the contract enforced by feedback-store.ts (validate()):
 *   required: messageId, userQuery, assistantResponse, rating
 *   optional: comment, sessionId, retrievalIntent/Source/MatchCount,
 *             retrievalDocumentIds (id-only projection)
 */
import { describe, it, expect } from 'vitest';
import { buildFeedbackPayload } from '../../src/client/feedback-payload.js';
import type { RetrievalMetadataLike } from '../../src/client/render-retrieval.js';

const baseCtx = {
  messageId: 'a-1',
  userQuery: 'hi',
  assistantResponse: 'hello',
};

describe('buildFeedbackPayload', () => {
  it('includes only required fields when no extras supplied', () => {
    const p = buildFeedbackPayload(baseCtx, 'up');
    expect(p).toEqual({
      messageId: 'a-1',
      userQuery: 'hi',
      assistantResponse: 'hello',
      rating: 'up',
    });
  });

  it('includes rating "down"', () => {
    const p = buildFeedbackPayload(baseCtx, 'down');
    expect(p['rating']).toBe('down');
  });

  it('includes optional sessionId when present', () => {
    const p = buildFeedbackPayload({ ...baseCtx, sessionId: 's-7' }, 'up');
    expect(p['sessionId']).toBe('s-7');
  });

  it('includes optional comment when present', () => {
    const p = buildFeedbackPayload(baseCtx, 'down', 'because reasons');
    expect(p['comment']).toBe('because reasons');
  });

  it('omits empty comment', () => {
    const p = buildFeedbackPayload(baseCtx, 'down', '');
    expect('comment' in p).toBe(false);
  });

  it('projects retrieval metadata into id-only fields', () => {
    const retrieval: RetrievalMetadataLike = {
      retrievalIntent: 'EXACT_SEARCH',
      retrievalSource: 'mixed',
      retrievalMatchCount: 2,
      retrievalDocuments: [
        { document_id: 'd1', file_name: 'a.pdf' },
        { document_id: 'd2', file_name: 'b.eml' },
      ],
    };
    const p = buildFeedbackPayload({ ...baseCtx, retrieval }, 'up');
    expect(p['retrievalIntent']).toBe('EXACT_SEARCH');
    expect(p['retrievalSource']).toBe('mixed');
    expect(p['retrievalMatchCount']).toBe(2);
    expect(p['retrievalDocumentIds']).toEqual(['d1', 'd2']);
    // raw documents (which contain snippet text) must NOT be sent
    expect('retrievalDocuments' in p).toBe(false);
  });

  it('omits retrieval fields when retrieval is null', () => {
    const p = buildFeedbackPayload({ ...baseCtx, retrieval: null }, 'up');
    expect('retrievalIntent' in p).toBe(false);
    expect('retrievalSource' in p).toBe(false);
    expect('retrievalDocumentIds' in p).toBe(false);
  });
});
