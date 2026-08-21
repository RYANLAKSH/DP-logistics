/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'
import { registerRoute } from 'workbox-routing'
import { CacheFirst } from 'workbox-strategies'
import { ExpirationPlugin } from 'workbox-expiration'

declare const self: ServiceWorkerGlobalScope

/**
 * PHASE 7: app shell precache, plus the OCR engine cached on first use.
 *
 * Phase 13 adds the parts that matter operationally — a network-first strategy
 * for the day's assignments, an IndexedDB outbox drained through Background
 * Sync, and a navigation fallback to /offline. The worker is hand-written from
 * the start (injectManifest, not generateSW) precisely so that work is an
 * addition here rather than a migration then.
 */
precacheAndRoute(self.__WB_MANIFEST)

/**
 * The OCR engine: wasm core, worker script and language data.
 *
 * CacheFirst and never revalidated — these are version-pinned assets staged by
 * scripts/prepare-ocr.mjs, so a hit is always correct. Cached on first use
 * rather than precached, because only drivers load it and it is ~7 MB. Once a
 * driver has opened one task, the engine works for the rest of the shift with
 * no signal at all, which is the point.
 */
registerRoute(
  ({ url }) => url.pathname.startsWith('/ocr/'),
  new CacheFirst({
    cacheName: 'ocr-engine-v1',
    plugins: [new ExpirationPlugin({ maxEntries: 12, purgeOnQuotaError: false })],
  }),
)

self.addEventListener('message', (event) => {
  // The app prompts before applying an update: a worker that activates
  // mid-scan and reloads the page destroys an in-progress capture.
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})
