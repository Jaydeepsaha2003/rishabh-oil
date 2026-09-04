// Minimal service worker — enough to make the app installable, and no more.
//
// Deliberately NOT a caching layer for the app shell. This is an ERP whose
// every screen reads live figures over /api/invoke; serving a stale bundle or
// a cached API response would show someone yesterday's stock and let them
// dispatch against it. So: network only, with the fetch handler present
// because installability requires one.
self.addEventListener('install', () => self.skipWaiting())

self.addEventListener('activate', (event) => {
  // Drop anything an earlier version of this worker may have cached, then take
  // over the open tabs so a deploy is never half-old, half-new.
  event.waitUntil(
    caches
      .keys()
      .then((names) => Promise.all(names.map((n) => caches.delete(n))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request))
})
