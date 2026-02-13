const CACHE_NAME = 'workshop-v3';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    'https://cdn.jsdelivr.net/npm/pouchdb@8.0.1/dist/pouchdb.min.js',
    'https://unpkg.com/html5-qrcode',
    'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js'
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
    e.respondWith(caches.match(e.request).then((res) => res || fetch(e.request)));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys().then((keys) => {
        return Promise.all(keys.map((key) => {
            if (key !== CACHE_NAME) return caches.delete(key);
        }));
    }));
});