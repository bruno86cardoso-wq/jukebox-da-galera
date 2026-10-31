const CACHE_NAME = 'jukebox-cache-v3';
const STATIC_ASSETS = [
  '/',
  '/mobile.html',
  '/mobile.css',
  '/mobile.js',
  '/common.js',
  '/manifest.json',
  '/favicon.ico',
  '/favicon.png',
  '/favicon-32x32.png',
  '/icon-192.png',
  '/icon-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Não intercepta chamadas de outros domínios (YouTube, Google Fonts, etc.)
  if (url.origin !== self.location.origin) {
    return;
  }

  // Não intercepta chamadas de API, streaming de áudio/vídeo ou websockets
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/socket.io/') ||
    url.pathname.startsWith('/tv') ||
    event.request.method !== 'GET'
  ) {
    return;
  }

  // Estratégia Stale-While-Revalidate para o app carregar instantaneamente do cache:
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => cachedResponse);

      return cachedResponse || fetchPromise;
    })
  );
});
