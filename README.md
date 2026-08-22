# DP Logistics — Vehicle & Container Verification

A mobile-first PWA that stops the wrong vehicle going into the wrong container.

A daily manifest assigns chassis numbers to containers, normally two per
container. The driver is handed one task at a time, must photograph the
physical container plate and the physical chassis plate, and the movement
completes only when the server confirms both against the manifest.

```
Driver                                    Server
  read the assignment                     ── the manifest is the source of truth
  photograph the container plate  ──────▶  OCR, ISO 6346 check digit
  photograph the chassis plate    ──────▶  OCR, VIN repair, margin rule
  VERIFY VEHICLE                  ──────▶  the full decision, nothing recorded
  load the vehicle
  CONFIRM VEHICLE MOVED           ──────▶  re-verified, recorded, audited
```

## The five decisions everything else follows from

1. **The client never decides a match.** The browser computes an advisory
   verdict for instant offline feedback; the database grants no client any
   write to the movement table — not a restrictive policy, none at all.
2. **Authorization lives in Postgres.** Delete every route guard in the React
   app and no user gains a single row.
3. **Verification is a confirmation problem, not a recognition problem.** The
   manifest says what to expect, which is what makes browser OCR viable — and
   the margin rule is what stops that becoming confirmation bias in software.
4. **Offline capture is supported; offline completion is provisional.** A
   queued movement says PENDING SYNC and never VERIFIED.
5. **Manifests are immutable and versioned.** Corrections carry before, after
   and a reason, and never mutate a row.

## Running it

```bash
npm install
npm run dev              # the PWA, on mock data — no Supabase needed
npm run test:all         # everything: types, units, SQL, concurrency, browser
```

The SQL suites need a local PostgreSQL 16 and no Docker. The browser suites
need the app served (`npm run build -w @dp/pwa && npm run preview -w @dp/pwa`).

## Documents

| Doc | What's in it |
|---|---|
| [docs/design/](docs/design/) | The full design set: requirements, architecture, roles, journeys, routes, data model, flows, security, OCR, offline, realtime, exceptions, audit, risks, sequence |
| [docs/acceptance-review.md](docs/acceptance-review.md) | Business acceptance, the gap it found, and the operational SOP |
| [docs/deployment.md](docs/deployment.md) | Environment, Supabase setup, migrations, monitoring, backups, rollback, readiness checklist |
| [docs/design/phase-2-database.md](docs/design/phase-2-database.md) | ERD, constraints, RLS model, storage policies |
| [docs/design/phase-13-offline.md](docs/design/phase-13-offline.md) | What works offline, and what cannot |
| [docs/design/phase-14-security-review.md](docs/design/phase-14-security-review.md) | Attacks attempted, findings, accepted risks |
| [docs/design/phase-15-testing.md](docs/design/phase-15-testing.md) | The suites, and which bugs each one caught |
| [docs/reconciliation-rules.md](docs/reconciliation-rules.md) | ISO 6346 and normalisation — still current, stack-independent |

## Layout

```
apps/pwa/              React 19 + TypeScript + Vite + Tailwind v4 + PWA
supabase/
  migrations/          schema, RLS, and every SECURITY DEFINER function
  functions/           Edge Functions, and the shared manifest parser
  tests/               12 SQL suites, including the adversarial one
packages/shared-rules/ check digits, normalisation, matching
scripts/               db-test.sh · db-concurrency.sh · test-all.sh
```

`packages/mobile` and `packages/api` are prior art from a superseded Expo +
NestJS direction. They are no longer npm workspaces — the Expo package alone
accounted for all 23 dependency advisories in the repository, including a
critical one, while being neither deployed nor imported.

## Prior art

The first direction for this project was a native Expo app against a
self-hosted API, framed around a DO-issued pickup report rather than a daily
manifest. Its documents remain in `docs/` and are superseded by
`docs/design/` for this build.
