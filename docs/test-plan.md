# Test plan and coverage

Every case in the acceptance brief, and where it is proved. A row without a
location is not a row — if it is not here, it is not tested.

## The acceptance scenario

```
container  TRHU8755445
  vehicle 1  MAT752389T7R20588
  vehicle 2  MAT464844TSR09113
```

Taken from the pickup list rather than invented, so the suite proves what the
yard actually does. Both fixture containers are real ISO 6346 numbers that pass
their own check digit, and the rule the product exists to hold is visible in
the shape of the fixture itself: **one chassis belongs to exactly one
container, one container carries exactly two chassis.**

The same scenario drives the SQL fixtures, the in-memory backend and the
browser suites, so all three prove the same thing.

## Where each layer runs

| Layer | What it proves | How to run |
|---|---|---|
| Parser unit | The manifest file, before anything is stored | `npx vitest run` |
| App unit | Scan pipeline, matching, offline queue, backend contract | `npm run test -w @dp/pwa` |
| Database + RLS | Constraints, policies, the verification engine | `./scripts/db-test.sh` |
| Concurrency | Two drivers racing one slot | `./scripts/db-concurrency.sh` |
| Browser | What the yard sees and does | `npm run e2e:* -w @dp/pwa` |

`./scripts/test-all.sh` runs all of it, in the order that fails fastest.

## The successful workflow

Thirteen numbered steps, asserted by name in `apps/pwa/e2e/acceptance.mjs`, so
a failure says which step of the business process broke rather than which
selector moved.

| # | Step | Also proved server-side |
|---|---|---|
| 1 | Driver logs in | `50_auth.sql` |
| 2 | Driver sees the correct next assignment | `60_sequential.sql` |
| 3–4 | Correct container scanned, passes | `99_acceptance.sql` |
| 5–6 | Correct chassis scanned, passes | `99_acceptance.sql` |
| 7 | Driver confirms the movement | `70_engine.sql` |
| 8 | Assignment becomes completed | `99_acceptance.sql` |
| 9 | Container shows 1 of 2 | `90_board.sql` |
| 10 | Next assignment appears | `60_sequential.sql` |
| 11–12 | Second vehicle completes, container closes | `99_acceptance.sql`, `20260101002100_shift_close.sql` |
| 13 | Manager dashboard updates | `90_board.sql` |

Steps 3–7 are deliberately proved twice. The browser test proves the screens
hand the driver the right task and record the right thing; the SQL suite proves
the server would refuse even if the screens did not.

## The failure cases

| Case | Proved in | Outcome |
|---|---|---|
| Wrong container | `40_verification.sql`, `e2e/smoke.mjs` | `WRONG_CONTAINER` |
| Wrong chassis | `40_verification.sql` | `WRONG_VEHICLE`, naming the container it belongs to |
| Wrong container **and** chassis | `40_verification.sql` | `WRONG_CONTAINER` — see below |
| OCR failure | `src/lib/ocr/__tests__/pipeline.test.ts` | Nothing proposed, manual entry offered |
| Low OCR confidence | `src/lib/ocr/__tests__/pipeline.test.ts` | Below the floor, refused |
| Camera denied | `e2e/denials.mjs` | Movement impossible; report the problem instead |
| Location denied | `e2e/denials.mjs` | Movement completes, absence recorded |
| Network loss | `e2e/offline.mjs`, `src/lib/offline/__tests__` | Queued, replayed, verified server-side |
| Duplicate submission | `70_engine.sql` | `REPLAY_CONFLICT`, one movement only |
| Already completed | `40_verification.sql` | `ALREADY_COMPLETED` |
| Unauthorised driver | `99z_outcomes.sql` | No upload path issued; `DRIVER_NOT_AUTHORISED` |
| Duplicate chassis in manifest | `__tests__/samplePickupList.test.ts` | `CHASSIS_DUPLICATE`, naming the first container |
| Invalid manifest | `__tests__/validate.test.ts`, `e2e/manifest.mjs` | Rejected, never guessed at |
| Incorrect vehicle count | `99_acceptance.sql` | Warned at upload, caught again at shift close |
| Manifest correction | `96_corrections.sql` | Versioned, affected movements re-checked |
| Exception resolution | `80_exceptions.sql` | Two-person rule, requester ≠ approver |
| Private image access | `98_storage.sql` | Owner and yard manager only |
| Manager-only route | `30_rls.sql`, `e2e/smoke.mjs` | 403 |
| Admin-only route | `30_rls.sql` | 403 |

### Two answers worth reading twice

**Wrong container and wrong chassis together report the container.** That is
the thing the driver is standing in front of and the thing they can act on:
walk to the right box and the vehicle is right too. Reporting the vehicle first
would send them looking for a second problem that does not exist. The scanned
pair is kept verbatim on the record either way, so the manager reviewing the
exception can see both were wrong.

**Camera denied and location denied get opposite answers.** The photograph *is*
the evidence — typing the number instead proves only that someone can type — so
a denied camera stops the movement, and the driver reports the problem rather
than being stranded. Location corroborates but does not prove, so a denied
location is recorded and the shift continues. Blocking a morning over a setting
a driver may not control pushes the work off the system entirely, which is the
one outcome that helps nobody.

## What the suite found

Written down because a test plan that only lists passes is marketing.

- **`MANIFEST_SUPERSEDED` could never fire.** A driver holding a cached plan got
  the same answer as a genuinely broken manifest, and the wrong instruction with
  it. Fixed and covered.
- **`WRONG_CHASSIS` could never fire, and should not exist.** One chassis
  belongs to one container, so a scan is assigned here, elsewhere, or nowhere —
  there is no third case. Removed.
- **Blocking a movement un-cancelled a withdrawn vehicle.** It came back as
  something for a manager to resolve, and re-occupied the chassis so the
  corrected assignment could not be created. Fixed and covered.
- **The driver's work order was alphabetical, not the plan's.** The view already
  carried the manifest sequence; the client ignored it.
- **Storage policies were never exercised** — RLS was off on the shim's
  `storage.objects`, so the policies parsed and applied to nothing. Turned on,
  and the bucket is now tested for real.
