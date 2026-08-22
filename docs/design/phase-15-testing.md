# Phase 15 — The Test Suite

```bash
./scripts/test-all.sh          # everything
```

Ten suites. The browser ones need the app served (`npm run build -w @dp/pwa &&
npm run preview -w @dp/pwa`); the runner skips them with a note rather than
failing if nothing is listening.

| Suite | Command | Covers |
|---|---|---|
| Typecheck | `npm run typecheck` | Strict TypeScript across the workspace |
| Parser | `npx vitest run` | CSV reading, column detection, the full validation taxonomy (39) |
| App | `npm test -w @dp/pwa` | OCR scoring, offline queue, data adapters, formatting (87) |
| Database | `./scripts/db-test.sh` | 12 SQL suites against real PostgreSQL 16 |
| Concurrency | `./scripts/db-concurrency.sh` | Two connections racing for one container slot |
| Browser × 5 | `npm run e2e*` | Driver flow, roles, manifests, exceptions, offline, OCR |

No Docker required anywhere. The SQL suites run against any local PostgreSQL 16
using a small shim for the `auth` and `storage` schemas Supabase provides.

## The acceptance run

`supabase/tests/99_acceptance.sql` is the build plan's scenario, executed in
order, with each assertion numbered to its criterion:

```
CULVNSA2601795   MAT752389T7R19810 (1 of 2)
                 MAT464844TSR09249 (2 of 2)
```

Manager publishes → driver sees the right next assignment → scans the correct
container → scans the correct chassis → confirms → assignment completes →
container shows 1/2 → next assignment appears → second vehicle completes →
container complete → the manager's board reflects it.

Then every failure the plan lists: wrong container, wrong chassis, both wrong,
already completed, missing evidence, unapproved device, duplicate submission,
unauthorised driver, an invalid manifest, and a duplicate chassis.

## What each layer is for

The layers deliberately do not overlap, because a test that duplicates another
layer's guarantee gives false confidence about which one is holding.

- **SQL suites are the security tests.** They assert *denial* — cross-driver,
  cross-yard, cross-organisation — not permission. `97_attack.sql` is written
  from the attacker's side: twenty-eight things a driver would actually try,
  every one refused.
- **The concurrency script proves the race.** Two drivers, two connections, one
  slot, fired together: one MATCH, one ALREADY_COMPLETED, exactly one movement.
  Nothing about that can be shown from a single session.
- **Unit tests own the rules that are pure decisions** — the ISO 6346 check
  digit against every single-digit mutation, the OCR margin rule, the outbox's
  ordering and its treatment of a business refusal.
- **Browser suites prove the product works**, not that functions return values:
  a real camera stream, the real OCR engine reading a real rendered plate, a
  real connection cut mid-shift.

## Bugs these tests found

Listed because the value of a suite is what it catches, not its size.

| Found by | Bug |
|---|---|
| Browser (smoke) | The driver home served a stale "next pickup" right after a completion — briefly offering the vehicle just loaded |
| Browser (exceptions) | The action bar was `fixed`, covering the override-request button entirely: rendered, present, unclickable |
| Browser (offline) | The service worker was never registered, so the app had no offline capability at all despite the worker being written |
| Browser (offline) | Even registered, it never claimed the page — a driver's first session was uncontrolled and the OCR engine went uncached |
| Browser (OCR) | The engine picks a core variant at runtime; the staging script's hardcoded list missed `relaxedsimd` |
| Browser (OCR) | The margin rule refused a **correct** exact read, because sequential container numbers differ by one character |
| SQL | The conflicting-replay path wrote an exception then raised, rolling back the very record that made it visible |
| SQL | `movement_events` lacked the materialised clock skew the design specified |
| Unit | The mock data source handed out live references into its own store |
