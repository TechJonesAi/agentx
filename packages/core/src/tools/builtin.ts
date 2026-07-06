import type { Tool } from '../types.js';
import { ShellSandbox } from '../security/sandbox.js';
import { writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// ─── Write File Tool ─────────────────────────────────────────────────────────
// Dedicated tool for writing file contents without shell-escaping pitfalls.
// Constrained to the AGENTX_APPS workspace and a small set of safe roots.

const WRITE_FILE_ALLOWED_ROOTS = [
  '/Users/darrenjones/Projects/AGENTX_APPS',
  '/tmp',
  '/var/folders',
];

function isPathAllowed(absPath: string): boolean {
  const resolved = resolve(absPath);
  return WRITE_FILE_ALLOWED_ROOTS.some((root) =>
    resolved === root || resolved.startsWith(root + '/'),
  );
}

export const writeFileTool: Tool = {
  definition: {
    name: 'write_file',
    description:
      'Write a file to disk with full content. Use this for any file >50 bytes ' +
      '(HTML/CSS/JS/JSON/MD) instead of `echo > file`. Creates parent directories ' +
      'automatically. Restricted to /Users/darrenjones/Projects/AGENTX_APPS/, /tmp, ' +
      'and /var/folders. Returns the byte count on success.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'Absolute file path. MUST start with /Users/darrenjones/Projects/AGENTX_APPS/ ' +
            'for app builds. Parent directories are created automatically.',
        },
        content: {
          type: 'string',
          description:
            'Full file content as a UTF-8 string. No shell escaping needed — pass ' +
            'the raw HTML/CSS/JS/text exactly as it should appear in the file.',
        },
      },
      required: ['path', 'content'],
    },
  },
  async execute(args) {
    const filePath = args['path'] as string;
    const content = args['content'] as string;

    if (!filePath || typeof filePath !== 'string') {
      return '[write_file error]: path is required and must be a string';
    }
    if (typeof content !== 'string') {
      return '[write_file error]: content is required and must be a string';
    }
    if (!filePath.startsWith('/')) {
      return `[write_file error]: path must be absolute, got: ${filePath}`;
    }
    if (!isPathAllowed(filePath)) {
      return `[write_file error]: path '${filePath}' is outside allowed roots ` +
        `(${WRITE_FILE_ALLOWED_ROOTS.join(', ')})`;
    }

    try {
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, content, 'utf-8');
      const st = await stat(filePath);
      return `[write_file ok]: wrote ${st.size} bytes to ${filePath}`;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return `[write_file error]: ${msg}`;
    }
  },
};

// ─── Shell Tool (sandboxed) ──────────────────────────────────────────────────

export const shellTool: Tool = {
  definition: {
    name: 'shell',
    description: 'Execute a shell command and return the output. Subject to security sandbox restrictions.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        workingDir: {
          type: 'string',
          description: 'Optional working directory for the command',
        },
      },
      required: ['command'],
    },
  },
  async execute(args, context) {
    const command = args['command'] as string;
    const workingDir = args['workingDir'] as string | undefined;
    const config = context.agent.getConfig();

    // Get confirm callback from agent (wired by CLI or integration)
    const confirmCallback = 'getShellConfirmCallback' in context.agent
      ? (context.agent as { getShellConfirmCallback(): ((cmd: string) => Promise<boolean>) | null }).getShellConfirmCallback()
      : undefined;

    const sandbox = new ShellSandbox({
      permissionLevel: config.security.shellPermissionLevel,
      maxTimeout: config.security.maxShellTimeout,
      confirmCallback: confirmCallback ?? undefined,
    });

    const result = await sandbox.execute(command, workingDir);

    if (!result.allowed) {
      return `[Blocked]: ${result.reason}`;
    }

    let output = result.stdout;
    if (result.stderr) {
      output += `\n[stderr]: ${result.stderr}`;
    }
    if (result.exitCode !== 0) {
      output += `\n[exit code]: ${result.exitCode}`;
    }
    if (result.error) {
      output += `\n[error]: ${result.error}`;
    }

    return output || '[No output]';
  },
};

// ─── Memory Tools ────────────────────────────────────────────────────────────
// Both tools now execute REAL reads/writes against the agent's
// LongTermMemoryStore. Previously they returned an opaque JSON echo with
// `action: 'search'` — the LLM couldn't actually retrieve anything.

export const memoryStoreTool: Tool = {
  definition: {
    name: 'memory_store',
    description: 'Store a piece of information in long-term memory for later retrieval. Returns the memory id.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'The content to remember' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tags to categorize this memory (e.g. ["preference", "user"])',
        },
      },
      required: ['content'],
    },
  },
  async execute(args, context) {
    const content = String(args['content'] ?? '').trim();
    const tags = Array.isArray(args['tags']) ? (args['tags'] as unknown[]).filter((t) => typeof t === 'string') as string[] : [];
    if (!content) return '[memory_store error]: content is required';
    try {
      const store = (context.agent as unknown as { getLongTermMemory?: () => { store(c: string, t?: string[]): string } }).getLongTermMemory?.();
      if (!store) return '[memory_store error]: long-term memory not available';
      const id = store.store(content, tags);
      return `[memory_store ok]: stored as ${id} (tags: ${tags.length > 0 ? tags.join(', ') : 'none'})`;
    } catch (e) {
      return `[memory_store error]: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

export const memorySearchTool: Tool = {
  definition: {
    name: 'memory_search',
    description:
      'Search ALL memory: long-term notes, the uploaded document corpus (semantic + keyword), and archived past conversations. Returns matching entries with their sources.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Content substring to search for (case-insensitive)' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional tag filter — at least one tag must match',
        },
        limit: { type: 'number', description: 'Max results to return (default 5, max 20)' },
      },
      required: ['query'],
    },
  },
  async execute(args, context) {
    const query = String(args['query'] ?? '').trim();
    const tagsRaw = args['tags'];
    const tags = Array.isArray(tagsRaw) ? (tagsRaw as unknown[]).filter((t) => typeof t === 'string') as string[] : [];
    const limit = Math.max(1, Math.min(20, Number(args['limit'] ?? 5)));
    try {
      const store = (context.agent as unknown as {
        getLongTermMemory?: () => {
          searchByContent(q: string, n?: number): Array<{ id: string; content: string; tags: string[] }>;
          searchByTags(t: string[], n?: number): Array<{ id: string; content: string; tags: string[] }>;
        };
      }).getLongTermMemory?.();
      if (!store) return '[memory_search error]: long-term memory not available';
      let results: Array<{ id: string; content: string; tags: string[] }> = [];
      if (query) {
        results = store.searchByContent(query, limit);
      }
      if (tags.length > 0) {
        const byTags = store.searchByTags(tags, limit);
        // Merge unique by id, preserving order
        const seen = new Set(results.map((r) => r.id));
        for (const r of byTags) {
          if (!seen.has(r.id)) { results.push(r); seen.add(r.id); }
        }
        results = results.slice(0, limit);
      }
      const sections: string[] = [];
      if (results.length > 0) {
        const lines = results.map((r, i) => `${i + 1}. [note ${r.id.slice(0, 8)}] (tags: ${r.tags.join(', ') || 'none'}) ${r.content.slice(0, 200)}`);
        sections.push(`Long-term notes (${results.length}):\n${lines.join('\n')}`);
      }

      // P13-A2 — Unified memory: also search the DOCUMENT CORPUS via the
      // agent's RetrievalService (semantic + keyword) so the model can
      // actively query uploaded documents mid-turn, not just notes.
      try {
        const agentAny = context.agent as unknown as {
          getRetrievalService?: () => {
            retrieve(q: string, o?: { topK?: number }): Promise<{
              results: Array<{ document_id?: string | null; chunk_id?: string | null; score?: number }>;
            }>;
          } | null;
          getDb?: () => unknown;
        };
        const rs = agentAny.getRetrievalService?.();
        if (rs && query) {
          const r = await rs.retrieve(query, { topK: Math.min(limit, 6) });
          if (r.results.length > 0) {
            const db = (context.agent as unknown as { getDb?: () => { prepare(sql: string): { get(...a: unknown[]): unknown } } }).getDb?.();
            const lines: string[] = [];
            for (const res of r.results.slice(0, 6)) {
              if (!res.document_id) continue;
              let title = res.document_id;
              let snippet = '';
              try {
                if (db) {
                  const doc = db.prepare('SELECT file_name, title FROM documents WHERE document_id = ?').get(res.document_id) as { file_name?: string; title?: string } | undefined;
                  title = doc?.title || doc?.file_name || res.document_id;
                  const ch = res.chunk_id
                    ? db.prepare('SELECT content FROM document_chunks WHERE chunk_id = ? LIMIT 1').get(res.chunk_id) as { content?: string } | undefined
                    : db.prepare('SELECT content FROM document_chunks WHERE document_id = ? LIMIT 1').get(res.document_id) as { content?: string } | undefined;
                  snippet = (ch?.content ?? '').replace(/\s+/g, ' ').slice(0, 200);
                }
              } catch { /* metadata best-effort */ }
              lines.push(`- [doc ${res.document_id}] ${title}${snippet ? `\n  excerpt: ${snippet}` : ''}`);
            }
            if (lines.length > 0) sections.push(`Documents (${lines.length}):\n${lines.join('\n')}`);
          }
        }
      } catch { /* corpus search best-effort */ }

      // P13-A2/B1 — Also search archived past conversations (semantic
      // when embeddings are available, keyword otherwise).
      try {
        const cc = (context.agent as unknown as {
          getContinuousContext?: () => {
            searchArchiveSemantic(q: string, n?: number): Promise<Array<{ role: string; content: string; kind: string }>>;
          } | null;
        }).getContinuousContext?.();
        if (cc && query) {
          const hits = await cc.searchArchiveSemantic(query, 3);
          if (hits.length > 0) {
            const lines = hits.map((h) => `- [${h.kind === 'summary' ? 'past session summary' : 'past ' + h.role}] ${h.content.replace(/\s+/g, ' ').slice(0, 180)}`);
            sections.push(`Past conversations (${hits.length}):\n${lines.join('\n')}`);
          }
        }
      } catch { /* archive best-effort */ }

      if (sections.length === 0) {
        return `[memory_search]: no matches for query='${query}' tags=[${tags.join(', ')}] across notes, documents, or past conversations`;
      }
      return `[memory_search]:\n${sections.join('\n\n')}`;
    } catch (e) {
      return `[memory_search error]: ${e instanceof Error ? e.message : String(e)}`;
    }
  },
};

export const currentTimeTool: Tool = {
  definition: {
    name: 'current_time',
    description: 'Get the current date and time',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  async execute() {
    return new Date().toISOString();
  },
};

export function getBuiltinTools(): Tool[] {
  return [shellTool, writeFileTool, memoryStoreTool, memorySearchTool, currentTimeTool];
}
