/// <reference lib="webworker" />
import { clientsClaim } from 'workbox-core'
import { precacheAndRoute, cleanupOutdatedCaches } from 'workbox-precaching'
import { registerRoute, NavigationRoute } from 'workbox-routing'
import { CacheFirst, NetworkFirst, NetworkOnly } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

declare const self: ServiceWorkerGlobalScope

/**
 * Caching tiers, matching docs/design/10.
 *
 * The rule behind all of it: OPERATIONAL screens cache, SUPERVISORY screens do
 * not. A driver acting on a five-minute-old task list is fine. A manager
 * acting on a five-minute-old exception queue is dangerous — they may believe
 * a truck has been stopped when it has not. So the board is network-only and
 * shows a disconnected state rather than stale numbers.
 */
cleanupOutdatedCaches()
precacheAndRoute(self.__WB_MANIFEST)

/**
 * Take control of the page that registered us, without waiting for a reload.
 *
 * Without this, a driver's FIRST session is uncontrolled: nothing is cached at
 * runtime, so the OCR engine is not stored and the first dead spot of the
 * shift stops them. Claiming is safe here because the only way an updated
 * worker ever activates is the explicit prompt — this never swaps the
 * controller out from under an in-progress scan.
 */
clientsClaim()

// ---------------------------------------------------------------- tier 1
// The OCR engine: version-pinned assets, so a cache hit is always correct.
// Cached on first use rather than precached, because only drivers load it and
// it is ~7 MB. After one task, the engine works for the rest of the shift with
// no signal at all.
registerRoute(
  ({ url }) => url.pathname.startsWith('/ocr/'),
  new CacheFirst({
    cacheName: 'ocr-engine-v1',
    plugins: [new ExpirationPlugin({ maxEntries: 12, purgeOnQuotaError: false })],
  }),
)

// ---------------------------------------------------------------- tier 2
// The driver's own work: task list and assignments. Network-first with a short
// timeout, falling back to cache, so a dead spot between container stacks does
// not stop a shift.
registerRoute(
  ({ url }) =>
    url.pathname.includes('/rest/v1/v_driver_tasks')
    || url.pathname.includes('/rest/v1/rpc/me'),
  new NetworkFirst({
    cacheName: 'driver-data-v1',
    networkTimeoutSeconds: 4,
    plugins: [new ExpirationPlugin({ maxEntries: 60, maxAgeSeconds: 24 * 60 * 60 })],
  }),
)

// ---------------------------------------------------------------- tier 4
// Everything else on the API is network-only, deliberately. A cached board or
// a cached exception queue is worse than an absent one.
registerRoute(
  ({ url }) => url.pathname.startsWith('/rest/v1/') || url.pathname.startsWith('/auth/v1/'),
  new NetworkOnly(),
)

// Evidence images are never cached on a device. They are the most sensitive
// data in the system and they belong in the private bucket, not in a phone's
// cache directory where a lost handset exposes them.
registerRoute(
  ({ url }) => url.pathname.includes('/storage/v1/'),
  new NetworkOnly(),
)

// An uncached navigation falls back to the app shell, which routes to /offline
// when it cannot reach anything.
registerRoute(new NavigationRoute(
  async ({ request }) => {
    try {
      return await fetch(request)
    } catch {
      const cache = await caches.open('workbox-precache-v2')
      const shell = await cache.match('/index.html', { ignoreSearch: true })
      return shell ?? Response.redirect('/offline', 302)
    }
  },
))

self.addEventListener('message', (event) => {
  // The app prompts before applying an update. A worker that activates
  // mid-scan and reloads the page destroys an in-progress capture, and the
  // driver has no idea why the photograph they just took has gone.
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})

/**
 * Background Sync: drain the outbox when connectivity returns, even if the app
 * has been closed.
 *
 * The worker cannot drain the queue itself — uploading evidence needs the
 * Supabase client and the user's session, which live in the page — so it wakes
 * any open client and asks it to sync. When there is no client, the periodic
 * drain in useOutbox picks it up on next open. Nothing is ever lost by this
 * being best-effort, because nothing is deleted until the server confirms it.
 */
self.addEventListener('sync', (event) => {
  const syncEvent = event as ExtendableEvent & { tag?: string }
  if (syncEvent.tag !== 'movement-outbox') return
  syncEvent.waitUntil((async () => {
    const clients = await self.clients.matchAll({ includeUncontrolled: true })
    for (const client of clients) client.postMessage({ type: 'DRAIN_OUTBOX' })
  })())
})
