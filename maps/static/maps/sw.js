const CACHE_NAME = 'nyc-essentials-v1.06';
const ASSETS = [
    '/',
    '/static/maps/css/style.css',
    '/static/maps/js/map.js',
    '/static/maps/android-chrome-192x192.png',
    '/static/maps/android-chrome-512x512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(keys => {
            return Promise.all(
                keys.map(key => {
                    if (key !== CACHE_NAME) return caches.delete(key);
                })
            );
        })
    );
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});