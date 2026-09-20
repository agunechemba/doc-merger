// sw.js
const CACHE_NAME = 'doc-merger-v1';
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './styles.css',
  './app.js'
];

// Install Service Worker and cache essential structural assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
});

// Activate handler to clean up old caches if versions change
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cache) => {
          if (cache !== CACHE_NAME) {
            return caches.delete(cache);
          }
        })
      );
    })
  );
});

// Network-first fetch strategy so updates to your code pull instantly when online
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});