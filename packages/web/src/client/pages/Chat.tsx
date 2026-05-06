import React, { useState, useRef, useEffect, useCallback } from 'react';
import { RetrievalPanel, type RetrievalMetadata } from '../components/RetrievalPanel';
import { FeedbackBar } from '../components/FeedbackBar';
import { consumeSseChunk } from '../chat-sse-parser';

/**
 * Chat page — Step 2.
 *
 * Recreated (not lifted) from Silly Johnson because that file (1500 lines) is
 * tightly coupled to BuilderV2 build cards, multimodal/TTS endpoints,
 * projects polling, and synthesis panels — all out of scope for this step.
 *
 * In scope:
 *  - USER / ASSISTANT styled bubbles (cyan-gradient theme)
 *  - persona selector (cosmetic, sent as `persona` field that the server
 *    safely ignores)
 *  - voice toggle UI (UI only, no backend)
 *  - paperclip/upload button (UI only, no backend)
 *  - SSE streaming via /api/chat/stream
 *  - R7 retrieval panel (rendered when retrieval event fires)
 *  - R9 snippet highlighting (handled inside RetrievalPanel)
 *  - R11 thumbs feedback (per-assistant-message FeedbackBar)
 *  - safe error banner (categorised codes from R10/live-fix)
 */

interface UserMessage {
  id: string;
  role: 'user';
  content: string;
  timestamp: number;
  attachmentCount?: number;
}

interface AssistantMessage {
  id: string;
  role: 'assistant';
  content: string;
  timestamp: number;
  /** matched user message that produced this reply, for feedback context */
  userQuery: string;
  /** sessionId tagged on completion */
  sessionId?: string;
  /** R7 retrieval metadata (if any) */
  retrieval?: RetrievalMetadata | null;
  /** while tokens are streaming */
  streaming?: boolean;
  /** terminal error from server (categorised) */
  error?: { code?: string; message: string };
}

type Message = UserMessage | AssistantMessage;

const PERSONAS = [
  { id: 'default', name: 'Default' },
  { id: 'professional', name: 'Professional' },
  { id: 'friendly', name: 'Friendly' },
  { id: 'concise', name: 'Concise' },
];

function newId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function Chat(): React.JSX.Element {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [persona, setPersona] = useState('default');
  const [voiceOn, setVoiceOn] = useState(false);
  const [attachments, setAttachments] = useState<File[]>([]);
  const [sending, setSending] = useState(false);
  const [bannerError, setBannerError] = useState<{ code?: string; message: string } | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // auto-scroll on new content
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const updateAssistant = useCallback(
    (id: string, patch: Partial<AssistantMessage>) => {
      setMessages((prev) =>
        prev.map((m) =>
          m.id === id && m.role === 'assistant' ? { ...m, ...patch } : m,
        ),
      );
    },
    [],
  );

  const handleSend = useCallback(async () => {
    const text = input.trim();
    if (!text || sending) return;

    setBannerError(null);
    setSending(true);

    const userMsg: UserMessage = {
      id: newId('u'),
      role: 'user',
      content: text,
      timestamp: Date.now(),
      attachmentCount: attachments.length || undefined,
    };
    const asstId = newId('a');
    const asstMsg: AssistantMessage = {
      id: asstId,
      role: 'assistant',
      content: '',
      timestamp: Date.now(),
      userQuery: text,
      streaming: true,
    };

    setMessages((prev) => [...prev, userMsg, asstMsg]);
    setInput('');
    setAttachments([]);

    // Stream via SSE-over-POST. Note: we use fetch() + getReader() rather than
    // EventSource so we can POST a JSON body. Each event is a single
    // `data: <json>\n\n` line; we parse them as they arrive.
    try {
      const res = await fetch('/api/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify({
          message: text,
          sessionId,
          // persona is currently cosmetic — server tolerates extra fields.
          persona,
        }),
      });

      if (!res.ok || !res.body) {
        // Non-streaming error: try to read JSON body for categorised code.
        let code: string | undefined;
        let message = `HTTP ${res.status}`;
        try {
          const j = (await res.json()) as { code?: string; error?: string };
          code = j.code;
          if (j.error) message = j.error;
        } catch {
          /* fall through */
        }
        setBannerError({ code, message });
        updateAssistant(asstId, {
          streaming: false,
          error: { code, message },
        });
        setSending(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      let accum = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const { buffer: nextBuf, events } = consumeSseChunk(
          buf,
          decoder.decode(value, { stream: true }),
        );
        buf = nextBuf;
        for (const evt of events) {
          if (evt.type === 'retrieval') {
            updateAssistant(asstId, {
              retrieval: (evt.retrieval as RetrievalMetadata | null) ?? null,
            });
          } else if (evt.type === 'token') {
            accum += evt.content;
            updateAssistant(asstId, { content: accum });
          } else if (evt.type === 'done') {
            const finalContent = evt.content || accum;
            if (evt.sessionId) setSessionId(evt.sessionId);
            updateAssistant(asstId, {
              content: finalContent,
              streaming: false,
              sessionId: evt.sessionId,
            });
          } else if (evt.type === 'error') {
            setBannerError({ code: evt.code, message: evt.message });
            updateAssistant(asstId, {
              streaming: false,
              error: { code: evt.code, message: evt.message },
            });
          }
          // tool / unknown events ignored in this minimal Chat
        }
      }

      // mark done if server closed without an explicit 'done'
      updateAssistant(asstId, { streaming: false });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setBannerError({ message });
      updateAssistant(asstId, {
        streaming: false,
        error: { message },
      });
    } finally {
      setSending(false);
    }
  }, [input, sending, attachments, sessionId, persona, updateAssistant]);

  const onFileChosen = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const files = e.target.files ? Array.from(e.target.files) : [];
    setAttachments((prev) => [...prev, ...files]);
    // reset so re-selecting the same file fires onChange again
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div className="chat-page">
      {bannerError && (
        <div className="error-banner" role="alert">
          <span className="error-banner__title">
            {bannerError.code ? `${bannerError.code}` : 'Error'}
          </span>
          <span className="error-banner__msg">{bannerError.message}</span>
          <button
            type="button"
            className="error-banner__close"
            onClick={() => setBannerError(null)}
            aria-label="Dismiss error"
          >
            ×
          </button>
        </div>
      )}

      <div className="chat-toolbar">
        <label className="chat-toolbar__field">
          <span>Persona</span>
          <select
            value={persona}
            onChange={(e) => setPersona(e.target.value)}
            disabled={sending}
          >
            {PERSONAS.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className={`voice-toggle${voiceOn ? ' voice-toggle--on' : ''}`}
          onClick={() => setVoiceOn((v) => !v)}
          title="Voice (UI only)"
          aria-pressed={voiceOn}
        >
          {voiceOn ? '🎙 Voice On' : '🔈 Voice Off'}
        </button>
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <div className="chat-empty">
            <p>Start a conversation. Streaming, retrieval, and feedback are wired up.</p>
          </div>
        ) : (
          messages.map((m) =>
            m.role === 'user' ? (
              <UserBubble key={m.id} message={m} />
            ) : (
              <AssistantBubble
                key={m.id}
                message={m}
                sessionId={sessionId}
              />
            ),
          )
        )}
      </div>

      <form
        className="chat-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: 'none' }}
          onChange={onFileChosen}
        />
        <button
          type="button"
          className="composer-icon-btn"
          title="Attach (UI only)"
          onClick={() => fileInputRef.current?.click()}
          disabled={sending}
          aria-label="Attach file"
        >
          📎
        </button>
        {attachments.length > 0 && (
          <span className="composer-attachments" aria-live="polite">
            {attachments.length} file{attachments.length === 1 ? '' : 's'}
            <button
              type="button"
              onClick={() => setAttachments([])}
              className="composer-clear"
              aria-label="Clear attachments"
            >
              ×
            </button>
          </span>
        )}
        <textarea
          className="composer-input"
          rows={2}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void handleSend();
            }
          }}
          placeholder={sending ? 'Waiting for response…' : 'Type a message…'}
          disabled={sending}
        />
        <button
          type="submit"
          className="composer-send"
          disabled={sending || !input.trim()}
        >
          {sending ? '…' : 'Send'}
        </button>
      </form>
    </div>
  );
}

function UserBubble({ message }: { message: UserMessage }): React.JSX.Element {
  return (
    <div className="msg msg--user">
      <div className="msg__role">YOU</div>
      <div className="msg__bubble">
        <div className="msg__content">{message.content}</div>
        {message.attachmentCount ? (
          <div className="msg__attachments">
            📎 {message.attachmentCount} attachment
            {message.attachmentCount === 1 ? '' : 's'} (UI only — not uploaded)
          </div>
        ) : null}
      </div>
    </div>
  );
}

function AssistantBubble({
  message,
  sessionId,
}: {
  message: AssistantMessage;
  sessionId?: string;
}): React.JSX.Element {
  return (
    <div className="msg msg--assistant">
      <div className="msg__role">ASSISTANT</div>
      <div className="msg__bubble">
        {message.retrieval && <RetrievalPanel metadata={message.retrieval} />}
        <div className="msg__content">
          {message.content || (message.streaming ? '…' : '')}
          {message.streaming && <span className="msg__cursor" aria-hidden>▍</span>}
        </div>
        {message.error && (
          <div className="msg__error" role="alert">
            {message.error.code ? `[${message.error.code}] ` : ''}
            {message.error.message}
          </div>
        )}
        {!message.streaming && !message.error && message.content && (
          <FeedbackBar
            ctx={{
              messageId: message.id,
              userQuery: message.userQuery,
              assistantResponse: message.content,
              sessionId: message.sessionId ?? sessionId,
              retrieval: message.retrieval ?? null,
            }}
          />
        )}
      </div>
    </div>
  );
}
