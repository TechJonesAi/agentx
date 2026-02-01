/**
 * AgentBridge connects the Electron app to a running AgentX agent.
 * Communicates over a local HTTP/WebSocket connection or direct import.
 */

import { createLogger } from '@agentx/core';

const log = createLogger('app:bridge');

export interface AgentBridgeConfig {
  /** URL of the running agent API (default: http://localhost:3001) */
  agentUrl?: string;
  /** Use direct import instead of HTTP (for embedded mode) */
  embedded?: boolean;
}

export interface ChatResponse {
  response: string;
  sessionId: string;
}

export interface SessionInfo {
  id: string;
  key: string;
  updatedAt: string;
  channel?: string;
  room?: string;
}

export interface AgentStatus {
  running: boolean;
  agentName: string;
  model: string;
  activeSessions: number;
  uptime: number;
  integrations: string[];
}

export class AgentBridge {
  private config: AgentBridgeConfig;
  private baseUrl: string;

  constructor(config: AgentBridgeConfig = {}) {
    this.config = config;
    this.baseUrl = config.agentUrl ?? 'http://localhost:3001';
  }

  async chat(message: string, sessionId?: string): Promise<ChatResponse> {
    log.debug({ messageLength: message.length, sessionId }, 'Sending chat message');

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, sessionId }),
    });

    if (!response.ok) {
      throw new Error(`Agent API error: ${response.status} ${response.statusText}`);
    }

    return response.json() as Promise<ChatResponse>;
  }

  async getStatus(): Promise<AgentStatus> {
    const response = await fetch(`${this.baseUrl}/api/status`);
    if (!response.ok) {
      throw new Error(`Agent API error: ${response.status}`);
    }
    return response.json() as Promise<AgentStatus>;
  }

  async listSessions(): Promise<SessionInfo[]> {
    const response = await fetch(`${this.baseUrl}/api/sessions`);
    if (!response.ok) {
      throw new Error(`Agent API error: ${response.status}`);
    }
    return response.json() as Promise<SessionInfo[]>;
  }

  async deleteSession(sessionKey: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/sessions/${encodeURIComponent(sessionKey)}`, {
      method: 'DELETE',
    });
    if (!response.ok) {
      throw new Error(`Agent API error: ${response.status}`);
    }
  }

  async listSkills(): Promise<Array<{ name: string; version: string; description: string; enabled: boolean }>> {
    const response = await fetch(`${this.baseUrl}/api/skills`);
    if (!response.ok) {
      throw new Error(`Agent API error: ${response.status}`);
    }
    return response.json() as Promise<Array<{ name: string; version: string; description: string; enabled: boolean }>>;
  }

  async getConfig(): Promise<Record<string, unknown>> {
    const response = await fetch(`${this.baseUrl}/api/config`);
    if (!response.ok) {
      throw new Error(`Agent API error: ${response.status}`);
    }
    return response.json() as Promise<Record<string, unknown>>;
  }

  async updateConfig(updates: Record<string, unknown>): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    });
    if (!response.ok) {
      throw new Error(`Agent API error: ${response.status}`);
    }
  }

  async isReachable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
