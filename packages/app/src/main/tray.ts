/**
 * System tray management for the AgentX companion app.
 *
 * Note: Actual Electron Tray/Menu creation requires the electron runtime.
 * This module provides the configuration and logic; the Electron main
 * process entry point wires it to the real Tray API.
 */

import { createLogger } from '@agentx/core';

const log = createLogger('app:tray');

export type TrayStatus = 'online' | 'busy' | 'offline';

export interface TrayConfig {
  agentName: string;
  onChat: () => void;
  onSettings: () => void;
  onSkills: () => void;
  onHistory: () => void;
  onQuit: () => void;
}

export interface TrayMenuEntry {
  label: string;
  type?: 'normal' | 'separator';
  enabled?: boolean;
  click?: () => void;
}

/**
 * Build the tray context menu entries.
 */
export function buildTrayMenu(config: TrayConfig, status: TrayStatus): TrayMenuEntry[] {
  const statusLabel = status === 'online' ? '🟢 Online' : status === 'busy' ? '🟡 Busy' : '🔴 Offline';

  return [
    { label: `${config.agentName} — ${statusLabel}`, enabled: false },
    { type: 'separator', label: '' },
    { label: 'Open Chat', click: config.onChat },
    { label: 'Settings', click: config.onSettings },
    { label: 'Skills Manager', click: config.onSkills },
    { label: 'Session History', click: config.onHistory },
    { type: 'separator', label: '' },
    { label: 'Quit', click: config.onQuit },
  ];
}

/**
 * Create the tray — returns a controller for updating status.
 * In the real Electron app, this would create an actual Tray instance.
 */
export function createTray(config: TrayConfig): {
  updateStatus: (status: TrayStatus) => void;
  getMenu: () => TrayMenuEntry[];
  destroy: () => void;
} {
  let currentStatus: TrayStatus = 'offline';

  log.info({ agentName: config.agentName }, 'Tray created');

  return {
    updateStatus(status: TrayStatus) {
      currentStatus = status;
      log.debug({ status }, 'Tray status updated');
    },
    getMenu() {
      return buildTrayMenu(config, currentStatus);
    },
    destroy() {
      log.info('Tray destroyed');
    },
  };
}

/**
 * Global hotkey configuration.
 * In the real Electron app, this is registered via globalShortcut.register().
 */
export const GLOBAL_HOTKEY = {
  darwin: 'CommandOrControl+Shift+A',
  win32: 'Ctrl+Shift+A',
  linux: 'Ctrl+Shift+A',
} as const;
