const CACHE_NAME = 'jukebox-cache-v21';
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
      // 'reload' ignora o cache do navegador e baixa a versão nova de verdade.
      return cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })));
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

  // Rede primeiro: com internet, o app sempre abre a versão mais nova.
  // A cópia guardada só é usada sem internet, para o app ainda abrir.
  event.respondWith(
    fetch(event.request, { cache: 'no-cache' }).then((networkResponse) => {
      if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
        const responseToCache = networkResponse.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseToCache));
      }
      return networkResponse;
    }).catch(() => caches.match(event.request, { ignoreSearch: true }))
  );
});
