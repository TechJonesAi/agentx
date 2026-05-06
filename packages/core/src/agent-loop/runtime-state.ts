/**
 * Backend Runtime State for Agent Loop
 * Tracks active agent loops and their state
 */

import type { AgentLoopState } from './agent-loop-types.js';

export interface RuntimeState {
  activeLoops: Map<string, AgentLoopState>;
  loopHistory: AgentLoopState[];
}

export class RuntimeStateStore {
  private state: RuntimeState = {
    activeLoops: new Map(),
    loopHistory: [],
  };

  private subscribers: Set<() => void> = new Set();

  /**
   * Add a new active loop
   */
  addActiveLoop(loopId: string, state: AgentLoopState): void {
    this.state.activeLoops.set(loopId, state);
    this.notifySubscribers();
  }

  /**
   * Update active loop state
   */
  updateActiveLoop(loopId: string, updates: Partial<AgentLoopState>): void {
    const current = this.state.activeLoops.get(loopId);
    if (current) {
      this.state.activeLoops.set(loopId, { ...current, ...updates });
      this.notifySubscribers();
    }
  }

  /**
   * Complete a loop (move from active to history)
   */
  completeLoop(loopId: string): void {
    const loop = this.state.activeLoops.get(loopId);
    if (loop) {
      this.state.activeLoops.delete(loopId);
      this.state.loopHistory.push(loop);
      this.notifySubscribers();
    }
  }

  /**
   * Get active loop by ID
   */
  getActiveLoop(loopId: string): AgentLoopState | undefined {
    return this.state.activeLoops.get(loopId);
  }

  /**
   * Get all active loops
   */
  getActiveLoops(): AgentLoopState[] {
    return Array.from(this.state.activeLoops.values());
  }

  /**
   * Get loop history
   */
  getHistory(): AgentLoopState[] {
    return [...this.state.loopHistory];
  }

  /**
   * Get full state
   */
  getState(): RuntimeState {
    return {
      activeLoops: new Map(this.state.activeLoops),
      loopHistory: [...this.state.loopHistory],
    };
  }

  /**
   * Subscribe to state changes
   */
  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  /**
   * Notify all subscribers
   */
  private notifySubscribers(): void {
    this.subscribers.forEach(callback => {
      try {
        callback();
      } catch (error) {
        console.error('Error in state subscriber:', error);
      }
    });
  }

  /**
   * Clear all state
   */
  clear(): void {
    this.state.activeLoops.clear();
    this.state.loopHistory = [];
    this.notifySubscribers();
  }
}

// Singleton instance
export const runtimeStateStore = new RuntimeStateStore();
