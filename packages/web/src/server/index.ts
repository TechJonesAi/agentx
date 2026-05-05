/**
 * AgentX Web UI Server
 *
 * Provides an HTTP API and serves a web-based chat interface.
 * Uses Node's built-in http module to avoid heavy express dependency.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Agent, createLogger } from '@agentx/core';
import { createApiRouter } from './routes/api.js';

const log = createLogger('web:server');

export interface WebServerConfig {
  port: number;
  host: string;
  agent: Agent;
  staticDir?: string;
}

export class WebServer {
  private server: http.Server | null = null;
  private config: WebServerConfig;
  private apiRouter: ReturnType<typeof createApiRouter>;

  constructor(config: WebServerConfig) {
    this.config = config;
    this.apiRouter = createApiRouter(config.agent);
  }

  async start(): Promise<void> {
    this.server = http.createServer(async (req, res) => {
      try {
        await this.handleRequest(req, res);
      } catch (error) {
        log.error({ error, url: req.url }, 'Request handler error');
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      }
    });

    return new Promise((resolve) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        log.info({ port: this.config.port, host: this.config.host }, 'Web server started');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.server) {
      return new Promise((resolve) => {
        this.server!.close(() => {
          log.info('Web server stopped');
          resolve();
        });
      });
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const method = req.method ?? 'GET';

    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // API routes
    if (url.startsWith('/api/')) {
      await this.apiRouter.handle(method, url, req, res);
      return;
    }

    // Serve static files (client UI)
    if (method === 'GET') {
      await this.serveStatic(url, res);
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
  }

  private async serveStatic(url: string, res: http.ServerResponse): Promise<void> {
    // Serve the embedded HTML UI for the root path
    if (url === '/' || url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(getEmbeddedHtml());
      return;
    }

    // Try static dir if configured
    if (this.config.staticDir) {
      const filePath = path.join(this.config.staticDir, url);
      const safePath = path.resolve(filePath);
      if (safePath.startsWith(this.config.staticDir) && fs.existsSync(safePath)) {
        const ext = path.extname(safePath);
        const mimeTypes: Record<string, string> = {
          '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
          '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml',
        };
        res.writeHead(200, { 'Content-Type': mimeTypes[ext] ?? 'application/octet-stream' });
        fs.createReadStream(safePath).pipe(res);
        return;
      }
    }

    // SPA fallback: serve index.html for all non-API routes
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(getEmbeddedHtml());
  }
}

/**
 * Embedded single-page HTML UI.
 * This provides a minimal functional chat interface without any build tooling.
 */
export function getEmbeddedHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentX</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #1a1a2e; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
    header { background: #16213e; padding: 16px 24px; display: flex; align-items: center; gap: 12px; border-bottom: 1px solid #0f3460; }
    header h1 { font-size: 18px; font-weight: 600; }
    .status { width: 8px; height: 8px; border-radius: 50%; background: #4ecca3; }
    nav { display: flex; gap: 8px; margin-left: auto; }
    nav button { background: #0f3460; color: #e0e0e0; border: none; padding: 6px 14px; border-radius: 6px; cursor: pointer; font-size: 13px; }
    nav button:hover { background: #1a1a4e; }
    nav button.active { background: #4ecca3; color: #1a1a2e; }
    main { flex: 1; overflow-y: auto; padding: 20px 24px; }
    .messages { max-width: 800px; margin: 0 auto; }
    .message { margin-bottom: 16px; padding: 12px 16px; border-radius: 12px; max-width: 85%; line-height: 1.5; white-space: pre-wrap; }
    .message.user { background: #0f3460; margin-left: auto; }
    .message.assistant { background: #16213e; border: 1px solid #0f3460; }
    .message .role { font-size: 11px; color: #888; margin-bottom: 4px; text-transform: uppercase; }
    footer { background: #16213e; padding: 16px 24px; border-top: 1px solid #0f3460; }
    .input-row { max-width: 800px; margin: 0 auto; display: flex; gap: 8px; }
    input[type="text"] { flex: 1; background: #1a1a2e; border: 1px solid #0f3460; color: #e0e0e0; padding: 10px 14px; border-radius: 8px; font-size: 14px; outline: none; }
    input[type="text"]:focus { border-color: #4ecca3; }
    button.send { background: #4ecca3; color: #1a1a2e; border: none; padding: 10px 20px; border-radius: 8px; font-weight: 600; cursor: pointer; }
    button.send:hover { background: #3dbb91; }
    button.send:disabled { opacity: 0.5; cursor: not-allowed; }
    .settings-panel { max-width: 800px; margin: 0 auto; }
    .settings-panel h2 { margin-bottom: 16px; }
    .settings-panel .field { margin-bottom: 12px; }
    .settings-panel label { display: block; font-size: 13px; color: #888; margin-bottom: 4px; }
    .settings-panel .value { color: #4ecca3; }
    /* R7: retrieval metadata panel */
    .retrieval-panel { background: #1a1a3a; border: 1px solid #0f3460; border-radius: 8px; padding: 8px 12px; margin: 4px 0 12px; max-width: 85%; font-size: 12px; }
    .retrieval-badge { display: inline-block; padding: 2px 8px; border-radius: 4px; margin-right: 6px; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
    .retrieval-badge.intent { background: #0f3460; color: #b0c4de; }
    .retrieval-badge.source { color: #1a1a2e; }
    .retrieval-badge.source.source-sql { background: #4ecca3; }
    .retrieval-badge.source.source-entity { background: #ffc857; }
    .retrieval-badge.source.source-fts { background: #b0c4de; }
    .retrieval-badge.source.source-vector { background: #c89bff; }
    .retrieval-badge.source.source-mixed { background: #ff8c69; }
    .retrieval-badge.count { background: transparent; color: #888; }
    .retrieval-count { margin-top: 6px; font-size: 14px; color: #4ecca3; }
    .retrieval-chips { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 4px; }
    .source-chip { background: #0f3460; padding: 4px 8px; border-radius: 4px; font-size: 11px; display: flex; flex-direction: column; gap: 3px; align-items: flex-start; max-width: 100%; }
    .source-chip .chip-row { display: inline-flex; gap: 6px; align-items: baseline; }
    .source-chip .chip-name { color: #e0e0e0; font-weight: 500; }
    .source-chip .chip-title { color: #888; font-style: italic; }
    .source-chip .chip-type { color: #4ecca3; text-transform: uppercase; font-size: 9px; padding: 1px 4px; background: #0a1a2e; border-radius: 3px; }
    .source-chip .chip-snippet { color: #c0c8d0; font-size: 11px; line-height: 1.4; max-width: 100%; overflow-wrap: anywhere; }
    .source-chip .chip-snippet mark.match { background: #ffc857; color: #1a1a2e; padding: 0 2px; border-radius: 2px; font-weight: 600; }
    /* R11: feedback buttons */
    .feedback-bar { margin-top: 8px; display: flex; gap: 6px; align-items: center; font-size: 11px; }
    .feedback-btn { background: transparent; color: #888; border: 1px solid #0f3460; padding: 3px 8px; border-radius: 4px; cursor: pointer; font-size: 12px; }
    .feedback-btn:hover { color: #e0e0e0; border-color: #4ecca3; }
    .feedback-btn.active { background: #0f3460; color: #4ecca3; border-color: #4ecca3; }
    .feedback-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    .feedback-comment { margin-top: 6px; display: flex; gap: 6px; }
    .feedback-comment input { flex: 1; background: #0a1a2e; border: 1px solid #0f3460; color: #e0e0e0; padding: 4px 8px; border-radius: 4px; font-size: 12px; }
    .feedback-status { color: #4ecca3; font-size: 11px; margin-left: 8px; }
    /* Header model badge (provider + model) */
    .model-badge { display: inline-flex; gap: 6px; align-items: center; font-size: 12px; padding: 4px 10px; border-radius: 4px; background: #0a1a2e; border: 1px solid #0f3460; }
    .model-badge .provider { color: #4ecca3; font-weight: 600; text-transform: uppercase; font-size: 10px; }
    .model-badge .model-name { color: #e0e0e0; }
    .model-badge .badge-warn { color: #ff8c69; font-size: 11px; margin-left: 4px; }
    /* Provider list (Settings → Models) */
    .provider-row { padding: 8px 12px; margin-bottom: 6px; background: #0f3460; border-radius: 6px; display: flex; gap: 12px; align-items: center; }
    .provider-row.active { border: 1px solid #4ecca3; }
    .provider-row .pid { font-weight: 600; min-width: 80px; }
    .provider-row .plabel { color: #c0c8d0; flex: 1; }
    .provider-row .pstate.ok { color: #4ecca3; }
    .provider-row .pstate.warn { color: #ff8c69; }
    .switch-instructions { margin-top: 12px; padding: 10px; background: #0a1a2e; border-radius: 6px; font-size: 12px; color: #c0c8d0; line-height: 1.5; }
    /* Categorised error banner in chat */
    .chat-error-banner { background: #3a1a1a; border: 1px solid #ff8c69; color: #ffc6b3; padding: 10px 12px; border-radius: 6px; margin: 8px 0; font-size: 13px; }
    .chat-error-banner .err-code { font-family: monospace; font-size: 11px; color: #ff8c69; display: block; margin-top: 4px; }
  </style>
</head>
<body>
  <header>
    <div class="status" id="status"></div>
    <h1>AgentX</h1>
    <span id="modelBadge" class="model-badge" title="Click 'Models' to see provider availability">
      <span class="provider" id="badgeProvider">…</span>
      <span class="model-name" id="badgeModel">…</span>
    </span>
    <nav>
      <button class="active" onclick="showPage('chat')">Chat</button>
      <button onclick="showPage('sessions')">Sessions</button>
      <button onclick="showPage('skills')">Tools</button>
      <button onclick="showPage('models')">Models</button>
      <button onclick="showPage('settings')">Settings</button>
    </nav>
  </header>
  <main id="main">
    <div class="messages" id="messages"></div>
  </main>
  <footer id="footer">
    <div class="input-row">
      <input type="text" id="input" placeholder="Type a message..." onkeydown="if(event.key==='Enter')sendMessage()">
      <button class="send" id="sendBtn" onclick="sendMessage()">Send</button>
    </div>
  </footer>
  <script>
    let sessionId = null;
    let currentPage = 'chat';

    // R7: pure renderer for retrieval metadata. Mirrors
    //     packages/web/src/client/render-retrieval.ts (renderRetrievalPanelHtml).
    function renderRetrievalPanel(metadata) {
      if (!metadata) return '';
      const intent = String(metadata.retrievalIntent || '');
      const source = String(metadata.retrievalSource || '');
      const count = Number(metadata.retrievalMatchCount || 0);
      const isCount = metadata.retrievalIntent === 'COUNT';
      let body = '';
      if (isCount) {
        const value = (metadata.retrievalCount !== undefined) ? metadata.retrievalCount : count;
        body = '<div class="retrieval-count">SQL count: <strong>' + escapeHtml(String(value)) + '</strong></div>';
      } else if (Array.isArray(metadata.retrievalDocuments) && metadata.retrievalDocuments.length > 0) {
        const chips = metadata.retrievalDocuments.slice(0, 50).map(function(d) {
          const fn = escapeHtml(String(d.file_name || ''));
          const title = d.title ? escapeHtml(String(d.title)) : '';
          const ftype = d.file_type ? escapeHtml(String(d.file_type)) : '';
          // R9: snippet — escape, then highlight matched phrase via literal split-join (no regex)
          let snippetHtml = '';
          if (d.snippet) {
            const escSnip = escapeHtml(String(d.snippet));
            if (d.matchedPhrase) {
              const escMatch = escapeHtml(String(d.matchedPhrase));
              snippetHtml = (escMatch && escSnip.indexOf(escMatch) >= 0)
                ? escSnip.split(escMatch).join('<mark class="match">' + escMatch + '</mark>')
                : escSnip;
            } else {
              snippetHtml = escSnip;
            }
          }
          return '<span class="source-chip" data-doc-id="' + escapeHtml(String(d.document_id || '')) + '">' +
            '<span class="chip-row">' +
              '<span class="chip-name">' + fn + '</span>' +
              (title ? '<span class="chip-title">' + title + '</span>' : '') +
              (ftype ? '<span class="chip-type">' + ftype + '</span>' : '') +
            '</span>' +
            (snippetHtml ? '<span class="chip-snippet">' + snippetHtml + '</span>' : '') +
            '</span>';
        }).join('');
        body = '<div class="retrieval-chips">' + chips + '</div>';
      }
      return '<div class="retrieval-panel" data-intent="' + escapeHtml(intent) + '" data-source="' + escapeHtml(source) + '">' +
        '<span class="retrieval-badge intent">' + escapeHtml(intent) + '</span>' +
        '<span class="retrieval-badge source source-' + escapeHtml(source) + '">' + escapeHtml(source) + '</span>' +
        '<span class="retrieval-badge count">' + count + ' match' + (count === 1 ? '' : 'es') + '</span>' +
        body +
        '</div>';
    }

    async function sendMessage() {
      const input = document.getElementById('input');
      const text = input.value.trim();
      if (!text) return;
      input.value = '';
      addMessage('user', text);
      document.getElementById('sendBtn').disabled = true;

      // R11: a per-message id used for feedback correlation
      const messageId = 'msg-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);

      // Create a streaming assistant message placeholder
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message assistant';
      msgDiv.dataset.messageId = messageId;
      msgDiv.innerHTML = '<div class="role">assistant</div><span class="stream-content"></span>';
      document.getElementById('messages').appendChild(msgDiv);
      const contentSpan = msgDiv.querySelector('.stream-content');

      // R11: feedback metadata captured during streaming
      let lastRetrievalForFeedback = null;
      const userQueryForFeedback = text;

      try {
        const res = await apiFetch('/api/chat/stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: text, sessionId }),
        });

        if (res.status === 401) {
          contentSpan.textContent = 'Unauthorized. Check auth token.';
          document.getElementById('sendBtn').disabled = false;
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullContent = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\\n');
          buffer = lines.pop() || '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.type === 'retrieval') {
                // R7: insert retrieval panel BEFORE the assistant message
                const panelHtml = renderRetrievalPanel(event.retrieval);
                if (panelHtml) {
                  const wrap = document.createElement('div');
                  wrap.innerHTML = panelHtml;
                  const panel = wrap.firstElementChild;
                  if (panel) msgDiv.parentElement.insertBefore(panel, msgDiv);
                }
                // R11: snapshot metadata for the feedback payload
                lastRetrievalForFeedback = event.retrieval || null;
              } else if (event.type === 'token') {
                fullContent += event.content;
                contentSpan.textContent = fullContent;
                document.getElementById('main').scrollTop = document.getElementById('main').scrollHeight;
              } else if (event.type === 'tool') {
                fullContent += '\\n[Using tool: ' + event.tool + ']\\n';
                contentSpan.textContent = fullContent;
              } else if (event.type === 'done') {
                sessionId = event.sessionId || sessionId;
                // Final content replaces streamed content
                if (event.content && event.content !== fullContent) {
                  contentSpan.textContent = event.content;
                }
              } else if (event.type === 'error') {
                // Render a categorised error banner instead of inlining the
                // raw error into the response text.
                const banner = document.createElement('div');
                banner.className = 'chat-error-banner';
                banner.textContent = event.message || 'Server error';
                if (event.code) {
                  const code = document.createElement('span');
                  code.className = 'err-code';
                  code.textContent = 'code: ' + event.code;
                  banner.appendChild(code);
                }
                msgDiv.parentElement.insertBefore(banner, msgDiv);
                if (!fullContent) {
                  contentSpan.textContent = '(failed)';
                }
              }
            } catch { /* skip malformed SSE */ }
          }
        }
      } catch (err) {
        contentSpan.textContent = 'Error: ' + err.message;
      }

      // R11: attach feedback bar to this assistant message (only when there's content)
      if (contentSpan.textContent && contentSpan.textContent.length > 0) {
        attachFeedbackBar(msgDiv, {
          messageId: messageId,
          userQuery: userQueryForFeedback,
          assistantResponse: contentSpan.textContent,
          retrieval: lastRetrievalForFeedback,
          sessionId: sessionId,
        });
      }

      document.getElementById('sendBtn').disabled = false;
      input.focus();
    }

    // R11: feedback UI helpers
    function attachFeedbackBar(messageDiv, ctx) {
      const bar = document.createElement('div');
      bar.className = 'feedback-bar';
      bar.innerHTML =
        '<button class="feedback-btn fb-up" type="button" aria-label="Thumbs up">👍</button>' +
        '<button class="feedback-btn fb-down" type="button" aria-label="Thumbs down">👎</button>' +
        '<span class="feedback-status"></span>';
      messageDiv.appendChild(bar);
      const upBtn = bar.querySelector('.fb-up');
      const downBtn = bar.querySelector('.fb-down');
      const status = bar.querySelector('.feedback-status');

      function setSubmitted(rating) {
        upBtn.disabled = true; downBtn.disabled = true;
        if (rating === 'up') upBtn.classList.add('active');
        if (rating === 'down') downBtn.classList.add('active');
        status.textContent = 'Thanks for the feedback';
      }

      upBtn.addEventListener('click', async () => {
        await submitFeedback(ctx, 'up', null, status, () => setSubmitted('up'));
      });
      downBtn.addEventListener('click', async () => {
        // Inline comment box for downvote
        const wrap = document.createElement('div');
        wrap.className = 'feedback-comment';
        wrap.innerHTML =
          '<input type="text" placeholder="What was wrong? (optional)" maxlength="500">' +
          '<button class="feedback-btn" type="button">Send</button>';
        messageDiv.appendChild(wrap);
        const inputEl = wrap.querySelector('input');
        const sendBtnEl = wrap.querySelector('button');
        inputEl.focus();
        sendBtnEl.addEventListener('click', async () => {
          const comment = inputEl.value.trim();
          await submitFeedback(ctx, 'down', comment || undefined, status, () => {
            setSubmitted('down');
            wrap.remove();
          });
        });
        inputEl.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') sendBtnEl.click();
        });
      });
    }

    async function submitFeedback(ctx, rating, comment, status, onSuccess) {
      try {
        const payload = {
          messageId: ctx.messageId,
          userQuery: ctx.userQuery,
          assistantResponse: ctx.assistantResponse,
          rating: rating,
        };
        if (comment) payload.comment = comment;
        if (ctx.sessionId) payload.sessionId = ctx.sessionId;
        if (ctx.retrieval) {
          payload.retrievalIntent = ctx.retrieval.retrievalIntent;
          payload.retrievalSource = ctx.retrieval.retrievalSource;
          payload.retrievalMatchCount = ctx.retrieval.retrievalMatchCount;
          if (Array.isArray(ctx.retrieval.retrievalDocuments)) {
            payload.retrievalDocumentIds = ctx.retrieval.retrievalDocuments.map(d => d.document_id).filter(Boolean);
          }
        }
        const r = await apiFetch('/api/chat/feedback', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (r.ok) onSuccess();
        else status.textContent = 'Feedback failed';
      } catch (err) {
        status.textContent = 'Feedback error: ' + err.message;
      }
    }

    function addMessage(role, content) {
      const div = document.createElement('div');
      div.className = 'message ' + role;
      div.innerHTML = '<div class="role">' + role + '</div>' + escapeHtml(content);
      document.getElementById('messages').appendChild(div);
      document.getElementById('main').scrollTop = document.getElementById('main').scrollHeight;
    }

    function escapeHtml(text) {
      return text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    }

    async function showPage(page) {
      currentPage = page;
      document.querySelectorAll('nav button').forEach(b => b.classList.remove('active'));
      event.target.classList.add('active');
      const main = document.getElementById('main');
      const footer = document.getElementById('footer');

      if (page === 'chat') {
        main.innerHTML = '<div class="messages" id="messages"></div>';
        footer.style.display = '';
      } else if (page === 'sessions') {
        footer.style.display = 'none';
        main.innerHTML = '<div class="settings-panel"><h2>Sessions</h2><p>Loading...</p></div>';
        try {
          const res = await fetch('/api/sessions');
          const sessions = await res.json();
          main.innerHTML = '<div class="settings-panel"><h2>Sessions (' + sessions.length + ')</h2>' +
            sessions.map(s => '<div class="field"><div class="value">' + s.sessionKey + '</div><div>' + s.updatedAt + '</div></div>').join('') +
            '</div>';
        } catch { main.innerHTML = '<div class="settings-panel"><h2>Sessions</h2><p>Failed to load</p></div>'; }
      } else if (page === 'skills') {
        footer.style.display = 'none';
        main.innerHTML = '<div class="settings-panel"><h2>Skills</h2><p>Loading...</p></div>';
        try {
          const res = await fetch('/api/skills');
          const skills = await res.json();
          main.innerHTML = '<div class="settings-panel"><h2>Skills (' + skills.length + ')</h2>' +
            skills.map(s => '<div class="field"><div class="value">' + s.name + ' v' + s.version + '</div><div>' + s.description + '</div></div>').join('') +
            '</div>';
        } catch { main.innerHTML = '<div class="settings-panel"><h2>Skills</h2><p>Failed to load</p></div>'; }
      } else if (page === 'models') {
        footer.style.display = 'none';
        main.innerHTML = '<div class="settings-panel"><h2>Models &amp; Providers</h2><p>Loading…</p></div>';
        try {
          const res = await fetch('/api/providers');
          const data = await res.json();
          const rows = (data.providers || []).map(function(p) {
            const isActive = p.id === data.active;
            const cls = 'provider-row' + (isActive ? ' active' : '');
            const stateClass = p.configured ? 'pstate ok' : 'pstate warn';
            const stateText = p.configured ? 'configured' : 'NOT configured (' + escapeHtml(String(p.configuredVia || '')) + ')';
            return '<div class="' + cls + '">' +
              '<span class="pid">' + escapeHtml(String(p.id)) + (isActive ? ' ★' : '') + '</span>' +
              '<span class="plabel">' + escapeHtml(String(p.label || '')) + ' — model: ' + escapeHtml(String(p.defaultModel || '')) + '</span>' +
              '<span class="' + stateClass + '">' + stateText + '</span>' +
              '</div>';
          }).join('');
          main.innerHTML = '<div class="settings-panel">' +
            '<h2>Models &amp; Providers</h2>' +
            '<div class="field"><label>Active</label><div class="value">' +
              escapeHtml(String(data.active || '?')) + ' / ' + escapeHtml(String(data.activeModel || '?')) +
            '</div></div>' +
            rows +
            '<div class="switch-instructions">' + escapeHtml(String(data.switchInstructions || '')) + '</div>' +
            '</div>';
        } catch (e) {
          main.innerHTML = '<div class="settings-panel"><h2>Models &amp; Providers</h2><p>Failed to load: ' + escapeHtml((e && e.message) ? e.message : String(e)) + '</p></div>';
        }
      } else if (page === 'settings') {
        footer.style.display = 'none';
        main.innerHTML = '<div class="settings-panel"><h2>Settings</h2><p>Loading...</p></div>';
        try {
          const [statusRes, provRes] = await Promise.all([fetch('/api/status'), fetch('/api/providers')]);
          const status = await statusRes.json();
          const provs = await provRes.json();
          const activeProv = (provs.providers || []).find(function(p) { return p.id === provs.active; });
          const provWarn = activeProv && !activeProv.configured
            ? '<div class="badge-warn">⚠ Provider not configured — set ' + escapeHtml(String(activeProv.configuredVia || '')) + '</div>'
            : '';
          main.innerHTML = '<div class="settings-panel"><h2>Settings</h2>' +
            '<div class="field"><label>Agent Name</label><div class="value">' + escapeHtml(String(status.agentName)) + '</div></div>' +
            '<div class="field"><label>Active Provider</label><div class="value">' + escapeHtml(String(provs.active || '?')) + provWarn + '</div></div>' +
            '<div class="field"><label>Model</label><div class="value">' + escapeHtml(String(status.model)) + '</div></div>' +
            '<div class="field"><label>Active Sessions</label><div class="value">' + status.activeSessions + '</div></div>' +
            '<div class="field"><label>Integrations</label><div class="value">' + (status.integrations||[]).map(escapeHtml).join(', ') + '</div></div>' +
            '<div class="switch-instructions">To switch providers, edit <code>config/default.yaml</code> → <code>agent.defaultProvider</code> (one of: anthropic, openai, ollama) and restart. Use <strong>ollama</strong> for free local inference.</div>' +
            '</div>';
        } catch { main.innerHTML = '<div class="settings-panel"><h2>Settings</h2><p>Failed to load</p></div>'; }
      }
    }

    /** Populate the header model badge from /api/providers. */
    async function refreshModelBadge() {
      try {
        const r = await fetch('/api/providers');
        const d = await r.json();
        const active = (d.providers || []).find(p => p.id === d.active);
        document.getElementById('badgeProvider').textContent = d.active || '?';
        document.getElementById('badgeModel').textContent = d.activeModel || '?';
        if (active && !active.configured) {
          const badge = document.getElementById('modelBadge');
          if (!badge.querySelector('.badge-warn')) {
            const warn = document.createElement('span');
            warn.className = 'badge-warn';
            warn.textContent = '⚠ not configured';
            badge.appendChild(warn);
          }
        }
      } catch { /* keep ellipsis */ }
    }
    refreshModelBadge();

    // Check agent health
    async function checkHealth() {
      try {
        const res = await fetch('/api/health');
        document.getElementById('status').style.background = res.ok ? '#4ecca3' : '#e74c3c';
      } catch { document.getElementById('status').style.background = '#e74c3c'; }
    }
    setInterval(checkHealth, 10000);
    checkHealth();
    document.getElementById('input').focus();
  </script>
</body>
</html>`;
}

export { createApiRouter } from './routes/api.js';
