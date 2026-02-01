/**
 * IPC (Inter-Process Communication) handlers for the Electron app.
 * Defines the channels and handlers that the renderer process can invoke.
 *
 * In the real Electron app, these are registered via ipcMain.handle().
 */

import { createLogger } from '@agentx/core';
import type { AgentBridge } from './agent-bridge.js';
import type { WindowManager } from './windows.js';

const log = createLogger('app:ipc');

export interface IpcContext {
  bridge: AgentBridge;
  windows: WindowManager;
}

/**
 * IPC Channel definitions for type-safe communication.
 */
export const IPC_CHANNELS = {
  // Chat
  CHAT_SEND: 'chat:send',
  CHAT_HISTORY: 'chat:history',

  // Agent
  AGENT_STATUS: 'agent:status',
  AGENT_HEALTH: 'agent:health',

  // Sessions
  SESSION_LIST: 'session:list',
  SESSION_DELETE: 'session:delete',

  // Skills
  SKILL_LIST: 'skill:list',

  // Config
  CONFIG_GET: 'config:get',
  CONFIG_UPDATE: 'config:update',

  // Window
  WINDOW_OPEN: 'window:open',
  WINDOW_CLOSE: 'window:close',
} as const;

type IpcHandler = (context: IpcContext, ...args: unknown[]) => Promise<unknown>;

const handlers: Record<string, IpcHandler> = {
  [IPC_CHANNELS.CHAT_SEND]: async (ctx, message: unknown, sessionId: unknown) => {
    return ctx.bridge.chat(message as string, sessionId as string | undefined);
  },

  [IPC_CHANNELS.AGENT_STATUS]: async (ctx) => {
    return ctx.bridge.getStatus();
  },

  [IPC_CHANNELS.AGENT_HEALTH]: async (ctx) => {
    return ctx.bridge.isReachable();
  },

  [IPC_CHANNELS.SESSION_LIST]: async (ctx) => {
    return ctx.bridge.listSessions();
  },

  [IPC_CHANNELS.SESSION_DELETE]: async (ctx, sessionKey: unknown) => {
    return ctx.bridge.deleteSession(sessionKey as string);
  },

  [IPC_CHANNELS.SKILL_LIST]: async (ctx) => {
    return ctx.bridge.listSkills();
  },

  [IPC_CHANNELS.CONFIG_GET]: async (ctx) => {
    return ctx.bridge.getConfig();
  },

  [IPC_CHANNELS.CONFIG_UPDATE]: async (ctx, updates: unknown) => {
    return ctx.bridge.updateConfig(updates as Record<string, unknown>);
  },

  [IPC_CHANNELS.WINDOW_OPEN]: async (ctx, windowType: unknown) => {
    return ctx.windows.openWindow(windowType as 'chat' | 'settings' | 'skills' | 'history');
  },

  [IPC_CHANNELS.WINDOW_CLOSE]: async (ctx, windowType: unknown) => {
    ctx.windows.closeWindow(windowType as 'chat' | 'settings' | 'skills' | 'history');
  },
};

/**
 * Register all IPC handlers.
 * In the real Electron app, this wires handlers to ipcMain.handle().
 */
export function registerIpcHandlers(context: IpcContext): Map<string, (...args: unknown[]) => Promise<unknown>> {
  const registered = new Map<string, (...args: unknown[]) => Promise<unknown>>();

  for (const [channel, handler] of Object.entries(handlers)) {
    const wrappedHandler = async (...args: unknown[]) => {
      try {
        return await handler(context, ...args);
      } catch (error) {
        log.error({ channel, error }, 'IPC handler error');
        throw error;
      }
    };
    registered.set(channel, wrappedHandler);
    log.debug({ channel }, 'IPC handler registered');
  }

  log.info({ count: registered.size }, 'All IPC handlers registered');
  return registered;
}
