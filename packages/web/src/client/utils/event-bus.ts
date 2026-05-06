/**
 * Central Event Bus for AgentX Platform
 * Provides type-safe event emission and subscription
 *
 * Events:
 * - build.* : App generation pipeline events
 * - workflow.* : Workflow execution events
 * - memory.* : Learning memory updates
 * - tool.* : Tool execution events
 * - agent.* : Agent loop events
 * - system.* : System-level events
 */

export type EventType =
  // Build events
  | 'build.started'
  | 'build.completed'
  | 'build.failed'
  | 'build.progress'

  // Workflow events
  | 'workflow.started'
  | 'workflow.stage_changed'
  | 'workflow.completed'
  | 'workflow.failed'

  // Memory events
  | 'memory.updated'
  | 'memory.pattern_learned'
  | 'memory.pattern_applied'

  // Tool events
  | 'tool.executed'
  | 'tool.error'

  // Agent events
  | 'agent.action'
  | 'agent.reflection'
  | 'agent.goal_updated'

  // System events
  | 'system.warning'
  | 'system.error'
  | 'system.health_changed'
  | 'data.refreshed';

export interface BuildStartedEvent {
  buildId: string;
  platform: 'ios' | 'web' | 'python' | 'node';
  appName: string;
  timestamp: number;
}

export interface BuildCompletedEvent {
  buildId: string;
  duration: number;
  success: boolean;
  timestamp: number;
}

export interface BuildFailedEvent {
  buildId: string;
  error: string;
  failedAtStep: string;
  timestamp: number;
}

export interface BuildProgressEvent {
  buildId: string;
  step: string;
  progress: number; // 0-100
  timestamp: number;
}

export interface WorkflowStartedEvent {
  workflowId: string;
  name: string;
  stages: string[];
  timestamp: number;
}

export interface WorkflowStageChangedEvent {
  workflowId: string;
  stage: string;
  status: 'in_progress' | 'completed' | 'failed';
  timestamp: number;
}

export interface WorkflowCompletedEvent {
  workflowId: string;
  duration: number;
  timestamp: number;
}

export interface MemoryUpdatedEvent {
  type: 'pattern' | 'learning' | 'cache';
  summary: string;
  timestamp: number;
}

export interface ToolExecutedEvent {
  toolName: string;
  duration: number;
  success: boolean;
  timestamp: number;
}

export interface AgentActionEvent {
  action: string;
  context: Record<string, unknown>;
  timestamp: number;
}

export interface SystemWarningEvent {
  message: string;
  source: string;
  timestamp: number;
}

export interface SystemErrorEvent {
  message: string;
  source: string;
  stack?: string;
  timestamp: number;
}

export interface SystemHealthChangedEvent {
  status: 'healthy' | 'degraded' | 'offline';
  reason?: string;
  timestamp: number;
}

export interface DataRefreshedEvent {
  dataType: string;
  timestamp: number;
}

// Union of all event payloads
export type EventPayload =
  | BuildStartedEvent
  | BuildCompletedEvent
  | BuildFailedEvent
  | BuildProgressEvent
  | WorkflowStartedEvent
  | WorkflowStageChangedEvent
  | WorkflowCompletedEvent
  | MemoryUpdatedEvent
  | ToolExecutedEvent
  | AgentActionEvent
  | SystemWarningEvent
  | SystemErrorEvent
  | SystemHealthChangedEvent
  | DataRefreshedEvent
  | Record<string, unknown>;

export type EventHandler<T extends EventType = EventType> = (
  payload: EventPayload
) => void | Promise<void>;

/**
 * Central event bus for the platform
 * Allows components to emit and subscribe to events
 */
class EventBus {
  private listeners: Map<EventType, EventHandler[]> = new Map();
  private eventHistory: Array<{ type: EventType; payload: EventPayload; timestamp: number }> = [];
  private maxHistorySize = 100;

  /**
   * Subscribe to an event type
   */
  on<T extends EventType>(eventType: T, handler: EventHandler<T>): () => void {
    if (!this.listeners.has(eventType)) {
      this.listeners.set(eventType, []);
    }
    this.listeners.get(eventType)!.push(handler);

    // Return unsubscribe function
    return () => {
      const handlers = this.listeners.get(eventType);
      if (handlers) {
        const index = handlers.indexOf(handler);
        if (index > -1) {
          handlers.splice(index, 1);
        }
      }
    };
  }

  /**
   * Subscribe to an event once
   */
  once<T extends EventType>(eventType: T, handler: EventHandler<T>): () => void {
    const unsubscribe = this.on(eventType, (payload: EventPayload) => {
      handler(payload);
      unsubscribe();
    });
    return unsubscribe;
  }

  /**
   * Emit an event
   */
  emit<T extends EventType>(
    eventType: T,
    payload: EventPayload
  ): void {
    const handlers = this.listeners.get(eventType) || [];

    // Store in history
    this.eventHistory.push({ type: eventType, payload, timestamp: Date.now() });
    if (this.eventHistory.length > this.maxHistorySize) {
      this.eventHistory.shift();
    }

    // Call all handlers
    handlers.forEach(handler => {
      try {
        const result = handler(payload);
        if (result instanceof Promise) {
          result.catch(error => {
            console.error(`[EventBus] Error in handler for ${eventType}:`, error);
          });
        }
      } catch (error) {
        console.error(`[EventBus] Error in handler for ${eventType}:`, error);
      }
    });

    // Log event
    console.log(`[agentx:event] ${eventType}`, payload);
  }

  /**
   * Get recent events (for debugging/activity feed)
   */
  getHistory(eventType?: EventType, limit = 20): Array<{ type: EventType; payload: EventPayload; timestamp: number }> {
    let events = [...this.eventHistory];
    if (eventType) {
      events = events.filter(e => e.type === eventType);
    }
    return events.slice(-limit);
  }

  /**
   * Get all listeners for debugging
   */
  getStats(): { eventTypes: number; totalListeners: number; historySize: number } {
    let totalListeners = 0;
    this.listeners.forEach(handlers => {
      totalListeners += handlers.length;
    });

    return {
      eventTypes: this.listeners.size,
      totalListeners,
      historySize: this.eventHistory.length,
    };
  }

  /**
   * Clear all listeners (for testing)
   */
  clear(): void {
    this.listeners.clear();
    this.eventHistory = [];
  }
}

// Export singleton instance
export const eventBus = new EventBus();

// Also export the class for testing/mocking
export { EventBus };
