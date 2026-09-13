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

// The handler exists, and does nothing. That is the whole point.
//
// It used to be `event.respondWith(fetch(event.request))`, which reads like a
// no-op and is not one: calling respondWith takes the request AWAY from the
// browser and makes this worker answer it. The browser's own handling — its
// retries, its range requests, its connection reuse — is replaced by one bare
// fetch with no fallback, so a single blip fails the request outright.
//
// That is not theoretical. A deploy replaces index.html and the hashed assets
// together; load the page in that window and the stylesheet request can fail,
// and with respondWith in the way it fails hard rather than being retried. The
// result is the app rendering with no CSS at all — and because a service
// worker survives Ctrl+Shift+R, it stays broken until the worker is
// unregistered by hand.
//
// Returning without calling respondWith lets the request fall through to the
// browser untouched, which is what "network only" was always meant to be. The
// listener still counts for installability.
self.addEventListener('fetch', () => {})

// Tapping a notification brings the app back rather than opening a second copy.
//
// Android insists a page notification be shown through this worker rather than
// through `new Notification()` — so the click lands here, and without a
// handler it does nothing at all, which reads as a broken notification. Focus
// a tab that is already open; failing that, open one.
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) if ('focus' in c) return c.focus()
      return self.clients.openWindow ? self.clients.openWindow('/') : undefined
    })
  )
})
