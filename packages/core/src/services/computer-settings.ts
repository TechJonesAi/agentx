/**
 * ComputerSettingsService — Real implementation.
 *
 * Manages computer control settings including allowed filesystem roots,
 * default action mode, and safety limits.
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('services:computer-settings');

export interface ComputerSettings {
  enabled: boolean;
  defaultMode: 'suggest' | 'supervised' | 'autonomous';
  maxActLoopSteps: number;
  screenshotDir: string;
  allowedRoots: string[];
}

const DEFAULT_SETTINGS: ComputerSettings = {
  enabled: true,
  defaultMode: 'suggest',
  maxActLoopSteps: 20,
  screenshotDir: path.join(os.tmpdir(), 'agentx-screenshots'),
  allowedRoots: [os.tmpdir()],
};

export class RealComputerSettingsService {
  private settings: ComputerSettings;

  constructor(overrides?: Partial<ComputerSettings>) {
    this.settings = { ...DEFAULT_SETTINGS, ...overrides };
    log.info({ settings: this.settings }, 'ComputerSettingsService initialized');
  }

  /** Get current settings. */
  get(_key?: string): ComputerSettings {
    return { ...this.settings };
  }

  /** Update settings (partial merge). */
  update(changes: Partial<ComputerSettings>): ComputerSettings {
    // Safety: never allow autonomous mode — keep SUGGEST_ONLY constraint
    if (changes.defaultMode === 'autonomous') {
      log.warn('Attempted to set autonomous mode — blocked, keeping suggest');
      changes.defaultMode = 'suggest';
    }
    Object.assign(this.settings, changes);
    log.info({ settings: this.settings }, 'Settings updated');
    return { ...this.settings };
  }

  /** Get allowed filesystem roots for computer actions. */
  getAllowedRoots(): string[] {
    return [...this.settings.allowedRoots];
  }

  /** Add a filesystem root. */
  addRoot(rootPath: string): string[] {
    const resolved = path.resolve(rootPath);
    if (this.settings.allowedRoots.includes(resolved)) {
      return this.getAllowedRoots();
    }
    this.settings.allowedRoots.push(resolved);
    log.info({ root: resolved }, 'Root added');
    return this.getAllowedRoots();
  }

  /** Remove a filesystem root. */
  removeRoot(rootPath: string): string[] {
    const resolved = path.resolve(rootPath);
    this.settings.allowedRoots = this.settings.allowedRoots.filter((r) => r !== resolved);
    log.info({ root: resolved }, 'Root removed');
    return this.getAllowedRoots();
  }
}
