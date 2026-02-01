/**
 * Obsidian Integration for AgentX
 *
 * Read, write, and search notes in an Obsidian vault.
 * Works directly with the filesystem — no Obsidian API needed.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type Agent, type Integration, type Tool, createLogger } from '@agentx/core';

const log = createLogger('integration:obsidian');

export interface ObsidianConfig {
  vaultPath: string;
  dailyNotesFolder?: string;
  dailyNoteFormat?: string; // YYYY-MM-DD
}

export interface NoteSearchResult {
  path: string;
  name: string;
  matchCount: number;
  excerpt: string;
}

export class ObsidianIntegration implements Integration {
  readonly name = 'obsidian';
  private agent: Agent;
  private config: ObsidianConfig;

  constructor(agent: Agent, config: ObsidianConfig) {
    this.agent = agent;
    this.config = config;

    if (!config.vaultPath) {
      throw new Error('Obsidian vault path is required');
    }
  }

  // ─── Note Operations ─────────────────────────────────────────────────────────

  async searchNotes(query: string): Promise<NoteSearchResult[]> {
    const results: NoteSearchResult[] = [];
    const searchTerms = query.toLowerCase().split(/\s+/);

    await this.walkDirectory(this.config.vaultPath, async (filePath) => {
      if (!filePath.endsWith('.md')) return;

      const content = fs.readFileSync(filePath, 'utf-8');
      const lower = content.toLowerCase();
      const matchCount = searchTerms.reduce((count, term) => {
        const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
        return count + (lower.match(regex)?.length ?? 0);
      }, 0);

      if (matchCount > 0) {
        // Find an excerpt around the first match
        const firstTermIdx = lower.indexOf(searchTerms[0]!);
        const excerptStart = Math.max(0, firstTermIdx - 50);
        const excerptEnd = Math.min(content.length, firstTermIdx + 150);
        const excerpt = content.slice(excerptStart, excerptEnd).replace(/\n/g, ' ').trim();

        results.push({
          path: path.relative(this.config.vaultPath, filePath),
          name: path.basename(filePath, '.md'),
          matchCount,
          excerpt: excerptStart > 0 ? `...${excerpt}...` : `${excerpt}...`,
        });
      }
    });

    // Sort by match count descending
    results.sort((a, b) => b.matchCount - a.matchCount);
    return results.slice(0, 20);
  }

  async readNote(notePath: string): Promise<string> {
    const fullPath = this.resolveNotePath(notePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Note not found: ${notePath}`);
    }
    return fs.readFileSync(fullPath, 'utf-8');
  }

  async createNote(notePath: string, content: string, frontmatter?: Record<string, unknown>): Promise<void> {
    const fullPath = this.resolveNotePath(notePath);
    const dir = path.dirname(fullPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let fileContent = '';
    if (frontmatter && Object.keys(frontmatter).length > 0) {
      const yamlLines = Object.entries(frontmatter).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
      fileContent = `---\n${yamlLines.join('\n')}\n---\n\n`;
    }
    fileContent += content;

    fs.writeFileSync(fullPath, fileContent);
    log.info({ notePath }, 'Note created');
  }

  async updateNote(notePath: string, content: string): Promise<void> {
    const fullPath = this.resolveNotePath(notePath);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Note not found: ${notePath}`);
    }
    fs.writeFileSync(fullPath, content);
    log.info({ notePath }, 'Note updated');
  }

  async appendToNote(notePath: string, content: string): Promise<void> {
    const fullPath = this.resolveNotePath(notePath);
    if (!fs.existsSync(fullPath)) {
      // Create the note if it doesn't exist
      await this.createNote(notePath, content);
      return;
    }
    fs.appendFileSync(fullPath, `\n${content}`);
    log.info({ notePath }, 'Content appended to note');
  }

  async getDailyNote(date?: Date): Promise<string | null> {
    const d = date ?? new Date();
    const noteName = this.formatDailyNoteName(d);
    const folder = this.config.dailyNotesFolder ?? 'daily';
    const notePath = path.join(folder, `${noteName}.md`);
    const fullPath = this.resolveNotePath(notePath);

    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, 'utf-8');
  }

  async appendToDailyNote(content: string, date?: Date): Promise<void> {
    const d = date ?? new Date();
    const noteName = this.formatDailyNoteName(d);
    const folder = this.config.dailyNotesFolder ?? 'daily';
    const notePath = path.join(folder, `${noteName}.md`);
    const fullPath = this.resolveNotePath(notePath);

    if (!fs.existsSync(fullPath)) {
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const header = `# ${d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}\n\n`;
      fs.writeFileSync(fullPath, header + content);
    } else {
      fs.appendFileSync(fullPath, `\n${content}`);
    }

    log.info({ notePath }, 'Appended to daily note');
  }

  async listNotes(folder?: string): Promise<string[]> {
    const targetDir = folder
      ? path.join(this.config.vaultPath, folder)
      : this.config.vaultPath;

    const notes: string[] = [];
    await this.walkDirectory(targetDir, async (filePath) => {
      if (filePath.endsWith('.md')) {
        notes.push(path.relative(this.config.vaultPath, filePath));
      }
    });

    return notes.sort();
  }

  async getBacklinks(notePath: string): Promise<string[]> {
    const noteName = path.basename(notePath, '.md');
    const backlinks: string[] = [];

    await this.walkDirectory(this.config.vaultPath, async (filePath) => {
      if (!filePath.endsWith('.md')) return;
      const relative = path.relative(this.config.vaultPath, filePath);
      if (relative === notePath) return;

      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes(`[[${noteName}]]`) || content.includes(`[[${notePath}]]`)) {
        backlinks.push(relative);
      }
    });

    return backlinks;
  }

  async getTags(): Promise<string[]> {
    const tags = new Set<string>();

    await this.walkDirectory(this.config.vaultPath, async (filePath) => {
      if (!filePath.endsWith('.md')) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      const tagMatches = content.match(/#[a-zA-Z][\w/-]*/g);
      if (tagMatches) {
        for (const tag of tagMatches) {
          tags.add(tag);
        }
      }
    });

    return Array.from(tags).sort();
  }

  async getNotesByTag(tag: string): Promise<string[]> {
    const normalizedTag = tag.startsWith('#') ? tag : `#${tag}`;
    const notes: string[] = [];

    await this.walkDirectory(this.config.vaultPath, async (filePath) => {
      if (!filePath.endsWith('.md')) return;
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes(normalizedTag)) {
        notes.push(path.relative(this.config.vaultPath, filePath));
      }
    });

    return notes;
  }

  // ─── Tools ───────────────────────────────────────────────────────────────────

  getTools(): Tool[] {
    return [
      {
        definition: {
          name: 'search_notes',
          description: 'Search notes in the Obsidian vault',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Search query' },
            },
            required: ['query'],
          },
        },
        execute: async (args) => {
          const results = await this.searchNotes(args['query'] as string);
          return JSON.stringify(results, null, 2);
        },
      },
      {
        definition: {
          name: 'read_note',
          description: 'Read a note from the Obsidian vault',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Note path relative to vault root' },
            },
            required: ['path'],
          },
        },
        execute: async (args) => {
          return this.readNote(args['path'] as string);
        },
      },
      {
        definition: {
          name: 'create_note',
          description: 'Create a new note in the Obsidian vault',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Note path (e.g. "projects/my-note.md")' },
              content: { type: 'string', description: 'Markdown content' },
            },
            required: ['path', 'content'],
          },
        },
        execute: async (args) => {
          await this.createNote(args['path'] as string, args['content'] as string);
          return `Note created at ${args['path']}`;
        },
      },
      {
        definition: {
          name: 'append_to_note',
          description: 'Append content to an existing note',
          parameters: {
            type: 'object',
            properties: {
              path: { type: 'string', description: 'Note path' },
              content: { type: 'string', description: 'Content to append' },
            },
            required: ['path', 'content'],
          },
        },
        execute: async (args) => {
          await this.appendToNote(args['path'] as string, args['content'] as string);
          return `Content appended to ${args['path']}`;
        },
      },
      {
        definition: {
          name: 'append_to_daily_note',
          description: 'Append content to today\'s daily note (creates it if needed)',
          parameters: {
            type: 'object',
            properties: {
              content: { type: 'string', description: 'Content to append' },
              date: { type: 'string', description: 'Optional date (ISO 8601, defaults to today)' },
            },
            required: ['content'],
          },
        },
        execute: async (args) => {
          const date = args['date'] ? new Date(args['date'] as string) : undefined;
          await this.appendToDailyNote(args['content'] as string, date);
          return 'Content added to daily note.';
        },
      },
      {
        definition: {
          name: 'list_notes',
          description: 'List notes in the Obsidian vault',
          parameters: {
            type: 'object',
            properties: {
              folder: { type: 'string', description: 'Optional subfolder to list' },
            },
          },
        },
        execute: async (args) => {
          const notes = await this.listNotes(args['folder'] as string | undefined);
          return JSON.stringify(notes, null, 2);
        },
      },
    ];
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private resolveNotePath(notePath: string): string {
    const resolved = path.resolve(this.config.vaultPath, notePath);
    // Security: ensure the resolved path is within the vault
    if (!resolved.startsWith(this.config.vaultPath)) {
      throw new Error('Path traversal detected: note path must be within the vault');
    }
    return resolved;
  }

  private formatDailyNoteName(date: Date): string {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    const format = this.config.dailyNoteFormat ?? 'YYYY-MM-DD';
    return format
      .replace('YYYY', year)
      .replace('MM', month)
      .replace('DD', day);
  }

  private async walkDirectory(dir: string, callback: (filePath: string) => Promise<void>): Promise<void> {
    if (!fs.existsSync(dir)) return;

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      // Skip hidden files/dirs and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walkDirectory(fullPath, callback);
      } else {
        await callback(fullPath);
      }
    }
  }

  // ─── Integration lifecycle ───────────────────────────────────────────────────

  async sendMessage(_target: string, _message: string): Promise<void> {
    // Not applicable for Obsidian
  }

  async start(): Promise<void> {
    if (!fs.existsSync(this.config.vaultPath)) {
      log.warn({ vaultPath: this.config.vaultPath }, 'Obsidian vault path does not exist');
    } else {
      const notes = await this.listNotes();
      log.info({ vaultPath: this.config.vaultPath, noteCount: notes.length }, 'Obsidian integration started');
    }
  }

  async stop(): Promise<void> {
    log.info('Obsidian integration stopped');
  }
}
