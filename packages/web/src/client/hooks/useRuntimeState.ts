/**
 * Hook for subscribing to runtime state changes
 * Provides automatic re-renders when system state updates
 */

import { useEffect, useState } from 'react';
import { runtimeStore, type RuntimeState } from '../utils/runtime-store';

/**
 * Subscribe to all runtime state changes
 */
export function useRuntimeState(): RuntimeState {
  const [state, setState] = useState<RuntimeState>(() => runtimeStore.getState());

  useEffect(() => {
    const unsubscribe = runtimeStore.subscribe((newState) => {
      setState(newState);
    });

    return unsubscribe;
  }, []);

  return state;
}

/**
 * Get system health status
 */
export function useSystemHealth(): RuntimeState['systemHealth'] {
  const state = useRuntimeState();
  return state.systemHealth;
}

/**
 * Get active builds
 */
export function useActiveBuilds() {
  const state = useRuntimeState();
  return state.activeBuilds;
}

/**
 * Get active workflows
 */
export function useActiveWorkflows() {
  const state = useRuntimeState();
  return state.activeWorkflows;
}

/**
 * Get runtime metrics
 */
export function useRuntimeMetrics() {
  const state = useRuntimeState();
  return {
    systemHealth: state.systemHealth,
    activeBuilds: state.activeBuildCount,
    activeWorkflows: state.activeWorkflowCount,
    buildSuccessRate: state.buildSuccessRate,
    errorCount: state.errorCount,
    totalBuildsCompleted: state.totalBuildsCompleted,
    totalWorkflowsCompleted: state.totalWorkflowsCompleted,
  };
}

/**
 * Get recent errors
 */
export function useRecentErrors(limit = 10) {
  const [errors, setErrors] = useState(() => runtimeStore.getState().recentErrors.slice(0, limit));

  useEffect(() => {
    const unsubscribe = runtimeStore.subscribe((state) => {
      setErrors(state.recentErrors.slice(0, limit));
    });

    return unsubscribe;
  }, [limit]);

  return errors;
}
