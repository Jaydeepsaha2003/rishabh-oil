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
  // The page the notification is ABOUT, carried on the push payload. Landing
  // on the dashboard after tapping "3 bills mature this week" makes the person
  // go and find it themselves, which is most of the value gone.
  const page = (event.notification.data && event.notification.data.page) || ''
  const target = page ? '/' + String(page).replace(/^\/+/, '') : '/'
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          // Navigating an already-open tab beats opening a second copy of an
          // ERP — two tabs on the same books is how someone ends up entering
          // the same batch twice.
          if (page && 'navigate' in c) return c.navigate(target).then((w) => (w ? w.focus() : c.focus()))
          return c.focus()
        }
      }
      return self.clients.openWindow ? self.clients.openWindow(target) : undefined
    })
  )
})

// A PUSH — the notification that arrives with the app closed.
//
// This is the whole reason the worker is worth having on a phone. The push
// service wakes it with an encrypted payload the browser has already decrypted
// for us; showing a notification is not optional (the subscription was made
// userVisibleOnly), so a malformed payload still draws something rather than
// nothing, or the browser eventually revokes the permission.
self.addEventListener('push', (event) => {
  let data = {}
  try {
    data = event.data ? event.data.json() : {}
  } catch {
    data = { title: 'Rishabh Oil', body: event.data ? event.data.text() : '' }
  }
  const title = String(data.title || 'Rishabh Oil')
  event.waitUntil(
    self.registration.showNotification(title, {
      body: String(data.body || ''),
      tag: String(data.tag || 'rishabhoil'),
      icon: '/brand-default.png',
      badge: '/brand-default.png',
      // The page to open when it is tapped, carried through the click handler.
      data: { page: String(data.page || '') },
      renotify: true
    })
  )
})

// A subscription can be rotated by the browser without the user doing anything
// — a new endpoint for the same device. Re-subscribe with the same key and
// hand the new one back, or that phone quietly stops receiving.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const old = event.oldSubscription || (await self.registration.pushManager.getSubscription())
        const key = old && old.options && old.options.applicationServerKey
        if (!key) return
        const fresh = await self.registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: key
        })
        await fetch('/api/invoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            channel: 'push:subscribe',
            args: { subscription: fresh.toJSON(), userId: 0, ua: 'resubscribed' }
          })
        })
      } catch (e) {
        // Nothing to be done from here; the app re-subscribes on next open.
      }
    })()
  )
})
