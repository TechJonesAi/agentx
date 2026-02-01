import { watch, type FSWatcher } from 'chokidar';
import * as path from 'node:path';
import { createLogger } from '@agentx/core';

const log = createLogger('skills:watcher');

export type ReloadCallback = (skillName: string) => Promise<void>;

export class SkillWatcher {
  private watcher: FSWatcher | null = null;
  private skillsDir: string;
  private onReload: ReloadCallback;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private debounceMs: number;

  constructor(skillsDir: string, onReload: ReloadCallback, debounceMs = 500) {
    this.skillsDir = skillsDir;
    this.onReload = onReload;
    this.debounceMs = debounceMs;
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = watch(this.skillsDir, {
      ignored: /node_modules/,
      persistent: true,
      ignoreInitial: true,
      depth: 3,
    });

    this.watcher.on('change', (filePath: string) => {
      this.handleChange(filePath);
    });

    this.watcher.on('add', (filePath: string) => {
      this.handleChange(filePath);
    });

    this.watcher.on('error', (error: unknown) => {
      const msg = error instanceof Error ? error.message : String(error);
      log.error({ error: msg }, 'Skill watcher error');
    });

    log.info({ skillsDir: this.skillsDir }, 'Skill watcher started');
  }

  private handleChange(filePath: string): void {
    const skillName = this.extractSkillName(filePath);
    if (!skillName) return;

    // Debounce: multiple file changes in rapid succession trigger a single reload
    const existing = this.debounceTimers.get(skillName);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(
      skillName,
      setTimeout(() => {
        this.debounceTimers.delete(skillName);
        log.info({ skillName, filePath }, 'Skill file changed, reloading');
        this.onReload(skillName).catch((err) => {
          log.error({ skillName, error: err instanceof Error ? err.message : String(err) }, 'Skill reload failed');
        });
      }, this.debounceMs),
    );
  }

  private extractSkillName(filePath: string): string | null {
    const relative = path.relative(this.skillsDir, filePath);
    if (relative.startsWith('..')) return null;

    // First path segment is the skill directory name
    const parts = relative.split(path.sep);
    return parts[0] ?? null;
  }

  async stop(): Promise<void> {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
      log.info('Skill watcher stopped');
    }
  }

  isRunning(): boolean {
    return this.watcher !== null;
  }
}
