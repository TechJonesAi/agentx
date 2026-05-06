import React, { useState } from 'react';
import type { RetrievalMetadata } from './RetrievalPanel';
import { buildFeedbackPayload } from '../feedback-payload';

/**
 * R11 — thumbs-up / thumbs-down feedback bar attached to assistant messages.
 *
 * POSTs `/api/chat/feedback` with the contract used by the embedded HTML and
 * `feedback-store.ts` validator: messageId, userQuery, assistantResponse,
 * rating, plus optional sessionId and retrieval projection.
 */

export interface FeedbackContext {
  messageId: string;
  userQuery: string;
  assistantResponse: string;
  sessionId?: string;
  retrieval?: RetrievalMetadata | null;
}

type State =
  | { kind: 'idle' }
  | { kind: 'submitting'; rating: 'up' | 'down' }
  | { kind: 'submitted'; rating: 'up' | 'down' }
  | { kind: 'error'; message: string };

export function FeedbackBar({ ctx }: { ctx: FeedbackContext }): React.JSX.Element {
  const [state, setState] = useState<State>({ kind: 'idle' });

  async function submit(rating: 'up' | 'down'): Promise<void> {
    if (state.kind === 'submitting' || state.kind === 'submitted') return;
    setState({ kind: 'submitting', rating });
    const payload = buildFeedbackPayload(ctx, rating);
    try {
      const r = await fetch('/api/chat/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (r.ok) {
        setState({ kind: 'submitted', rating });
      } else {
        const body = await r.text();
        setState({ kind: 'error', message: `Feedback failed (${r.status}): ${body.slice(0, 80)}` });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message: `Feedback error: ${msg}` });
    }
  }

  const upActive =
    (state.kind === 'submitted' || state.kind === 'submitting') && state.rating === 'up';
  const downActive =
    (state.kind === 'submitted' || state.kind === 'submitting') && state.rating === 'down';
  const submitted = state.kind === 'submitted';

  return (
    <div className="feedback-bar" role="group" aria-label="Rate this response">
      <button
        type="button"
        className={`feedback-btn${upActive ? ' active' : ''}`}
        disabled={submitted || state.kind === 'submitting'}
        onClick={() => submit('up')}
        aria-pressed={upActive}
        title="Helpful"
      >
        👍
      </button>
      <button
        type="button"
        className={`feedback-btn${downActive ? ' active' : ''}`}
        disabled={submitted || state.kind === 'submitting'}
        onClick={() => submit('down')}
        aria-pressed={downActive}
        title="Not helpful"
      >
        👎
      </button>
      {state.kind === 'submitted' && (
        <span className="feedback-status">Thanks for the feedback.</span>
      )}
      {state.kind === 'error' && (
        <span className="feedback-status feedback-status--err">{state.message}</span>
      )}
    </div>
  );
}
