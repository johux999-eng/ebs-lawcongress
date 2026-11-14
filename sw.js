const CACHE_NAME = 'ebs-law-congress-v3';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './data.json',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  // CDN dependencies
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.23.9/babel.min.js',
  'https://cdn.tailwindcss.com'
];

// Install: Assets einzeln cachen, damit eine fehlende Datei nicht den gesamten Pre-Cache verhindert.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => Promise.all(ASSETS_TO_CACHE.map(url =>
        cache.add(url).catch(err => console.warn('[SW] Pre-cache fehlgeschlagen:', url, err))
      )))
      .then(() => self.skipWaiting())
  );
});

// Activate: alte Caches löschen
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(names => Promise.all(names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))))
      .then(() => self.clients.claim())
  );
});

function putInCache(request, response) {
  if (response && response.ok && request.method === 'GET') {
    const clone = response.clone();
    caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
  }
  return response;
}

// Network-first: für die App selbst und die synchronisierten Daten, damit Updates sofort ankommen.
function networkFirst(request, cacheKey) {
  return fetch(request)
    .then(res => putInCache(cacheKey || request, res))
    .catch(() => caches.match(cacheKey || request, { ignoreSearch: true })
      .then(cached => cached || caches.match('./index.html')));
}

// Cache-first mit Hintergrund-Aktualisierung: für Bibliotheken, Fonts, Bilder.
function staleWhileRevalidate(request) {
  return caches.match(request).then(cached => {
    const network = fetch(request).then(res => putInCache(request, res)).catch(() => cached);
    return cached || network;
  });
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;

  if (sameOrigin && url.pathname.endsWith('/data.json')) {
    // Ohne Query-String cachen, damit Offline-Fallback immer greift.
    event.respondWith(networkFirst(req, new Request(url.origin + url.pathname)));
    return;
  }
  if (req.mode === 'navigate' || (sameOrigin && url.pathname.endsWith('.html'))) {
    event.respondWith(networkFirst(req));
    return;
  }
  event.respondWith(staleWhileRevalidate(req));
});
