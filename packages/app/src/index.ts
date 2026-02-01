/**
 * AgentX Companion Desktop App
 *
 * Electron-based GUI for interacting with the AgentX agent.
 * Features:
 * - System tray with status indicator
 * - Global hotkey for quick chat (Cmd+Shift+A / Ctrl+Shift+A)
 * - Chat interface
 * - Settings panel
 * - Skills manager
 * - Session history browser
 */

export { AgentBridge, type AgentBridgeConfig } from './main/agent-bridge.js';
export { createTray, type TrayConfig } from './main/tray.js';
export { WindowManager } from './main/windows.js';
export { registerIpcHandlers } from './main/ipc.js';
