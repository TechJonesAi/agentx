/**
 * R11 — feedback UI wiring tests.
 *
 * Inspects the embedded HTML for the required pieces (CSS, helper
 * function, button-attach call) and asserts that buttons are only
 * attached to assistant messages (the `attachFeedbackBar` call sits
 * inside the assistant streaming flow, never inside `addMessage('user', …)`).
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_TS = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'server', 'index.ts'),
  'utf-8',
);

describe('R11 — feedback CSS', () => {
  it('declares .feedback-bar class', () => {
    expect(SERVER_TS).toContain('.feedback-bar');
  });
  it('declares .feedback-btn class', () => {
    expect(SERVER_TS).toContain('.feedback-btn');
  });
  it('declares .feedback-comment class for the downvote follow-up', () => {
    expect(SERVER_TS).toContain('.feedback-comment');
  });
});

describe('R11 — inline JS helpers', () => {
  it('defines attachFeedbackBar', () => {
    expect(SERVER_TS).toContain('function attachFeedbackBar');
  });
  it('defines submitFeedback', () => {
    expect(SERVER_TS).toContain('function submitFeedback');
  });
  it('POSTs to /api/chat/feedback', () => {
    expect(SERVER_TS).toContain("apiFetch('/api/chat/feedback'");
    expect(SERVER_TS).toContain("method: 'POST'");
  });
  it('renders thumbs up + thumbs down buttons', () => {
    expect(SERVER_TS).toContain('class="feedback-btn fb-up"');
    expect(SERVER_TS).toContain('class="feedback-btn fb-down"');
  });
  it('downvote opens an inline comment box', () => {
    expect(SERVER_TS).toContain('What was wrong');
  });
});

describe('R11 — buttons only on assistant messages', () => {
  it('attachFeedbackBar is invoked from the assistant streaming flow only', () => {
    // The user message is rendered via addMessage('user', text). The feedback
    // bar must only attach to msgDiv (the assistant streaming placeholder).
    const idx = SERVER_TS.indexOf('attachFeedbackBar(msgDiv,');
    expect(idx).toBeGreaterThan(0);
    // Sanity: addMessage('user', …) must not call attachFeedbackBar
    const userBlock = SERVER_TS.match(/addMessage\(role,\s*content\)\s*\{[\s\S]+?\}/);
    if (userBlock) {
      expect(userBlock[0]).not.toContain('attachFeedbackBar');
    }
  });

  it('attachFeedbackBar is gated on non-empty assistant content', () => {
    // The wiring should only attach when contentSpan has content (no empty bars
    // on errored streams).
    expect(SERVER_TS).toContain('contentSpan.textContent.length > 0');
    expect(SERVER_TS).toMatch(/contentSpan\.textContent\.length\s*>\s*0[\s\S]+attachFeedbackBar/);
  });
});

describe('R11 — payload shape sent to server', () => {
  it('payload includes messageId, userQuery, assistantResponse, rating', () => {
    expect(SERVER_TS).toContain('messageId: ctx.messageId');
    expect(SERVER_TS).toContain('userQuery: ctx.userQuery');
    expect(SERVER_TS).toContain('assistantResponse: ctx.assistantResponse');
    expect(SERVER_TS).toContain('rating: rating');
  });

  it('payload includes retrieval metadata fields when present', () => {
    expect(SERVER_TS).toContain('payload.retrievalIntent');
    expect(SERVER_TS).toContain('payload.retrievalSource');
    expect(SERVER_TS).toContain('payload.retrievalMatchCount');
    expect(SERVER_TS).toContain('payload.retrievalDocumentIds');
  });

  it('payload omits retrieval fields cleanly when retrieval is off', () => {
    // Code guards on `if (ctx.retrieval) { … }` so an absent metadata snapshot
    // produces a payload without retrieval fields.
    expect(SERVER_TS).toContain('if (ctx.retrieval)');
  });

  it('per-message id is generated and attached to msgDiv', () => {
    expect(SERVER_TS).toContain('messageId =');
    expect(SERVER_TS).toContain('msgDiv.dataset.messageId = messageId');
  });
});
