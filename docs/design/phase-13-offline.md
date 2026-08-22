# Phase 13 — What Works Offline, and What Cannot

The single rule: **a movement is never presented as complete until the server
has confirmed it.** Everything below follows from that.

## What works with no connection at all

| Capability | How |
|---|---|
| Opening the app | App shell precached by the service worker |
| Seeing today's tasks | Network-first with a cache fallback (24 h) |
| Reading the assignment before scanning | Same cache |
| Opening the camera and capturing | Entirely local |
| Running OCR | Engine cached at runtime on first use; warmed at shift start |
| Getting an advisory verdict | Shared rules against the cached manifest |
| Queueing a movement | IndexedDB outbox, photographs included |
| The sync screen | Deliberately reachable offline — it is the screen a driver opens when something feels wrong |

## What cannot be done offline, and why

| Not available | Why |
|---|---|
| **A confirmed verification** | The server is the authority. A device that could confirm its own movement would make the whole control advisory |
| Requesting or approving an override | Needs a second person's authenticated session |
| Device approval | Same |
| Winning a contested task | Two drivers offline may both claim one assignment. Resolution is server-side, first write wins, and the loser's item returns as `conflict` |
| Any manager or admin screen | Deliberate. A stale exception queue is dangerous — a manager may believe a truck has been stopped when it has not |
| Viewing evidence images | Never cached on a device. They are the most sensitive data in the system, and a lost handset must not carry them |

## The queue

Photographs are written to IndexedDB **before** any upload is attempted, online
or off. One code path either way: an upload that fails mid-shift then costs
nothing, because the bytes were never only in memory.

Draining is strictly ordered per item — every image, then verification. The
server refuses verification without evidence (`EVIDENCE_MISSING`), so a queue
that drained out of order would turn a connectivity problem into a permanent
block.

| Outcome | Treated as |
|---|---|
| `MATCH` | Confirmed. Photographs released |
| `WRONG_VEHICLE`, `CONTAINER_FULL`, … | **Rejected — a result, not a retry.** Retrying a business refusal forever would hide it from the driver and hammer the server with a question already answered |
| `ALREADY_COMPLETED` | Conflict. Someone else did this vehicle |
| Network error | Retryable, with backoff 2s → 4s → 8s → 16s → 30s → 60s |

Nothing is ever dropped automatically. An item unsynced for 24 hours is flagged
to the driver and belongs in front of a manager: a movement may have physically
happened with no record of it.

## Storage

Photographs are the only irreplaceable thing on the device — the container is
sealed and the truck has gone.

- `navigator.storage.persist()` is requested at startup, and whether it was
  granted is shown on the sync screen rather than assumed.
- Warn at 100 MB. **Refuse new captures at 200 MB**, with an instruction to find
  signal. Silently failing to store evidence is worse than refusing to start.
- Only `confirmed` items can be cleared, and only deliberately.

## Updates

The service worker prompts before applying an update; it never reloads on its
own. A worker that activates mid-scan destroys an in-progress capture, and the
driver has no idea why the photograph they just took has gone.

It does call `clientsClaim()` on first install, so a driver's very first session
is controlled and the OCR engine is cached before they reach a dead spot. That
is safe precisely because an updated worker only ever activates through the
prompt.

## Verified

`npm run e2e:offline` drives a real browser: warms the engine online, cuts the
connection, scans both plates, confirms, and asserts the screen says
**PENDING SYNC** and never **VERIFIED**.
