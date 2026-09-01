const CACHE_NAME = 'car-balance-v19';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/src/styles.css',
  '/src/icons.js',
  '/src/toast.js',
  '/src/command-palette.js',
  '/src/hist-data.js',
  '/src/formula.js',
  '/src/app.js',
  '/assets/car.png',
  '/manifest.json'
];

// Cache-first for static assets
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    return new Response('Offline — request not cached', { status: 503 });
  }
}

// Network-first for cloud data (falls back to cache when offline)
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await caches.match(request);
    if (cached) return cached;
    return new Response('Offline — data unavailable', { status: 503 });
  }
}

// Install: precache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// Activate: purge old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: route by type
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Cloud data (Cloudflare Worker proxy) — network first
  if (url.hostname.includes('workers.dev')) {
    event.respondWith(networkFirst(event.request));
    return;
  }

  // CDN libraries — cache first (long-lived)
  if (
    url.hostname.includes('cdnjs.cloudflare.com') ||
    url.hostname.includes('cdn.jsdelivr.net')
  ) {
    event.respondWith(cacheFirst(event.request));
    return;
  }

  // App shell and local assets — cache first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
});
