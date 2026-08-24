# Architecture

## 1. What the system actually has to do

Strip away the app and the problem is a three-way join executed under time pressure at a
gate, by one person, on a phone, possibly without signal:

```
pickup report line   ⟷   container on the ground   ⟷   vehicle at the gate
   (from the DO)            (photographed)              (photographed)
```

Everything below exists to make that join fast, verifiable after the fact, and hard to
fake.

## 2. Component map

```
┌─────────────────────────────────────────────────────────────────────┐
│  MOBILE APP  (React Native / Expo — Android primary, iOS secondary) │
│                                                                     │
│  Camera + on-device OCR (ML Kit)                                    │
│  Local DB (SQLite/WatermelonDB) — cached reports, queued scans      │
│  Local reconciliation engine (same rules as server, shared package) │
│  Sync engine (upload queue, retry w/ backoff, conflict-free)        │
└────────────────────────┬────────────────────────────────────────────┘
                         │ HTTPS / JWT
┌────────────────────────▼────────────────────────────────────────────┐
│  API  (NestJS / Node + TypeScript)                                  │
│                                                                     │
│  auth · reports · scans · reconciliation · notifications · admin    │
│  Reconciliation engine (authoritative)                              │
│  Report ingest pipeline (XLSX / CSV / PDF)                          │
└──┬──────────────┬───────────────┬─────────────────┬─────────────────┘
   │              │               │                 │
┌──▼─────────┐ ┌──▼──────────┐ ┌──▼───────────┐ ┌───▼──────────────┐
│ PostgreSQL │ │ S3 / R2     │ │ Redis+BullMQ │ │ SES / SendGrid   │
│ (system of │ │ (evidence   │ │ (jobs: OCR   │ │ (transactional   │
│  record)   │ │  images)    │ │  recheck,    │ │  email)          │
│            │ │             │ │  email, PDF) │ │                  │
└────────────┘ └─────────────┘ └──────────────┘ └──────────────────┘
                         ▲
┌────────────────────────┴────────────────────────────────────────────┐
│  ADMIN PANEL  (Next.js)                                             │
│  Upload & map pickup reports · live reconciliation board ·          │
│  exceptions queue · user & role management · email recipients       │
└─────────────────────────────────────────────────────────────────────┘
```

## 3. Stack recommendation

**Recommended: React Native (Expo) + NestJS + PostgreSQL.** One language across mobile,
API, and admin means the reconciliation rules live in *one* shared TypeScript package
imported by both the phone and the server — which is the single most important structural
decision here. Two implementations of the matching rules will drift, and when they drift
your offline verdict stops agreeing with your audit record.

```
packages/
  shared-rules/     ← matching logic, check digits, normalization. Used by BOTH.
  api/              ← NestJS
  mobile/           ← Expo
  admin/            ← Next.js
```

| Layer | Pick | Why |
|---|---|---|
| Mobile | Expo + `react-native-vision-camera` | Frame processors give you live OCR preview; EAS handles builds/OTA |
| OCR (on-device) | Google ML Kit Text Recognition v2 | Free, offline, fast. Non-negotiable given connectivity |
| OCR (server recheck) | Textract / Google Vision, async | Second opinion on low-confidence scans; not in the critical path |
| Local DB | WatermelonDB (SQLite) | Built for offline sync; handles the queue semantics you need |
| API | NestJS | Structure and DI out of the box; good for a team that will grow |
| DB | PostgreSQL 15+ | Relational integrity matters here; JSONB for OCR blobs |
| Object store | S3 or Cloudflare R2 | Images never touch the DB. Presigned direct upload from device |
| Queue | BullMQ on Redis | Email, OCR recheck, report parsing, daily digests |
| Email | AWS SES (or SendGrid) | Templated, with delivery webhooks logged back |
| Auth | Own JWT (access 15m + refresh 30d) | See §6 |
| Admin | Next.js + TanStack Query | Server components for the board, plain React for forms |

**Faster alternative if you need a pilot in 3 weeks:** Supabase (Postgres + Auth + Storage
+ Edge Functions) with the same Expo app. You lose some control over the ingest pipeline
and job queue, but you skip most of the infrastructure work. The schema in
[data-model.md](data-model.md) transfers unchanged. Migrating off Supabase later is a real
but bounded cost — keep business logic out of Postgres functions and it's mostly a
re-hosting exercise.

**Do not** build this as a mobile web app. You need reliable camera access, on-device ML,
and true offline storage.

## 4. The capture flow, in detail

This is where the product succeeds or fails. Officers are standing in the sun next to a
running truck; every extra tap costs you adoption.

**Step 1 — Job selection.** Officer opens the app, picks the pickup report for their
location/date. Report lines were pre-cached on last sync. If they scan a container not in
any cached report, the app says so immediately rather than failing silently.

**Step 2 — Container capture.**
- Live camera with an alignment guide sized for a container ID panel.
- Frame processor runs OCR continuously and shows candidate numbers as they stabilize.
- Candidates are filtered by shape (`^[A-Z]{4}[0-9]{7}$`) and then by **ISO 6346 check
  digit**. This is the highest-leverage thing in the whole system: it rejects most OCR
  errors locally, instantly, with no server and no ML confidence tuning.
- A check-digit-valid candidate auto-fills. Officer taps confirm. Invalid or ambiguous →
  officer types it, with the check digit validating as they type.
- Photo is captured regardless, at full resolution, and kept.

**Step 3 — Chassis capture.** Same pattern. Chassis/VIN plates are messier — stamped
metal, dirt, oil, varying formats — so expect a higher manual-entry rate. If the VIN is
17 characters and North-American-format, validate the ISO 3779 check digit; otherwise
fall back to fuzzy-match against the expected chassis number on the report line (see
[reconciliation-rules.md](reconciliation-rules.md) §4). Also capture the vehicle
registration plate as a secondary identifier — it's far easier to OCR and gives you a
second signal when the chassis read is poor.

**Step 4 — Verdict, on device, offline.** The shared rules package runs against the
cached report. Full-screen green PASS or red FAIL. A FAIL states *why*: "Container
MSKU4512345 is assigned to chassis MAT4478..., you scanned MAT4471...".

**Step 5 — Queue and sync.** Images compressed (~1600px long edge, JPEG q80 — keep the
original too if storage allows), queued with the scan record. Upload resumes
automatically. The officer is not blocked on it.

**Ordering note:** let officers scan chassis-first as well as container-first. Real yards
don't have a fixed order, and forcing one will get worked around.

## 5. Offline strategy

| Concern | Approach |
|---|---|
| Report availability | Sync all report lines for the officer's assigned locations, next 7 days. It's kilobytes |
| Verdict without network | Shared rules package runs locally against cached lines |
| Duplicate submissions | Client generates a UUID per scan session; server upserts on it (idempotency key) |
| Clock tampering | Store both device time and server receipt time. Flag drift > 5 min |
| Stale report | Each cached report carries a `version`. Server rejects a reconciliation computed against a superseded version and re-runs it — outcome may flip, and that flip is itself an alertable event |
| Email while offline | Email fires server-side on ingest, not on device. Delayed sync = delayed email, never a lost one |

The honest tradeoff: an officer working offline against a report that was amended an hour
ago can get a PASS on device and a MISMATCH on the server. You cannot eliminate this
without connectivity. What you can do is make it loud — the server-side flip raises a
priority alert, and the app surfaces "report updated, N earlier verdicts changed" on the
next sync.

## 6. Auth and roles

DP Logistics is web-first: a client is authenticated by credentials alone, not by a
separately-approved device or browser. The model is
`LOGIN → AUTHENTICATED SESSION → ROLE + ORGANIZATION AUTHORIZATION → APPLICATION` —
there is no device registration or supervisor-approval step between login and access.

JWT with short-lived access tokens (15 min) and rotating refresh tokens (30 days, stored
in device secure storage). Long refresh windows are deliberate — officers should not be
re-authenticating at a gate.

| Role | Can |
|---|---|
| `field_officer` | Scan, view own sessions, view reports for assigned locations |
| `supervisor` | All of the above + approve overrides, view all sessions at their locations |
| `admin` | Upload/amend reports, manage users, configure email recipients, full visibility |
| `auditor` | Read-only across everything, including evidence images. No mutations |

Additional controls:
- **Location scoping.** Officers only see reports for locations they're assigned to.
- **Biometric unlock** for app resume; full re-login only on refresh expiry.

## 7. Pickup report ingestion

The DO's report will arrive as an email attachment in whatever format they feel like, and
that format will change without warning. Build for that.

```
Upload (XLSX/CSV/PDF)
  → detect format, extract raw rows
  → column mapping (auto-detected, admin confirms; mapping saved per DO as a template)
  → validate each row: container check digit, date sanity, duplicate container in report
  → PREVIEW: admin sees N valid / M rejected, with per-row reasons
  → commit → creates pickup_report version 1, lines become live
```

Rules that matter:
- **Never auto-commit.** Preview-then-commit, always. A bad import silently blocks every
  truck at the gate.
- **Amendments create a new version**, they don't mutate lines. Version 2 supersedes
  version 1; reconciliations record which version they matched.
- **Reject, don't guess.** A row with an invalid container check digit is rejected with a
  reason, not "corrected". Admin fixes the source or edits the row explicitly.
- PDF ingest is the hard case. Start with XLSX/CSV, add PDF table extraction (Textract or
  `camelot`) in phase 2, and always route PDF results through the same preview.
- Optional phase-3 nicety: a dedicated mailbox that auto-ingests DO attachments straight
  into the preview queue.

## 8. Notifications

Event-driven, off the request path.

```
reconciliation.completed  ──► BullMQ ──► template render ──► SES ──► delivery webhook
                                            │                          │
                                            └── attach evidence?       └── logged to
                                                (presigned links,          notifications
                                                 not attachments)          table
```

| Event | Recipients | Timing |
|---|---|---|
| `MATCH` | DO contact, transporter, ops mailbox | Immediate |
| `MISMATCH` | Supervisor, ops, admin | Immediate, high priority |
| `OVERRIDE_APPLIED` | Supervisor, admin, auditor | Immediate |
| `CONTAINER_NOT_IN_REPORT` | Ops, admin | Immediate |
| Daily summary | Admin, DO | Scheduled (cron) |

Design points:
- Recipients are configured per-DO and per-location in the admin panel, not hardcoded.
- Emails carry **presigned links** to evidence, expiring in 7 days — not attached images.
  Keeps mail deliverable and access revocable.
- Every send is logged to `notifications` with provider message ID and delivery status
  from the webhook. "Did the email go out?" must be answerable from the DB.
- Add a per-recipient rate limit. One bad import can otherwise generate 200 mismatch
  emails in a minute and get you spam-filtered exactly when you need the alerts.
- Batch the low-priority ones (a 15-minute digest for MATCH events is usually plenty);
  keep MISMATCH instant.

## 9. Security and evidence integrity

- Images: private bucket, presigned PUT for upload / GET for viewing, server-side
  encryption, no public ACLs ever.
- Store a SHA-256 of each image at upload. It's what makes the evidence defensible if a
  reconciliation is ever disputed.
- `reconciliations` and `audit_log` are append-only. Corrections are new rows referencing
  the prior one; nothing is updated in place.
- GPS with every scan. A reconciliation from 40 km off-site is a fraud signal — surface it.
- PII: driver names and phone numbers from the report are personal data. Restrict to
  supervisor+, exclude from exports by default.
- Retention: evidence images 24 months (configurable), then lifecycle-delete to cold
  storage or purge. Reconciliation records retained indefinitely — they're small.
- TLS everywhere, certificate pinning on mobile if the threat model warrants it.

## 10. What I'd watch out for

- **OCR accuracy on chassis plates is the top project risk.** Container plates are
  standardized, high-contrast, and check-summed. Chassis plates are stamped metal, often
  filthy, sometimes obstructed. Budget real time for it, and make manual entry a
  first-class path rather than a fallback you're ashamed of.
- **Officers will find the workaround.** If a FAIL is slow or the app is flaky, they'll
  wave the truck through and reconcile later from the cab. Make the happy path faster than
  not using the app, and keep an eye on the gap between scan time and truck departure.
- **The DO's format will change.** Saved per-DO mapping templates and a preview step are
  what turn that from an outage into a two-minute admin task.
- **Battery and data.** Continuous camera + ML is expensive. Ship with compression
  defaults tuned down, and let officers work a full shift on one charge.

## 11. Repository layout

```
dp-logistics/
├── packages/
│   ├── shared-rules/          # THE matching engine — one implementation
│   │   ├── src/checkDigit.ts       # ISO 6346, ISO 3779
│   │   ├── src/normalize.ts        # OCR cleanup, confusable chars
│   │   ├── src/reconcile.ts        # outcome resolution
│   │   └── src/__tests__/          # heaviest test coverage in the repo
│   ├── api/                   # NestJS
│   │   └── src/modules/{auth,reports,scans,reconciliation,notifications,admin}
│   ├── mobile/                # Expo
│   │   └── src/{screens,camera,db,sync,offline}
│   └── admin/                 # Next.js
├── infra/                     # IaC, migrations, CI
└── docs/
```

`shared-rules` is published to the internal registry (or consumed via workspace protocol)
and imported by `api` and `mobile`. If you take one thing from this document, take that.
