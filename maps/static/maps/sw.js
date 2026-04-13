const CACHE_NAME = 'nyc-essentials-v1.08';
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
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);
    const useNetworkFirst =
        url.origin === self.location.origin &&
        (
            url.pathname === '/' ||
            url.pathname === '/static/maps/js/map.js' ||
            url.pathname === '/static/maps/css/style.css'
        );

    if (useNetworkFirst) {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    if (response && response.status === 200) {
                        const copy = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, copy));
                    }
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then(response => response || fetch(event.request))
    );
});