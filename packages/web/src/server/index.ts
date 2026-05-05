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
  </style>
</head>
<body>
  <header>
    <div class="status" id="status"></div>
    <h1>AgentX</h1>
    <nav>
      <button class="active" onclick="showPage('chat')">Chat</button>
      <button onclick="showPage('sessions')">Sessions</button>
      <button onclick="showPage('skills')">Skills</button>
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

      // Create a streaming assistant message placeholder
      const msgDiv = document.createElement('div');
      msgDiv.className = 'message assistant';
      msgDiv.innerHTML = '<div class="role">assistant</div><span class="stream-content"></span>';
      document.getElementById('messages').appendChild(msgDiv);
      const contentSpan = msgDiv.querySelector('.stream-content');

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
                fullContent += '\\nError: ' + event.message;
                contentSpan.textContent = fullContent;
              }
            } catch { /* skip malformed SSE */ }
          }
        }
      } catch (err) {
        contentSpan.textContent = 'Error: ' + err.message;
      }
      document.getElementById('sendBtn').disabled = false;
      input.focus();
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
      } else if (page === 'settings') {
        footer.style.display = 'none';
        main.innerHTML = '<div class="settings-panel"><h2>Settings</h2><p>Loading...</p></div>';
        try {
          const res = await fetch('/api/status');
          const status = await res.json();
          main.innerHTML = '<div class="settings-panel"><h2>Settings</h2>' +
            '<div class="field"><label>Agent Name</label><div class="value">' + status.agentName + '</div></div>' +
            '<div class="field"><label>Model</label><div class="value">' + status.model + '</div></div>' +
            '<div class="field"><label>Active Sessions</label><div class="value">' + status.activeSessions + '</div></div>' +
            '<div class="field"><label>Integrations</label><div class="value">' + (status.integrations||[]).join(', ') + '</div></div>' +
            '</div>';
        } catch { main.innerHTML = '<div class="settings-panel"><h2>Settings</h2><p>Failed to load</p></div>'; }
      }
    }

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
