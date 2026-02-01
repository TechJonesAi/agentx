import { EventEmitter } from 'eventemitter3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Skill, SkillManifest, Tool } from '@agentx/core';
import { createLogger, PermissionManager, type PermissionType } from '@agentx/core';

const log = createLogger('skills');

export interface SkillLoadResult {
  skill?: Skill;
  loaded: boolean;
  permissionsRequired: PermissionType[];
  permissionsGranted: boolean;
  error?: string;
}

export interface SkillManagerEvents {
  'skill:loaded': (name: string) => void;
  'skill:unloaded': (name: string) => void;
  'skill:reloaded': (name: string) => void;
  'skill:error': (name: string, error: Error) => void;
}

const UNLOAD_TIMEOUT_MS = 30_000;

export class SkillManager extends EventEmitter<SkillManagerEvents> {
  private skills = new Map<string, Skill>();
  private skillsDir: string;
  private permissionManager: PermissionManager | null = null;
  private permissionCallback: ((manifest: SkillManifest, missing: PermissionType[]) => Promise<boolean>) | null = null;

  // In-flight tool call tracking (Gap 4)
  private activeCallCounts = new Map<string, number>();
  private pendingReloads = new Map<string, () => void>();

  constructor(skillsDir: string) {
    super();
    this.skillsDir = skillsDir;
    if (!fs.existsSync(skillsDir)) {
      fs.mkdirSync(skillsDir, { recursive: true });
    }
  }

  setPermissionManager(pm: PermissionManager): void {
    this.permissionManager = pm;
  }

  /**
   * Set a callback that's invoked when a skill needs permissions approved.
   * Return true to grant, false to deny.
   */
  setPermissionCallback(cb: (manifest: SkillManifest, missing: PermissionType[]) => Promise<boolean>): void {
    this.permissionCallback = cb;
  }

  async loadAll(): Promise<SkillLoadResult[]> {
    if (!fs.existsSync(this.skillsDir)) return [];

    const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory());

    const results: SkillLoadResult[] = [];
    for (const entry of entries) {
      try {
        const result = await this.loadSkill(path.join(this.skillsDir, entry.name));
        results.push(result);
      } catch (error) {
        log.error({ skill: entry.name, error }, 'Failed to load skill');
        results.push({
          loaded: false,
          permissionsRequired: [],
          permissionsGranted: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return results;
  }

  async loadSkill(skillPath: string): Promise<SkillLoadResult> {
    const manifestPath = path.join(skillPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      log.warn({ path: skillPath }, 'No manifest.json found');
      return { loaded: false, permissionsRequired: [], permissionsGranted: false, error: 'No manifest.json' };
    }

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as SkillManifest;
    const requestedPerms = manifest.permissions as PermissionType[];

    // ─── Permission check ────────────────────────────────────────────────────
    if (this.permissionManager && requestedPerms.length > 0) {
      const missing = this.permissionManager.getMissingPermissions(manifest);

      if (missing.length > 0) {
        log.info({ skill: manifest.name, missing }, 'Skill requires permissions');

        const validation = this.permissionManager.validateManifest(manifest);
        if (!validation.valid) {
          log.error({ skill: manifest.name, invalid: validation.invalidPermissions }, 'Invalid permissions');
          return {
            loaded: false,
            permissionsRequired: requestedPerms,
            permissionsGranted: false,
            error: `Invalid permissions: ${validation.invalidPermissions.join(', ')}`,
          };
        }

        if (this.permissionCallback) {
          const approved = await this.permissionCallback(manifest, missing);
          if (!approved) {
            log.info({ skill: manifest.name }, 'Permissions denied by user');
            return {
              loaded: false,
              permissionsRequired: requestedPerms,
              permissionsGranted: false,
              error: 'Permissions denied by user',
            };
          }
          this.permissionManager.grantPermissions(manifest.name, requestedPerms);
        } else {
          log.warn({ skill: manifest.name, missing }, 'Skill blocked: no permission approval callback');
          return {
            loaded: false,
            permissionsRequired: requestedPerms,
            permissionsGranted: false,
            error: `Missing permissions: ${missing.join(', ')}. No approval mechanism configured.`,
          };
        }
      }
    }

    // ─── Load the skill code ─────────────────────────────────────────────────
    const mainPath = path.join(skillPath, 'index.js');
    if (!fs.existsSync(mainPath)) {
      log.warn({ skill: manifest.name }, 'No index.js found');
      return { loaded: false, permissionsRequired: requestedPerms, permissionsGranted: true, error: 'No index.js' };
    }

    const module = await import(mainPath);
    const skill: Skill = {
      manifest,
      tools: module.tools ?? [],
      onLoad: module.onLoad,
      onUnload: module.onUnload,
    };

    if (skill.onLoad) {
      await skill.onLoad();
    }

    this.skills.set(manifest.name, skill);
    this.emit('skill:loaded', manifest.name);
    log.info({ name: manifest.name, version: manifest.version, permissions: requestedPerms }, 'Skill loaded');

    return { skill, loaded: true, permissionsRequired: requestedPerms, permissionsGranted: true };
  }

  // ─── In-flight tool call protection ────────────────────────────────────────

  /**
   * Wrap a tool execution to track in-flight calls for a skill.
   * Prevents reload from happening while calls are in progress.
   */
  async trackToolCall<T>(skillName: string, fn: () => Promise<T>): Promise<T> {
    this.activeCallCounts.set(skillName, (this.activeCallCounts.get(skillName) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const count = (this.activeCallCounts.get(skillName) ?? 1) - 1;
      if (count <= 0) {
        this.activeCallCounts.delete(skillName);
        // If a reload was waiting, trigger it
        const pending = this.pendingReloads.get(skillName);
        if (pending) {
          this.pendingReloads.delete(skillName);
          pending();
        }
      } else {
        this.activeCallCounts.set(skillName, count);
      }
    }
  }

  getActiveCallCount(skillName: string): number {
    return this.activeCallCounts.get(skillName) ?? 0;
  }

  async unloadSkill(name: string): Promise<void> {
    const skill = this.skills.get(name);
    if (!skill) return;

    // Wait for in-flight calls to complete (with timeout)
    const activeCount = this.activeCallCounts.get(name) ?? 0;
    if (activeCount > 0) {
      log.info({ name, activeCount }, 'Waiting for in-flight tool calls before unloading');
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          log.warn({ name }, 'Force unloading skill after timeout');
          this.pendingReloads.delete(name);
          resolve();
        }, UNLOAD_TIMEOUT_MS);

        this.pendingReloads.set(name, () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    if (skill.onUnload) {
      await skill.onUnload();
    }

    this.skills.delete(name);
    this.emit('skill:unloaded', name);
    log.info({ name }, 'Skill unloaded');
  }

  getSkill(name: string): Skill | undefined {
    return this.skills.get(name);
  }

  getAllTools(): Tool[] {
    const tools: Tool[] = [];
    for (const skill of this.skills.values()) {
      tools.push(...skill.tools);
    }
    return tools;
  }

  listSkills(): SkillManifest[] {
    return Array.from(this.skills.values()).map((s) => s.manifest);
  }

  async reloadSkill(name: string): Promise<SkillLoadResult> {
    await this.unloadSkill(name);
    const result = await this.loadSkill(path.join(this.skillsDir, name));
    if (result.loaded) {
      this.emit('skill:reloaded', name);
    }
    return result;
  }

  getSkillsDir(): string {
    return this.skillsDir;
  }

  async reloadAll(): Promise<SkillLoadResult[]> {
    const names = Array.from(this.skills.keys());
    for (const name of names) {
      await this.unloadSkill(name);
    }
    return this.loadAll();
  }
}

// ─── Built-in web-search skill ───────────────────────────────────────────────

export const webSearchTool: Tool = {
  definition: {
    name: 'web_search',
    description: 'Search the web using DuckDuckGo (no API key required)',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        maxResults: { type: 'number', description: 'Maximum number of results (default 5)' },
      },
      required: ['query'],
    },
  },
  async execute(args) {
    const query = encodeURIComponent(args['query'] as string);
    const url = `https://html.duckduckgo.com/html/?q=${query}`;

    try {
      const response = await fetch(url, {
        headers: { 'User-Agent': 'AgentX/0.1' },
      });
      const html = await response.text();

      const results: string[] = [];
      const resultRegex = /<a[^>]*class="result__a"[^>]*>(.*?)<\/a>/gi;
      const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>(.*?)<\/a>/gi;

      let match;
      while ((match = resultRegex.exec(html)) !== null) {
        results.push(match[1]!.replace(/<[^>]*>/g, ''));
      }

      const snippets: string[] = [];
      while ((match = snippetRegex.exec(html)) !== null) {
        snippets.push(match[1]!.replace(/<[^>]*>/g, ''));
      }

      const maxResults = (args['maxResults'] as number) || 5;
      const output = results.slice(0, maxResults).map((title, i) => {
        const snippet = snippets[i] ?? '';
        return `${i + 1}. ${title}\n   ${snippet}`;
      }).join('\n\n');

      return output || 'No results found.';
    } catch (error) {
      return `Search failed: ${error instanceof Error ? error.message : error}`;
    }
  },
};

// Re-export watcher
export { SkillWatcher, type ReloadCallback } from './watcher.js';

// Re-export skill generator
export { SkillGenerator, createSkillGeneratorTool, type GeneratedSkill } from './generator.js';

export function getBuiltinSkills(): Skill[] {
  return [
    {
      manifest: {
        name: 'web-search',
        version: '0.1.0',
        description: 'Search the web using DuckDuckGo',
        triggers: ['search', 'find', 'look up'],
        permissions: ['network'],
      },
      tools: [webSearchTool],
    },
  ];
}
