/**
 * IndexedDB Cache Manager for AgentX Dashboard
 * Persists API responses for offline access and faster loading
 */

const DB_NAME = 'agentx-dashboard';
const DB_VERSION = 1;
const STORE_NAME = 'api-cache';

interface CacheEntry {
  key: string;
  data: unknown;
  timestamp: number;
  ttl: number; // time-to-live in milliseconds
}

let db: IDBDatabase | null = null;

/**
 * Initialize the database
 */
export async function initDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[DB Cache] Failed to open database');
      reject(request.error);
    };

    request.onsuccess = () => {
      db = request.result;
      console.log('[DB Cache] Database initialized');
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const database = (event.target as IDBOpenDBRequest).result;

      if (!database.objectStoreNames.contains(STORE_NAME)) {
        const store = database.createObjectStore(STORE_NAME, { keyPath: 'key' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        console.log('[DB Cache] Object store created');
      }
    };
  });
}

/**
 * Store data in cache with TTL
 */
export async function setCache(
  key: string,
  data: unknown,
  ttlMs: number = 5 * 60 * 1000 // 5 minutes default
): Promise<void> {
  const database = db || (await initDB());

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const entry: CacheEntry = {
      key,
      data,
      timestamp: Date.now(),
      ttl: ttlMs,
    };

    const request = store.put(entry);

    request.onerror = () => {
      console.error(`[DB Cache] Failed to cache ${key}`);
      reject(request.error);
    };

    request.onsuccess = () => {
      console.log(`[DB Cache] Cached ${key} (TTL: ${ttlMs}ms)`);
      resolve();
    };
  });
}

/**
 * Retrieve data from cache if not expired
 */
export async function getCache(key: string): Promise<unknown | null> {
  const database = db || (await initDB());

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(key);

    request.onerror = () => {
      console.error(`[DB Cache] Failed to retrieve ${key}`);
      reject(request.error);
    };

    request.onsuccess = () => {
      const entry = request.result as CacheEntry | undefined;

      if (!entry) {
        resolve(null);
        return;
      }

      // Check if expired
      const now = Date.now();
      const age = now - entry.timestamp;

      if (age > entry.ttl) {
        console.log(`[DB Cache] Cache expired for ${key} (age: ${age}ms, TTL: ${entry.ttl}ms)`);
        // Delete expired entry
        deleteCache(key).catch(console.error);
        resolve(null);
        return;
      }

      console.log(`[DB Cache] Retrieved ${key} from cache (age: ${age}ms)`);
      resolve(entry.data);
    };
  });
}

/**
 * Delete specific cache entry
 */
export async function deleteCache(key: string): Promise<void> {
  const database = db || (await initDB());

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.delete(key);

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      console.log(`[DB Cache] Deleted ${key}`);
      resolve();
    };
  });
}

/**
 * Clear all cache entries
 */
export async function clearCache(): Promise<void> {
  const database = db || (await initDB());

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readwrite');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.clear();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      console.log('[DB Cache] All cache cleared');
      resolve();
    };
  });
}

/**
 * Get all cache entries (for debugging)
 */
export async function getAllCache(): Promise<CacheEntry[]> {
  const database = db || (await initDB());

  return new Promise((resolve, reject) => {
    const transaction = database.transaction([STORE_NAME], 'readonly');
    const store = transaction.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      resolve(request.result as CacheEntry[]);
    };
  });
}

/**
 * Get cache statistics (size, count, expired entries)
 */
export async function getCacheStats(): Promise<{
  count: number;
  expired: number;
  totalSize: number;
}> {
  const entries = await getAllCache();
  const now = Date.now();

  let totalSize = 0;
  let expired = 0;

  entries.forEach((entry) => {
    const age = now - entry.timestamp;
    if (age > entry.ttl) {
      expired++;
    }
    totalSize += JSON.stringify(entry).length;
  });

  return {
    count: entries.length,
    expired,
    totalSize,
  };
}
