// Service worker: lets phones install the dashboard as an app.
// It caches only the app shell (page, icon). Customer data and API calls are
// NEVER cached: they always come fresh from the server, so nothing private is
// left on the phone and you never see stale numbers.
// The cache's name (change the number to throw away old cached files).
const CACHE = 'ma-shell-v3';
// The files kept for offline use (the dashboard's scripts now live in their own files, so cache them too).
const SHELL = ['/admin', '/admin.js', '/theme-init.js', '/motion.js', '/icon.svg', '/manifest.webmanifest'];

// When the app is installed:
self.addEventListener('install', (e) => {
  // open the cache, store the shell files, then take over straight away.
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

// When a new version takes over:
self.addEventListener('activate', (e) => {
  // delete every older cache,
  e.waitUntil(
    // then control all open tabs right away.
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

// For every request the page makes:
self.addEventListener('fetch', (e) => {
  // the address being requested.
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return; // network only
  // Network first, falling back to the cached shell when offline.
  // Answer it ourselves:
  e.respondWith(
    // try the network first,
    fetch(e.request)
      // on success:
      .then((res) => {
        // if it's one of the shell files,
        if (res.ok && SHELL.includes(url.pathname)) {
          // copy the answer
          const copy = res.clone();
          // and refresh the cached copy.
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        // Hand the fresh answer to the page.
        return res;
      })
      // Offline: use the cached copy, or the cached dashboard as a last resort.
      .catch(() => caches.match(e.request).then((r) => r || caches.match('/admin')))
  );
});
