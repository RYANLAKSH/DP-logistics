# 02 — System Architecture

## 1. What the system has to do, structurally

Every other concern in this document is downstream of one operation:

```
   manifest assignment          container on the ground        vehicle at the ramp
   (container ⟷ chassis)   ⟷        (photographed)       ⟷      (photographed)
```

Confirm that three-way join, at a ramp, on a phone, in under a minute, in a way that
cannot be faked and can be proved a year later.

## 2. Component map

```
┌──────────────────────────────────────────────────────────────────────────────┐
│  PWA  —  React 18 + TypeScript + Vite + Tailwind + vite-plugin-pwa           │
│                                                                              │
│  Driver shell          Supervisor shell        Admin shell     Auditor shell │
│  ├ task queue          ├ live board            ├ manifests     ├ search      │
│  ├ camera capture      ├ exception queue       ├ users/yards   └ export      │
│  ├ OCR (WASM worker)   └ override approval     └ recipients                  │
│  ├ advisory verdict                                                          │
│  └ outbox (IndexedDB) ── service worker: app shell, manifest cache, queue    │
└───────────┬────────────────────────────┬──────────────────────┬──────────────┘
            │ supabase-js (anon key + user JWT)                 │
            │                            │                      │
┌───────────▼────────────┐  ┌────────────▼───────────┐  ┌───────▼──────────────┐
│ PostgREST              │  │ Realtime               │  │ Storage              │
│ · reads via RLS        │  │ · postgres_changes     │  │ · private buckets    │
│ · writes via RPC only  │  │   on movements,        │  │ · signed upload URLs │
│   for anything that    │  │   exceptions           │  │ · signed read URLs   │
│   decides an outcome   │  │ · RLS-filtered         │  │ · policies per path  │
└───────────┬────────────┘  └────────────┬───────────┘  └───────┬──────────────┘
            │                            │                      │
┌───────────▼────────────────────────────▼──────────────────────▼──────────────┐
│  PostgreSQL  (Supabase)                                                      │
│                                                                              │
│  Tables (all RLS, default deny)   ·   verify_movement()  SECURITY DEFINER    │
│  Append-only audit_events         ·   State machine enforced by constraints  │
│  Verification logic in SQL/plpgsql, mirroring shared-rules                   │
└───────────┬──────────────────────────────────────────────────────────────────┘
            │ pg_net / webhooks
┌───────────▼──────────────────────────────────────────────────────────────────┐
│  Edge Functions (Deno)                                                       │
│  parse-manifest · ocr-recheck · notify · export-audit · custom-access-token  │
│  (hold the secrets: cloud OCR keys, SMTP/provider keys, service role)        │
└──────────────────────────────────────────────────────────────────────────────┘
```

## 3. The verification boundary

**This is the single most important structural decision in the system.**

The driver's browser must produce an instant verdict — that is the whole user experience,
and it has to work offline. But the browser is not trustworthy: it is a device in a
driver's hand, running code that can be modified, with a network layer that can be
replayed. If a movement's completed state could be written from the client, the control
described in §01 would be advisory in practice regardless of what the UI says.

So the system runs verification **twice**, with different authority:

| | Client verdict | Server verdict |
|---|---|---|
| Runs | In the browser, offline-capable | In Postgres, inside a transaction |
| Input | Cached manifest lines | Live manifest, current version |
| Purpose | Instant feedback, block the UI early | Decide the record |
| Authority | None. Stored as `client_verdict` for comparison | Authoritative. Drives state, notifications, audit |
| Failure mode if bypassed | Driver sees a wrong verdict | — (cannot be bypassed) |

Concretely:

- The `movements` table grants the `authenticated` role **no** `INSERT` or `UPDATE` on the
  columns that carry outcome (`status`, `outcome`, `verified_at`, `manifest_version_id`).
- The only path to a completed movement is `verify_movement(...)`, a `SECURITY DEFINER`
  plpgsql function that re-reads the manifest, re-runs the comparison, writes the movement,
  writes the audit event, and — on failure — writes an exception. All in one transaction.
- A disagreement between `client_verdict` and the server outcome is recorded and alerted.
  Persistent disagreement means either a stale cache (expected, see §10) or a tampered
  client (not expected, and worth knowing about).

**Consequence for later development:** no feature may add a client-side write that decides
an outcome. If a new flow needs to change movement state, it gets an RPC. Treat this as a
review rule, not a guideline.

## 4. Why Postgres RPC rather than an Edge Function for verification

Both were candidates. RPC wins for the verification path specifically:

- **Atomicity.** Verification reads the manifest, checks container capacity, checks the
  vehicle is not already loaded, writes the movement, and writes the audit event. Those must
  be one transaction with row locks, or two drivers scanning the last slot of the same
  container simultaneously both succeed. Inside plpgsql that is `SELECT ... FOR UPDATE`.
  From an Edge Function it is a distributed transaction you have to hand-roll.
- **Identity.** `auth.uid()` is available inside the function without passing or trusting
  anything from the client.
- **Latency.** No extra hop. The driver is standing next to a running truck.
- **No secret required.** Verification needs no external service.

Edge Functions take the work that genuinely needs to be off-database:

| Function | Why it is not an RPC |
|---|---|
| `parse-manifest` | XLSX/CSV parsing, CPU-heavy, needs npm libraries |
| `ocr-recheck` | Calls an external vision API with a secret key |
| `notify` | Calls an email/push provider with a secret key; must not block a transaction |
| `export-audit` | Long-running, produces a file to Storage |
| `custom-access-token` | Auth hook; injects `org_id` and `role` claims into the JWT |

**Consequence:** the shared verification rules exist in two implementations — TypeScript
(`packages/shared-rules`, used by the PWA) and plpgsql (used by `verify_movement`). That
duplication is a real cost and a real risk of drift. It is accepted deliberately, and
managed by: a single golden-case fixture file that both implementations are tested against
in CI, and a rule that the plpgsql version is the specification when they disagree. The
alternative — running the TypeScript rules in an Edge Function called from the RPC — trades
the drift risk for a network hop inside a transaction, which is worse.

## 5. Stack, with the reasoning

| Layer | Choice | Notes that matter later |
|---|---|---|
| Framework | React 18 + TypeScript, strict | — |
| Build | Vite | Fast HMR; `vite-plugin-pwa` wraps Workbox without a hand-written service worker |
| Styling | Tailwind CSS | Sunlight-readable design tokens defined once; large tap targets are a utility, not a bespoke stylesheet |
| Routing | React Router (data router) | Loaders give route-level data fetching and a natural place for guards |
| Server state | TanStack Query | Its cache is the read layer; realtime events invalidate keys rather than mutating UI state directly |
| Local state | Zustand | Small. The scan-in-progress machine and the outbox |
| Offline store | IndexedDB via Dexie | Manifest cache, outbox, image blobs. `localStorage` cannot hold images |
| Camera | `getUserMedia` + `<video>` + `ImageCapture`/canvas | Not `<input capture>` — see §09 |
| OCR | `tesseract.js` in a Web Worker, plus optional server recheck | §09 |
| Backend | Supabase: Postgres, Auth, Storage, Realtime, Edge Functions | One vendor, one identity model, RLS as the authorization layer |
| Email/push | Provider called from `notify` Edge Function | Web Push for supervisors; email for everyone |
| Tests | Vitest, Testing Library, Playwright, pgTAP | pgTAP is not optional — RLS policies need tests that assert denial |

### Notes on choices that are easy to get wrong

- **`vite-plugin-pwa` in `injectManifest` mode, not `generateSW`.** The service worker has
  to do custom work: an outbox with Background Sync, and a network-first strategy for
  manifest data with a hard cache fallback. Generated SWs cannot express that.
- **`tesseract.js` runs in a Worker, always.** On the main thread it freezes the camera
  preview and the app appears broken.
- **React Router loaders must not be the authorization boundary.** They exist so a screen
  has data when it renders. RLS is what stops a user reading another yard's manifest.

## 6. Repository layout

```
dp-logistics/
├── apps/
│   ├── pwa/                    # React + Vite. All four role shells, one build
│   │   └── src/
│   │       ├── routes/         # mirrors §05
│   │       ├── features/       # scan, manifest, board, exceptions, audit
│   │       ├── lib/            # supabase client, dexie, outbox, camera, ocr worker
│   │       └── components/
│   └── (no separate admin app — the admin surface is routes in the same PWA)
├── packages/
│   └── shared-rules/           # EXISTING. Check digits, normalization, matching
├── supabase/
│   ├── migrations/             # schema + RLS policies + verify_movement()
│   ├── functions/              # parse-manifest, ocr-recheck, notify, export-audit
│   ├── tests/                  # pgTAP: one file per table asserting RLS denial
│   └── seed.sql
└── docs/design/                # this directory
```

**One PWA, four role shells, not four apps.** The admin surface is small (manifest upload,
users, yards, recipients), the supervisor surface is two screens, and all four share the
auth session, the Supabase client, and the design system. Splitting them costs four builds
and four deploys to save a few hundred kilobytes on a driver's phone. Route-level code
splitting gets most of that back: a driver never downloads the manifest-import chunk.

Revisit this if the admin surface grows past roughly a dozen screens, which is the point
where its build and release cadence starts wanting to be independent of the driver app's.

## 7. Environments

| Environment | Supabase project | Purpose |
|---|---|---|
| local | `supabase start` (Docker) | Migrations and pgTAP run here first |
| staging | separate project | Seeded with synthetic manifests; where UAT happens |
| production | separate project | Real data. Migrations only via CI |

Never share a project between environments. RLS mistakes found in staging are cheap; the
same mistake in production is a data breach. Migrations are files in `supabase/migrations`,
applied by CI — never by hand in the dashboard SQL editor, because a hand-applied change is
invisible to the next environment.
