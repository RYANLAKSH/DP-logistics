# 10 — Offline and PWA Strategy

## 1. The honest constraint

A driver in a container yard walks between stacked steel boxes. Signal disappears. The app
has to keep working — but the verification authority is on the server (§02 §3), and no
amount of offline engineering can move it to the phone without destroying the control.

So the design separates two things people usually conflate:

| | Can it work offline? |
|---|---|
| Seeing the assignment | **Yes** — cached |
| Capturing evidence | **Yes** — local |
| Getting an advisory verdict | **Yes** — shared-rules against the cached manifest |
| Being **told** the movement is complete | **No.** That requires the server |

The driver gets everything except the last one, and the UI is explicit about the difference.
A movement submitted offline shows as **PENDING SYNC**, never as VERIFIED. Displaying a
green tick for something the server has not accepted would be the single worst design error
available in this product — it would train drivers to trust a screen that can be wrong.

## 2. Caching tiers

| Tier | What | Strategy | Lifetime |
|---|---|---|---|
| 0 | App shell — HTML, JS, CSS, fonts, icons | Precache, cache-first | Until the next deploy |
| 1 | OCR assets — WASM + traineddata (~4 MB) | Precache on install, driver role only | Version-pinned |
| 2 | Today's manifest for the driver's yards | Network-first, cache fallback, refresh on focus and every 5 min | Until end of operating day |
| 3 | Captured images and queued movements | IndexedDB, never evicted until synced | Until confirmed by the server |
| 4 | Supervisor/admin data | **Not cached** | — |

Tier 4 is a decision, not an oversight. A supervisor looking at a stale exception queue may
believe a truck has been stopped when it has not. An absent board is safe; a stale board is
dangerous. Supervisory screens show a disconnected state instead.

## 3. Service worker

`vite-plugin-pwa` in `injectManifest` mode — a generated service worker cannot express the
outbox below.

```
sw.ts
 ├── precacheAndRoute(self.__WB_MANIFEST)         // tier 0
 ├── route /ocr/*            CacheFirst           // tier 1
 ├── route supabase /rest/v1/v_driver_tasks*
 │                           NetworkFirst, 3s timeout, fallback cache   // tier 2
 ├── route supabase everything else  NetworkOnly  // tier 4: never serve stale
 ├── BackgroundSync queue 'movement-outbox'
 └── navigation fallback → /offline
```

Update policy: prompt, do not auto-reload. A service worker that activates mid-scan and
reloads the page destroys an in-progress capture. On a new version, show a non-blocking
"Update available" bar; apply it when the driver is idle on the task list, never inside the
scan flow. Force an update only for a security release, via a version gate the server can
set.

## 4. The outbox

IndexedDB (Dexie). The queue is the offline story.

```
outbox: {
  id,                    // = movement id, client-generated. THE idempotency key
  assignmentId,
  scannedContainerNo, scannedChassisNo,
  clientVerdict,
  images: [{ kind, blob, sha256, phash, ocrTextRaw, confidence, source }],
  gps, submittedAtDevice, deviceKey, appVersion,
  attempts, lastError, lastAttemptAt,
  state: 'queued' | 'uploading' | 'verifying' | 'confirmed' | 'rejected' | 'conflict'
}
```

Drain order per item — strictly sequential, because verification must not run before its
evidence exists:

```
1. upload images   → signed URL per image, resumable, retried individually
2. register_scan   → one RPC per image
3. verify_movement → the RPC
4. on success  → state 'confirmed', delete blobs, keep the record for the shift
   on business failure (mismatch) → state 'rejected', show the driver the real verdict
   on transport failure → backoff, retry
```

Retry: exponential backoff 2s, 4s, 8s, 16s, 30s, then every 60s while online. Never drop an
item automatically. An item that has failed 10 times surfaces on `/drive/sync` with the
error and a manual retry, and after 24 hours it raises an exception for a supervisor — a
movement that never synced is an operational problem, not a client-side cleanup task.

**Blobs are the storage risk.** Two images per movement at ~250 KB, 32 movements a shift, is
~16 MB — fine. A week of failed syncs is not. Warn at 100 MB, and block new captures at
200 MB with a message to find signal, because silently failing to store evidence is worse
than refusing to start.

## 5. Idempotency and duplicate submission

The movement id is generated on the device when the driver claims the task, and it is the
primary key. `verify_movement()` upserts on it.

That makes every one of these safe:

- Double-tap on submit → same id, second call returns the first result.
- Network timeout after the server committed → retry returns the existing outcome.
- App killed mid-sync and restarted → outbox replays, same id, no duplicate.
- Background Sync fires twice → same id.

The RPC's contract: **calling it twice with the same movement id and the same scanned values
returns the original outcome and changes nothing.** Calling it with the same id and
*different* scanned values is not a retry — it is either a bug or an attack, and it raises an
exception rather than overwriting.

## 6. Stale manifest — the unavoidable failure mode

An offline driver working from a cache that was superseded an hour ago can get an advisory
PASS and a server MISMATCH. This cannot be eliminated without connectivity. It can only be
made loud:

- Every cached manifest carries its `manifest_version_id`. The RPC compares it to the active
  version and returns `manifest_superseded` rather than verifying against stale data.
- The driver's screen says: *"The manifest changed. Sync before continuing — 3 of your
  remaining tasks have changed."*
- On reconnect, the app diffs the cached manifest against the new active version and shows
  the affected tasks before the driver walks to the next vehicle.
- A superseded-version submission raises a supervisor exception, because a vehicle may
  already have been physically moved.

Mitigation that costs little and helps a lot: **sync on shift start is mandatory.** The app
refuses to enter the task flow with no manifest cached, or with one cached more than 12
hours ago, until it has reached the server once. A driver who never syncs is the worst case,
and one forced sync at shift start removes most of it.

## 7. What cannot be done offline

Stated plainly, because the driver needs to know and the team needs to stop trying:

| Not available offline | Why |
|---|---|
| Confirmed verification | The server is the authority. Full stop |
| Override request/approval | Requires a second person's authenticated session |
| Device approval | Same |
| Claiming a task another driver may also claim | Requires the server's lock. Offline claims are provisional and can lose |
| Any supervisor or admin screen | Deliberate — see §2, tier 4 |
| Manifest sync | Obviously |

The task-claim conflict is real: two drivers offline may both claim the same assignment.
Resolution is server-side and first-write-wins; the loser's outbox item comes back as
`conflict`, and the driver is told the task was completed by someone else. It is rare — tasks
are handed out sequentially — but it must not silently produce two movements for one vehicle,
which is exactly what `unique (manifest_vehicle_id) where status in ('verified','overridden')`
prevents at the database level.

## 8. Install

- `manifest.webmanifest`: `display: standalone`, portrait, dark-on-light high-contrast theme,
  maskable icons.
- Custom install prompt on the driver's second session — not the first. A prompt before the
  app has proved useful gets dismissed permanently.
- iOS: no `beforeinstallprompt`. Show illustrated Share → Add to Home Screen instructions on
  iOS Safari. iOS 16.4+ for web push; below that supervisors get email only.
- Persistent storage: call `navigator.storage.persist()` on first driver login. Without it,
  iOS can evict IndexedDB — including unsynced evidence — under storage pressure. Check
  `navigator.storage.estimate()` on the sync screen and show it to the driver.

## 9. Connectivity UX

`navigator.onLine` is unreliable — it reports "online" for a captive portal or a yard's
dead-zone Wi-Fi. Use a real signal: the timestamp of the last successful Supabase request,
plus a lightweight heartbeat when idle.

Three states, always visible in the driver's header:

| State | Shown | Meaning |
|---|---|---|
| Online | small green dot | Verification is immediate |
| Offline | amber bar: "Offline — 3 pending sync" | Capture works; completion is provisional |
| Syncing | spinner with a count | Draining the outbox |

Tapping the indicator opens `/drive/sync`. That screen is the first thing a driver looks at
when something feels wrong, so it must be honest and detailed: per-item state, per-item
error, storage used, last successful sync time.
