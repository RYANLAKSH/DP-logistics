/// <reference lib="webworker" />
import { precacheAndRoute } from 'workbox-precaching'

declare const self: ServiceWorkerGlobalScope

/**
 * PHASE 3: app shell precache only.
 *
 * Phase 13 adds the parts that matter operationally — a network-first strategy
 * for the day's assignments, an IndexedDB outbox drained through Background
 * Sync, and a navigation fallback to /offline. The service worker is
 * hand-written from the start (injectManifest, not generateSW) precisely so
 * that work is an addition here rather than a migration then.
 */
precacheAndRoute(self.__WB_MANIFEST)

self.addEventListener('message', (event) => {
  // The app prompts before applying an update: a worker that activates
  // mid-scan and reloads the page destroys an in-progress capture.
  if (event.data?.type === 'SKIP_WAITING') void self.skipWaiting()
})
