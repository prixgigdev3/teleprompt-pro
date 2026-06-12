// Service worker: network-first with cache fallback, so updates always win
// when online and the app shell still opens offline.
// (Voice tracking itself needs internet in Chrome — its recognition runs
// server-side — but scripts, settings, and auto-scroll mode work offline.)

const CACHE = 'teleprompt-pro-v3';
const SHELL = [
  './',
  './index.html',
  './css/style.css',
  './js/app.js',
  './js/prompter.js',
  './js/matcher.js',
  './js/speech.js',
  './js/store.js',
  './js/analysis.js',
  './assets/icon-192.png',
  './assets/icon-512.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || new URL(request.url).origin !== location.origin) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE).then((cache) => cache.put(request, copy));
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }))
  );
});
