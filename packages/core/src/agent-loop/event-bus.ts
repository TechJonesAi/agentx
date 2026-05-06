/**
 * Backend Event Bus for Agent Loop
 * Simple in-memory pub/sub for core system events
 */

type EventHandler = (payload: unknown) => void | Promise<void>;

interface EventListener {
  handler: EventHandler;
  once: boolean;
}

export class EventBus {
  private listeners: Map<string, EventListener[]> = new Map();
  private history: Array<{ type: string; payload: unknown; timestamp: number }> = [];
  private maxHistorySize = 100;

  /**
   * Emit an event
   */
  emit(eventType: string, payload: unknown): void {
    // Add to history
    this.history.push({ type: eventType, payload, timestamp: Date.now() });
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    // Call listeners
    const listeners = this.listeners.get(eventType) || [];
    const toRemove: number[] = [];

    listeners.forEach((listener, index) => {
      try {
        listener.handler(payload);
        if (listener.once) {
          toRemove.push(index);
        }
      } catch (error) {
        console.error(`Error in event listener for ${eventType}:`, error);
      }
    });

    // Remove one-time listeners
    for (let i = toRemove.length - 1; i >= 0; i--) {
      listeners.splice(toRemove[i], 1);
    }
  }

  /**
   * Subscribe to an event
   */
  on(eventType: string, handler: EventHandler): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push({ handler, once: false });
  }

  /**
   * Subscribe once
   */
  once(eventType: string, handler: EventHandler): void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push({ handler, once: true });
  }

  /**
   * Unsubscribe from an event
   */
  off(eventType: string, handler: EventHandler): void {
    const listeners = this.listeners.get(eventType);
    if (listeners) {
      const index = listeners.findIndex(l => l.handler === handler);
      if (index >= 0) {
        listeners.splice(index, 1);
      }
    }
  }

  /**
   * Get event history
   */
  getHistory(eventType?: string, limit = 50) {
    let events = [...this.history];
    if (eventType) {
      events = events.filter(e => e.type === eventType);
    }
    return events.slice(-limit);
  }

  /**
   * Clear history
   */
  clear(): void {
    this.history = [];
  }
}

// Singleton instance
export const eventBus = new EventBus();
