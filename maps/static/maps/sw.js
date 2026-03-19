const CACHE_NAME = 'nyc-essentials-v1';
const ASSETS = [
    '/',
    '/static/maps/css/style.css',
    '/static/maps/js/map.js',
    '/static/maps/favicon.svg',
    '/static/maps/manifest.json'
];

self.addEventListener('install', event => {
    event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(ASSETS)));
});

self.addEventListener('fetch', event => {
    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});