/**
 * Build Session Manager — Tracks active build sessions across chat messages.
 *
 * When a user sends a vague build prompt, a BuildSession is created with
 * missing fields. Follow-up messages are checked against active sessions
 * to extract provided fields and resume execution deterministically.
 *
 * This replaces fragile "hope the LLM remembers" with explicit state.
 */

import { createLogger } from '../logger.js';

const log = createLogger('build:session');

export type BuildSessionStatus = 'awaiting_input' | 'ready' | 'running' | 'completed' | 'failed';

export interface BuildSession {
  id: string;
  chatSessionId: string;
  originalPrompt: string;
  status: BuildSessionStatus;
  missingFields: string[];
  collectedInputs: Record<string, string>;
  taskId?: string;
  createdAt: number;
  updatedAt: number;
}

const FIELD_EXTRACTORS: Record<string, (input: string) => string | null> = {
  'app/project name': (input: string) => {
    // Match: "app name: X", "called X", "named X", "name: X", "X" (if short quoted)
    const patterns = [
      /(?:app\s*name|project\s*name|name)\s*[:=]\s*["']?(\S+)["']?/i,
      /(?:called|named)\s+["']?(\S+)["']?/i,
      /^["']?([\w-]+(?:App)?)["']?\s*$/i,   // Standalone name like "LoveLink"
    ];
    for (const p of patterns) {
      const m = input.match(p);
      if (m) return m[1].replace(/['"]/g, '');
    }
    // If input is a short single word/phrase (likely an answer), use it
    const trimmed = input.trim();
    if (trimmed.length > 0 && trimmed.length < 40 && !trimmed.includes(' ') && /^[A-Za-z]/.test(trimmed)) {
      return trimmed;
    }
    return null;
  },

  'save location': (input: string) => {
    // Match: paths, "save to X", "in X", workspace references
    const patterns = [
      /(?:save\s*(?:to|in|at)|location|path|directory)\s*[:=]?\s*([\w/.~-]+\/[\w/.~-]*)/i,
      /(~\/[\w/.~-]+)/,
      /(\/Users\/[\w/.~-]+)/,
      /(\/tmp\/[\w/.~-]+)/,
      /(?:in|at|to)\s+([\w/.~-]+\/[\w/.~-]+)/i,
    ];
    for (const p of patterns) {
      const m = input.match(p);
      if (m) return m[1];
    }
    return null;
  },
};

export class BuildSessionManager {
  /** Active build sessions keyed by chatSessionId */
  private sessions = new Map<string, BuildSession>();

  /**
   * Create a new build session for a chat session.
   */
  createSession(chatSessionId: string, originalPrompt: string, missingFields: string[]): BuildSession {
    const session: BuildSession = {
      id: `build-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      chatSessionId,
      originalPrompt,
      status: 'awaiting_input',
      missingFields: [...missingFields],
      collectedInputs: {},
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(chatSessionId, session);
    log.info({ buildId: session.id, chatSessionId, missingFields }, 'Build session created');
    return session;
  }

  /**
   * Get the active build session for a chat session (if any).
   */
  getActiveSession(chatSessionId: string): BuildSession | null {
    const session = this.sessions.get(chatSessionId);
    if (!session) return null;
    if (session.status !== 'awaiting_input') return null;
    return session;
  }

  /**
   * Process a follow-up message and extract any provided fields.
   * Returns the updated session and whether all fields are now satisfied.
   */
  processFollowUp(chatSessionId: string, input: string): {
    session: BuildSession;
    newlyCollected: Record<string, string>;
    allFieldsSatisfied: boolean;
  } | null {
    const session = this.getActiveSession(chatSessionId);
    if (!session) return null;

    const newlyCollected: Record<string, string> = {};

    // Try to extract each still-missing field from the input
    for (const field of session.missingFields) {
      if (session.collectedInputs[field]) continue; // Already collected

      const extractor = FIELD_EXTRACTORS[field];
      if (extractor) {
        const value = extractor(input);
        if (value) {
          session.collectedInputs[field] = value;
          newlyCollected[field] = value;
        }
      }
    }

    // Update missing fields list
    session.missingFields = session.missingFields.filter(f => !session.collectedInputs[f]);
    session.updatedAt = Date.now();

    const allFieldsSatisfied = session.missingFields.length === 0;

    if (allFieldsSatisfied) {
      session.status = 'ready';
      log.info({ buildId: session.id, collectedInputs: session.collectedInputs }, 'Build session ready — all fields collected');
    } else {
      log.info({ buildId: session.id, newlyCollected, stillMissing: session.missingFields }, 'Build session updated — fields still missing');
    }

    return { session, newlyCollected, allFieldsSatisfied };
  }

  /**
   * Mark a session as running (execution started).
   */
  markRunning(chatSessionId: string, taskId?: string): void {
    const session = this.sessions.get(chatSessionId);
    if (session) {
      session.status = 'running';
      session.taskId = taskId;
      session.updatedAt = Date.now();
    }
  }

  /**
   * Mark a session as completed.
   */
  markCompleted(chatSessionId: string): void {
    const session = this.sessions.get(chatSessionId);
    if (session) {
      session.status = 'completed';
      session.updatedAt = Date.now();
    }
  }

  /**
   * Get all sessions (for diagnostics).
   */
  getAllSessions(): BuildSession[] {
    return Array.from(this.sessions.values());
  }

  getDiagnostics(): Record<string, unknown> {
    const all = this.getAllSessions();
    return {
      totalSessions: all.length,
      awaiting: all.filter(s => s.status === 'awaiting_input').length,
      ready: all.filter(s => s.status === 'ready').length,
      running: all.filter(s => s.status === 'running').length,
      completed: all.filter(s => s.status === 'completed').length,
    };
  }
}
