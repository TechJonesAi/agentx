/**
 * Hook for subscribing to platform events
 * Provides type-safe event subscription in React components
 */

import { useEffect, useCallback, useRef } from 'react';
import { eventBus, type EventType, type EventPayload } from '../utils/event-bus';

/**
 * Subscribe to a single event type
 */
export function useEvent<T extends EventType>(
  eventType: T,
  handler: (payload: EventPayload) => void
): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const unsubscribe = eventBus.on(eventType, (payload: EventPayload) => {
      handlerRef.current(payload);
    });

    return unsubscribe;
  }, [eventType]);
}

/**
 * Subscribe to multiple event types
 */
export function useEvents(
  eventTypes: EventType[],
  handler: (eventType: EventType, payload: EventPayload) => void
): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const unsubscribers = eventTypes.map(eventType =>
      eventBus.on(eventType, (payload: EventPayload) => {
        handlerRef.current(eventType, payload);
      })
    );

    return () => {
      unsubscribers.forEach(unsubscribe => unsubscribe());
    };
  }, [eventTypes]);
}

/**
 * Subscribe to an event once
 */
export function useEventOnce<T extends EventType>(
  eventType: T,
  handler: (payload: EventPayload) => void
): void {
  const handlerRef = useRef(handler);

  useEffect(() => {
    handlerRef.current = handler;
  }, [handler]);

  useEffect(() => {
    const unsubscribe = eventBus.once(eventType, (payload: EventPayload) => {
      handlerRef.current(payload);
    });

    return unsubscribe;
  }, [eventType]);
}

/**
 * Get event history and subscribe to future events
 */
export function useEventHistory<T extends EventType>(
  eventType?: T,
  limit = 20
): EventPayload[] {
  const historyRef = useRef<EventPayload[]>([]);

  const updateHistory = useCallback(() => {
    const events = eventBus.getHistory(eventType, limit);
    historyRef.current = events.map(e => e.payload);
  }, [eventType, limit]);

  useEffect(() => {
    updateHistory();

    if (eventType) {
      const unsubscribe = eventBus.on(eventType, () => {
        updateHistory();
      });
      return unsubscribe;
    }
  }, [eventType, limit, updateHistory]);

  return historyRef.current;
}
