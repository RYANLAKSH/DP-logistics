# 15 — Recommended Implementation Sequence

## 1. Order, and the reasoning behind it

The build order follows the 17-phase plan. Two principles drive it:

**Build the trust boundary before the things that depend on it.** The database, RLS, and the
server-side verification function are load-bearing. Building UI first and retrofitting
authorization produces a system where the security model is whatever the UI happened to
need — which is how frontend authorization gets baked in.

**Every phase ends with something testable.** Not a demo — a build that passes its checks.

| Phase | Deliverable | Exit criteria |
|---|---|---|
| 1 | Design set (this directory) | The five decisions in the index are agreed |
| 2 | Schema, RLS, migrations, storage policies | pgTAP passes, including denial tests. `supabase db reset` is clean |
| 3 | PWA shell, all routes, mock data | Builds with zero TS errors; mock layer isolated behind one module |
| 4 | Supabase Auth, roles, guards | All three roles log in; unauthorized routes blocked at the route *and* at the data |
| 5 | Manifest upload, validation, preview, publish | Valid and deliberately invalid files both behave correctly; history preserved |
| 6 | Driver sequential workflow on real data | A driver sees only their assignments, in order, and cannot skip |
| 7 | Camera + OCR behind a provider interface | Both plates scan; low confidence forces a retake; images land in Storage |
| 8 | **Server-side verification engine** | All eight outcome cases; idempotent under double-tap, retry, concurrency |
| 9 | Exceptions and resolution | Driver raises, cannot resolve; manager resolves; history intact |
| 10 | Realtime dashboard | Updates with no refresh; filters work; RLS holds under subscription |
| 11 | Evidence chain — photos, GPS, viewer | Private buckets, no public URL, permission denial handled |
| 12 | Audit log and manifest corrections | Append-only enforced; corrections carry before/after/reason |
| 13 | PWA offline and sync | Offline capture works; queued items never show as verified |
| 14 | Security audit | Every finding fixed, not just listed |
| 15 | Test suite | Unit, integration, DB, RLS, E2E all green |
| 16 | Production readiness | Deployment guide, monitoring, backups, rollback |
| 17 | Business acceptance | Gaps identified and critical safeguards implemented |

## 2. Phase 8 is the phase that matters

If the schedule slips, protect phase 8. Everything before it is scaffolding for it, and
everything after it assumes it is correct.

The temptation, under pressure, is to let the client's verdict drive completion "for now,
and harden it later". That shortcut is not a shortcut — it is a different product, one where
the control is advisory. The build plan's own closing rule says to reject any shortcut that
weakens server-side verification, RLS, auditability, or manifest-as-source-of-truth, and
this is the specific place that pressure will appear.

## 3. Schema naming — reconciling this design with the build plan

§06 of this design set was written before the phase-2 brief specified its table names. Where
they differ, **the build plan's names are canonical** and phase 2 implements those. The
mapping:

| §06 design name | Canonical name (phase 2 onward) |
|---|---|
| `manifest_versions` (+ `manifests`) | `manifests`, versioned in place with `version` + `status` |
| `manifest_containers` | `containers` |
| `manifest_vehicles` | `vehicle_assignments` |
| `movements` | `movement_events` |
| `scans` | `verification_attempts` (+ evidence rows) |
| `audit_events` | `audit_logs` |
| `exceptions`, `overrides`, `devices`, `profiles` | unchanged |

The substance is unchanged — every constraint, state machine, and policy argued in §06
carries over. Only the identifiers move.

Similarly, the role vocabulary: this design set uses `driver` / `supervisor` / `admin` /
`auditor`; the build plan specifies `DRIVER` / `MANAGER` / `ADMIN`. Phase 2 implements
`DRIVER`, `MANAGER`, `ADMIN` as the enum, with `MANAGER` carrying the supervisor
capabilities described throughout §03 and §12, and `ADMIN` carrying the admin and auditor
capabilities. A separate read-only `AUDITOR` role can be added later without schema change —
the policies are already written in terms of a role check.

## 4. What to build first inside each phase

A note on sequencing *within* phases, because the order inside phase 2 and phase 8 matters:

**Phase 2** — enums, then tables, then constraints, then RLS, then functions, then pgTAP.
Writing the denial tests immediately after the policies (not at the end) is what keeps them
honest; written later, they get written to match whatever the policies happen to do.

**Phase 8** — write the outcome table from §07 §2 as pgTAP tests *first*, then implement
`verify_movement()` until they pass. The eight outcomes and their evaluation order are a
specification, and they are far easier to get right test-first than to verify afterwards.

## 5. Cross-cutting work that does not get its own phase

Easy to defer forever, so name it now and attach it to a phase:

| Work | Attached to |
|---|---|
| Structured logging and error reporting | Phase 3, extended each phase |
| OCR quality metrics (raw text, confidence, final value) | Phase 7 — retrofitting loses the first month's tuning data |
| Accessibility: contrast, tap targets, no colour-only status | Phase 3, verified in phase 16 |
| Seed data and fixtures for local development | Phase 2 |
| CI: build, typecheck, unit tests, pgTAP, RLS-coverage check | Phase 2, extended each phase |
| Rate limiting | Phase 14 |

## 6. Sequencing risks

- **Phase 7 (OCR) may take longer than planned.** R2 in §14. It is deliberately after the
  driver workflow, so a delay leaves a working manual-entry app rather than nothing.
- **Phase 13 (offline) touches everything built before it.** The outbox changes how every
  driver mutation is submitted. Design the submission path in phase 6 to go through a single
  module, so phase 13 rewrites one file rather than every screen.
- **Phase 14 may reopen phase 2.** A finding in RLS means a migration and re-testing. Budget
  for it; a security audit that changes nothing was not an audit.
