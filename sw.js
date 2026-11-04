'use strict';
const CACHE_NAME = 'workshop-pro-shell-v4';
const APP_SHELL = [
  './', './index.html', './style.css', './app.js', './core.js',
  './config.js', './admin.html', './admin.css', './admin.js', './manifest.webmanifest', './icons/icon.svg'
];
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => {
      const copy = response.clone();
      const cacheKey = url.pathname.endsWith('/admin.html') ? './admin.html' : './index.html';
      caches.open(CACHE_NAME).then(cache => cache.put(cacheKey, copy));
      return response;
    }).catch(() => caches.match(new URL(event.request.url).pathname.endsWith('/admin.html') ? './admin.html' : './index.html')));
    return;
  }
  event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy)); }
    return response;
  })));
});
