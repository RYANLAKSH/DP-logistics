# DP Logistics — Container/Vehicle Reconciliation

Field officers photograph a container's ID plate and the assigned vehicle's chassis
plate. The system reads both numbers, checks them against the pickup report issued by
the DO, and confirms — or blocks — the pairing before the vehicle leaves the yard.

**The rule being enforced:** the right vehicle goes to the right container, as listed on
the pickup report. Nothing else.

## Documents

| Doc | What's in it |
|---|---|
| [docs/architecture.md](docs/architecture.md) | System design, stack choice, components, offline strategy, security |
| [docs/data-model.md](docs/data-model.md) | Postgres schema, state machines, retention |
| [docs/reconciliation-rules.md](docs/reconciliation-rules.md) | Matching logic, OCR validation, check-digit algorithms, outcome codes |
| [docs/api.md](docs/api.md) | REST surface for mobile + admin |
| [docs/roadmap.md](docs/roadmap.md) | Phased build plan |

## The 60-second version

```
Field Officer (mobile, offline-capable)
  1. Open job → pick a pickup report (cached on device)
  2. Photograph container ID plate → on-device OCR → ISO 6346 check digit validates → confirm
  3. Photograph vehicle chassis plate → on-device OCR → confirm
  4. App reconciles LOCALLY against the cached report → instant PASS / FAIL on screen
  5. Evidence (images + GPS + timestamps) queues for upload

Backend
  6. Re-runs reconciliation server-side (device result is advisory, never authoritative)
  7. Writes an immutable reconciliation record
  8. Emits an event → email worker → notification within seconds

Admin (web)
  - Upload pickup reports (XLSX/CSV/PDF) → parse → preview → commit → versioned
  - Live board of today's reconciliations, mismatches highlighted
  - Manage users, roles, email recipient lists
```

## Non-negotiable design decisions

1. **Offline-first.** Yards and port gates have unreliable connectivity. The officer must
   get a PASS/FAIL on screen with zero network. Sync happens later.
2. **The server is the source of truth.** The device's verdict is a UX affordance. The
   server re-computes it on ingest, and that record is what emails and audits use.
3. **OCR is never trusted blindly.** Container numbers carry an ISO 6346 check digit —
   use it. Every scan is human-confirmed before it counts.
4. **Every decision is evidence-backed.** Image, GPS, timestamp, device, officer, and the
   exact report version matched against. Disputes are settled from this record.
5. **A mismatch blocks and escalates.** It is not a warning the officer can dismiss.
   Overrides exist, require a reason code, and notify a supervisor.
