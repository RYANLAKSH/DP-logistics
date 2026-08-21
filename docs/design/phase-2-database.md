# Phase 2 — Database and Supabase Security Model

The authoritative artefacts are the migrations in [`supabase/migrations/`](../../supabase/migrations).
This document is the map: the ERD, the decisions, and where each requirement is enforced.

## 1. ERD

```
organizations ─┬─ yards ──────────────┬───────────────────────────────────┐
               │                      │                                   │
               ├─ profiles ─┬─ user_yards ─┘                              │
               │            └─ devices                                    │
               ├─ org_settings                                            │
               │                                                          │
               ├─ manifest_imports ──► manifests (versioned) ─┬─ containers
               │        (staging)          │                  │      │
               │                           │                  │      └─ vehicle_assignments
               │                           │                  │              │
               │                           └─ manifest_corrections           │
               │                                                             │
               ├─ verification_attempts ────────────────────────────────────┤
               │        (every scan, pass or fail)                          │
               ├─ movement_events ──────────────────────────────────────────┤
               │        (a vehicle placed in a container — once)            │
               ├─ exceptions ── overrides                                   │
               ├─ sync_operations                                           │
               └─ audit_logs (append-only, hash-chained)  ◄─────────────────┘
```

Cardinalities that matter:

```
manifests            1 ─── n  containers
containers           1 ─── n  vehicle_assignments      (normally 2; capacity is a column)
vehicle_assignments  1 ─── 0..1 movement_events        (COMPLETED/OVERRIDDEN: at most one)
vehicle_assignments  1 ─── n  verification_attempts    (every try, kept forever)
```

## 2. Where each stated requirement is enforced

| Requirement | Enforced by | File |
|---|---|---|
| A manifest belongs to an operating date | `manifests.operating_date` + `unique (yard_id, operating_date, version)` | `…000400` |
| A manifest contains many containers | `containers.manifest_id` FK | `…000400` |
| A container has multiple vehicle assignments | `vehicle_assignments.container_id` FK | `…000400` |
| Each assignment has a chassis and a sequence | `chassis_no`, `sequence_no`, `unique (container_id, sequence_no)` | `…000400` |
| A chassis may not be in two active containers in one manifest | `unique index … (manifest_id, chassis_no) where status <> 'CANCELLED'` | `…000400` |
| A movement may be completed only once | `unique index … (assignment_id) where status in ('COMPLETED','OVERRIDDEN')` | `…000500` |
| Every verification attempt is auditable | `verification_attempts` + `app.audit()` on every write | `…000500`, `…000700` |
| Failed scans are retained | Attempts are inserted regardless of `result`; no delete grant | `…000500`, `…000800` |
| Historical manifests are never silently overwritten | New `version`, previous set `ARCHIVED`; no UPDATE policy on `manifests` | `…001000`, `…000800` |
| Corrections preserve before/after and reason | `manifest_corrections` + `check (length(reason) >= 10)` | `…000400` |
| VERIFIED requires all six inputs to satisfy the rules | `verify_movement()` | `…000900` |

## 3. Status enums

| Enum | Values |
|---|---|
| `user_role` | ADMIN, MANAGER, DRIVER |
| `manifest_status` | DRAFT, VALIDATION_FAILED, READY, PUBLISHED, ARCHIVED |
| `assignment_status` | PENDING, IN_PROGRESS, COMPLETED, EXCEPTION, CANCELLED |
| `movement_status` | COMPLETED, OVERRIDDEN, REVERSED |
| `attempt_kind` | CONTAINER, CHASSIS, FINAL |
| `attempt_result` | PASS, FAIL_MISMATCH, FAIL_OCR, FAIL_LOW_CONFIDENCE, FAIL_CHECK_DIGIT, FAIL_RULE |
| `verification_outcome` | MATCH, WRONG_CONTAINER, WRONG_CHASSIS, WRONG_VEHICLE, CHASSIS_NOT_ON_MANIFEST, CONTAINER_NOT_ON_MANIFEST, ALREADY_COMPLETED, CONTAINER_FULL, ASSIGNMENT_NOT_ACTIVE, MANIFEST_NOT_PUBLISHED, MANIFEST_SUPERSEDED, DRIVER_NOT_AUTHORISED, DEVICE_NOT_APPROVED, EVIDENCE_MISSING, REPLAY_CONFLICT |
| `exception_type` / `exception_status` / `exception_resolution` | see `…000200` |
| `value_source` | OCR_AUTO, OCR_CONFIRMED, MANUAL_ENTRY, MANUAL_AUTHORISED |

## 4. Role and permission model

Three roles, per the build plan. `MANAGER` carries the yard-supervisor authority described
in the design set; `ADMIN` is organisation-wide and additionally carries audit read.

|  | DRIVER | MANAGER | ADMIN |
|---|---|---|---|
| Read own tasks / own attempts / own movements | ✓ | ✓ (whole yard) | ✓ (whole org) |
| Read another driver's work | — | ✓ own yards | ✓ own org |
| Read manifests | published, own yards | own yards, all versions | own org |
| Upload / publish a manifest | — | ✓ own yards | ✓ |
| Complete a movement | ✓ via RPC only | — | — |
| Approve a device / an override | — | ✓ own yards | ✓ |
| Read the audit log | — | ✓ own yards | ✓ own org |
| Write the audit log | — | — | — |
| Delete anything | — | — | — |

The last two rows are the point. Nobody, at any level, can rewrite history.

## 5. Security model: the write boundary

```
                    PostgREST (anon key + user JWT)
                              │
             ┌────────────────┴────────────────┐
             │                                 │
        SELECT, via RLS                   INSERT/UPDATE
             │                                 │
   every table, scoped by            ONLY three narrow grants:
   role + org + yard                   · devices (own, PENDING only)
                                       · manifest_imports (manager, own yard)
                                       · org_settings (admin, listed columns)
                                                │
                                    everything else → RPC
                                                │
   ┌────────────────────────────────────────────┴──────────────────────────┐
   │ SECURITY DEFINER, search_path = '', identity from auth.uid()          │
   │  verify_movement · record_scan_attempt · claim_assignment              │
   │  publish_manifest_from_import · archive_manifest · approve_device      │
   │  revoke_device · create_evidence_upload_path                           │
   └───────────────────────────────────────────────────────────────────────┘
```

`movement_events` has **no** insert or update policy for any role. Not a restrictive one —
none. PostgREST cannot write that table under any circumstance, by any user. That is what
makes the front end structurally incapable of deciding an outcome.

Column-level grants matter as much as row policies: `grant update (…columns) on org_settings`
means an admin can change a threshold and cannot change `org_id`. A table-wide update grant
would have permitted both.

## 6. Storage

| Bucket | Public | Path | Write | Read |
|---|---|---|---|---|
| `evidence` | no | `{org}/{yard}/{date}/{assignment}/{kind}-{attempt}.jpg` | DRIVER, own org + yard | owner, MANAGER/ADMIN in scope |
| `manifests` | no | `{org}/{yard}/{date}/{sha256}.{ext}` | MANAGER/ADMIN in scope | MANAGER/ADMIN in scope |

The client never chooses a path — `create_evidence_upload_path()` constructs it from the
assignment. A client-supplied path is a write-anywhere primitive, and no storage policy
saves you from one. Neither bucket grants UPDATE or DELETE to any client role: evidence is
immutable, and retention purging runs as the service role from a scheduled job.

## 7. Audit approach

Three independent layers, detailed in [13-audit-trail.md](13-audit-trail.md) §3 and
implemented in `…000700`:

1. **No grant.** `authenticated` has `SELECT` on `audit_logs` and nothing else.
2. **Triggers** that raise on UPDATE, DELETE and TRUNCATE.
3. **A SHA-256 hash chain**, with `verify_audit_chain()` to find the first break. The daily
   external anchor (§13) is what makes the chain meaningful against someone who holds
   database credentials.

Writes go exclusively through `app.audit()`, which derives the actor from `auth.uid()`.

## 8. Two things the sample data changed

Real inputs from the build plan corrected two assumptions:

**Container identifiers are not always ISO 6346.** `CULVNSA2601795` is fourteen characters
and carries no check digit. Demanding ISO 6346 validity would have rejected the customer's
actual references. So `app.is_iso6346_shaped()` gates the check: ISO-shaped numbers get the
free error detection, everything else falls back to exact comparison after normalisation.

**`MSKU4512345` was wrong.** It appeared as a "valid" example throughout the pre-existing
`docs/reconciliation-rules.md` and in the first draft of this design set. Its correct check
digit is 0, not 5. Every example is now `MSKU4512340`, and the implementation is verified
against `CSQU3054383`, the published ISO worked example.

## 9. Running the tests

No Docker required — the suite runs against any local PostgreSQL 16:

```bash
./scripts/db-test.sh
```

It drops and rebuilds a scratch database, applies `supabase/tests/00_local_shim.sql` (a
minimal stand-in for the `auth` and `storage` schemas Supabase provides), applies every
migration in order, loads fixtures, then runs each test file with `ON_ERROR_STOP`.

| File | Covers |
|---|---|
| `10_domain.sql` | Normalisation, ISO 6346, every single-digit mutation |
| `20_constraints.sql` | Duplicate chassis/container/slot, one-published-per-day, dual control, audit immutability |
| `30_rls.sql` | Denial across roles, yards and organisations; view `security_invoker`; RLS-enabled sweep |
| `40_verification.sql` | Every verification outcome, idempotency, replay conflict, authorisation |

The RLS file asserts **denial**, not permission. A policy suite that only proves the
permitted cases work is a smoke test, not a security test.
