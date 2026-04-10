// Mychat Service Worker — Offline-first caching for PWA
const CACHE_NAME = 'mychat-v7-cache-v1';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/chat.html',
  '/manifest.json',
  '/assets/brand/logo-icon.svg',
  '/assets/brand/logo.png',
  '/assets/css/main.css',
  '/assets/css/home.css',
  '/assets/css/chat.css',
  '/assets/css/anti-surveillance.css',
  '/assets/css/wallpaper.css',
  '/assets/js/config.js',
  '/assets/js/crypto.js',
  '/assets/js/rooms.js',
  '/assets/js/peer.js',
  '/assets/js/ui.js',
  '/assets/js/app.js',
  '/assets/js/contacts.js',
  '/assets/js/groups.js',
  '/assets/js/chat-store.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      // Cache static assets but don't block install if some fail (e.g. offline)
      return cache.addAll(STATIC_ASSETS).catch(err => {
        console.warn('[SW] Some assets failed to cache during install:', err);
      });
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Don't cache API requests, WebSocket connections, or PeerJS signaling
  if (
    url.pathname.startsWith('/api/') ||
    url.protocol === 'ws:' ||
    url.protocol === 'wss:' ||
    url.hostname.includes('peerjs') ||
    request.method !== 'GET'
  ) {
    return;
  }

  // Network-first for HTML pages (always get latest), cache-first for assets
  if (request.destination === 'document' || url.pathname.endsWith('.html')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
  } else {
    // Cache-first for CSS, JS, images, fonts
    event.respondWith(
      caches.match(request).then(cached => {
        if (cached) return cached;
        return fetch(request).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
          }
          return response;
        });
      })
    );
  }
});
