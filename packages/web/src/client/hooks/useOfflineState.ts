/**
 * Hook to track online/offline status
 * Provides network state and fallback detection
 */

import { useState, useEffect } from 'react';

export interface OfflineState {
  isOnline: boolean;
  hasBeenOffline: boolean;
  usingCache: boolean;
  lastOfflineTime?: Date;
}

export function useOfflineState(): OfflineState {
  const [state, setState] = useState<OfflineState>({
    isOnline: typeof navigator !== 'undefined' && navigator.onLine,
    hasBeenOffline: false,
    usingCache: false,
    lastOfflineTime: undefined,
  });

  useEffect(() => {
    // Handle online/offline events
    const handleOnline = () => {
      console.log('[Offline State] Online');
      setState((prev) => ({
        ...prev,
        isOnline: true,
      }));
    };

    const handleOffline = () => {
      console.log('[Offline State] Offline');
      setState((prev) => ({
        ...prev,
        isOnline: false,
        hasBeenOffline: true,
        lastOfflineTime: new Date(),
        usingCache: true,
      }));
    };

    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Also handle visibility changes (might reconnect while tab was hidden)
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        // Tab became visible, check connectivity
        const isOnline = navigator.onLine;
        setState((prev) => ({
          ...prev,
          isOnline,
        }));
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, []);

  return state;
}

/**
 * Hook for data fetching with offline support
 * Automatically falls back to cache when offline
 */
export function useDataWithOfflineFallback<T>(
  endpoint: string,
  options: {
    cacheTtl?: number;
    fallbackData?: T;
    skipCache?: boolean;
  } = {}
): {
  data: T | null;
  loading: boolean;
  error: Error | null;
  offline: boolean;
  fromCache: boolean;
} {
  const [data, setData] = useState<T | null>(options.fallbackData ?? null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [offline, setOffline] = useState(false);
  const [fromCache, setFromCache] = useState(false);

  const offlineState = useOfflineState();

  useEffect(() => {
    let isMounted = true;
    let controller: AbortController | null = new AbortController();

    const fetchData = async () => {
      try {
        setLoading(true);
        setError(null);

        const response = await fetch(endpoint, {
          signal: controller?.signal,
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        const responseData = await response.json() as T;

        if (isMounted) {
          setData(responseData);
          setOffline(false);
          setFromCache(false);
          setLoading(false);

          // Update cache
          if (!options.skipCache) {
            const { setCache } = await import('../utils/db-cache');
            setCache(endpoint, responseData, options.cacheTtl ?? 5 * 60 * 1000).catch(
              console.error
            );
          }
        }
      } catch (err) {
        if (isMounted && controller?.signal.aborted === false) {
          const error = err instanceof Error ? err : new Error(String(err));
          setError(error);

          // Try to load from cache
          if (!options.skipCache) {
            const { getCache } = await import('../utils/db-cache');
            const cached = await getCache(endpoint);

            if (cached) {
              setData(cached as T);
              setFromCache(true);
              setOffline(true);
              setLoading(false);
              console.log(`[Data Fetch] Using cached data for ${endpoint}`);
            } else {
              setOffline(true);
              setLoading(false);
            }
          } else {
            setOffline(true);
            setLoading(false);
          }
        }
      }
    };

    fetchData();

    return () => {
      isMounted = false;
      controller?.abort();
    };
  }, [endpoint, options]);

  return {
    data,
    loading,
    error,
    offline: offline || !offlineState.isOnline,
    fromCache,
  };
}
