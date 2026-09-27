// Lets Split Costs open without signal once it's been installed or visited.
// Everything is fetched fresh when online (so updates show up straight away)
// and the last copy is used when offline. Trip data itself is kept on the
// device by Firestore, not here.

const CACHE = 'split-costs-v2';
const SHELL = [
  './', 'index.html', 'styles.css', 'app.js', 'settle.js', 'store.js', 'currency.js', 'photo.js',
  'categories.js', 'households.js', 'firebase-config.js', 'vendor/firebase/firebase-app.js',
  'vendor/firebase/firebase-firestore.js', 'manifest.webmanifest', 'icons/icon-192.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const cacheable = request.method === 'GET'
    && (url.origin === self.location.origin || url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com');
  if (!cacheable) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true })
        .then((hit) => hit || (request.mode === 'navigate' ? caches.match('index.html') : Response.error()))),
  );
});
