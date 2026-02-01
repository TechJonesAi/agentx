/**
 * Window management for the AgentX Electron app.
 * Manages creation and lifecycle of app windows.
 */

import { createLogger } from '@agentx/core';

const log = createLogger('app:windows');

export type WindowType = 'chat' | 'settings' | 'skills' | 'history';

export interface WindowConfig {
  width: number;
  height: number;
  title: string;
  resizable: boolean;
  frame: boolean;
}

const WINDOW_CONFIGS: Record<WindowType, WindowConfig> = {
  chat: { width: 500, height: 700, title: 'AgentX Chat', resizable: true, frame: true },
  settings: { width: 600, height: 500, title: 'AgentX Settings', resizable: false, frame: true },
  skills: { width: 700, height: 500, title: 'Skills Manager', resizable: true, frame: true },
  history: { width: 800, height: 600, title: 'Session History', resizable: true, frame: true },
};

/**
 * WindowManager tracks window state and provides configuration.
 * In the real Electron app, this wraps BrowserWindow instances.
 */
export class WindowManager {
  private openWindows = new Map<WindowType, { id: number; focused: boolean }>();
  private nextId = 1;

  getConfig(type: WindowType): WindowConfig {
    return WINDOW_CONFIGS[type];
  }

  /**
   * Open or focus a window of the given type.
   * Returns the window ID.
   */
  openWindow(type: WindowType): number {
    const existing = this.openWindows.get(type);
    if (existing) {
      existing.focused = true;
      log.debug({ type, id: existing.id }, 'Focusing existing window');
      return existing.id;
    }

    const id = this.nextId++;
    this.openWindows.set(type, { id, focused: true });
    log.info({ type, id, config: WINDOW_CONFIGS[type] }, 'Window opened');
    return id;
  }

  closeWindow(type: WindowType): void {
    const existing = this.openWindows.get(type);
    if (existing) {
      this.openWindows.delete(type);
      log.info({ type, id: existing.id }, 'Window closed');
    }
  }

  isOpen(type: WindowType): boolean {
    return this.openWindows.has(type);
  }

  closeAll(): void {
    for (const [type] of this.openWindows) {
      this.closeWindow(type);
    }
  }

  getOpenWindows(): WindowType[] {
    return Array.from(this.openWindows.keys());
  }
}
