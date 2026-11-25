/* Offline shell: keeps a copy of the app's own files so the page still opens when the server is down.
   The network is always tried first, so a running server always wins. API calls are never cached here;
   the app keeps its own copy of the data in localStorage (see "offline fallback" in app.js). */
const CACHE = 'ucirp-shell-v1';
self.addEventListener('install', e => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(['./', 'styles.css', 'app.js', 'i18n.js', 'mapbase.js', 'city-algorithms.js', 'vendor/leaflet.js', 'vendor/chart.umd.js']).catch(() => { }))); });
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || (e.request.mode === 'navigate' ? caches.match('./') : Response.error()))));
});
