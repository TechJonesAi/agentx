/**
 * Service Worker for AgentX Dashboard
 *
 * Caching rules:
 *   - Hashed assets (/assets/*): cache-first (immutable, content-addressed)
 *   - Everything else (HTML, unhashed JS, API): network-first
 *   - index.html and unhashed JS are NEVER cache-first
 *
 * Cache versioning:
 *   - __BUILD_ID__ is injected by Vite at build time
 *   - Every build creates a new cache namespace
 *   - Old caches are deleted on activate
 */

declare const self: ServiceWorkerGlobalScope;
declare const __BUILD_ID__: string;

const CACHE_VERSION = `agentx-${typeof __BUILD_ID__ !== 'undefined' ? __BUILD_ID__ : 'dev'}`;
const STATIC_CACHE = `${CACHE_VERSION}-static`;
const API_CACHE = `${CACHE_VERSION}-api`;

// Only pre-cache the app shell — JS bundles are hashed and cached on first fetch
const STATIC_ASSETS = [
  '/',
  '/index.html',
];

// API endpoints that should be cached for offline use
const CACHEABLE_API = [
  '/api/status',
  '/api/sessions',
  '/api/builder/stats',
  '/api/projects',
  '/api/build-memory/stats',
  '/api/tools',
  '/api/logs',
  '/api/config',
  '/api/skills',
];

// Install event - cache app shell only
self.addEventListener('install', (event: ExtendableEvent) => {
  console.log(`[Service Worker] Installing (build: ${CACHE_VERSION})...`);
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(STATIC_ASSETS).catch(() => {
        console.log('[Service Worker] Some static assets not found, continuing...');
      });
    }).then(() => {
      self.skipWaiting();
    })
  );
});

// Activate event - clean up old caches and notify clients
self.addEventListener('activate', (event: ExtendableEvent) => {
  console.log(`[Service Worker] Activating (build: ${CACHE_VERSION})...`);
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (!cacheName.startsWith(CACHE_VERSION)) {
            console.log(`[Service Worker] Deleting old cache: ${cacheName}`);
            return caches.delete(cacheName);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    }).then(() => {
      // Notify all clients that a new version is available
      return self.clients.matchAll().then(clients => {
        clients.forEach(client => client.postMessage({ type: 'SW_UPDATED', build: CACHE_VERSION }));
      });
    })
  );
});

// Fetch event
self.addEventListener('fetch', (event: FetchEvent) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // Skip chrome extensions and external requests
  if (url.protocol === 'chrome-extension:' || url.origin !== self.location.origin) {
    return;
  }

  // API requests - network-first with cache fallback
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkFirstStrategy(request));
    return;
  }

  // ONLY hashed assets (/assets/*) use cache-first — they are content-addressed and immutable
  if (url.pathname.startsWith('/assets/')) {
    event.respondWith(cacheFirstStrategy(request));
    return;
  }

  // Everything else (HTML, unhashed JS, service-worker.js) - ALWAYS network-first
  event.respondWith(networkFirstStrategy(request));
});

/**
 * Network-first strategy: Try network, fallback to cache
 */
async function networkFirstStrategy(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);

    if (response.ok) {
      const url = new URL(request.url);

      // Cache successful API responses
      if (CACHEABLE_API.some(api => url.pathname === api)) {
        const cache = await caches.open(API_CACHE);
        cache.put(request, response.clone());
      }

      // Cache HTML and unhashed JS for offline fallback only
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.endsWith('.js')) {
        const cache = await caches.open(STATIC_CACHE);
        cache.put(request, response.clone());
      }
    }

    return response;
  } catch (error) {
    // Network failed, try cache
    const cached = await caches.match(request);
    if (cached) {
      console.log(`[Service Worker] Serving from cache: ${request.url}`);
      return cached;
    }

    return new Response(
      JSON.stringify({
        error: 'offline',
        message: 'No network connection and no cached data available',
        offline: true,
      }),
      {
        status: 503,
        statusText: 'Service Unavailable',
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}

/**
 * Cache-first strategy: Try cache first, fallback to network
 * ONLY used for hashed /assets/* files that are immutable.
 */
async function cacheFirstStrategy(request: Request): Promise<Response> {
  const cached = await caches.match(request);
  if (cached) {
    return cached;
  }

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone());
    }
    return response;
  } catch (error) {
    return new Response('Offline', {
      status: 503,
      statusText: 'Service Unavailable',
    });
  }
}

// Message handler for cache updates
self.addEventListener('message', (event: ExtendableMessageEvent) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  if (event.data?.type === 'CLEAR_CACHE') {
    caches.keys().then((names) => {
      names.forEach((name) => caches.delete(name));
    });
  }

  if (event.data?.type === 'CHECK_UPDATE') {
    self.registration.update();
  }
});

export {};
