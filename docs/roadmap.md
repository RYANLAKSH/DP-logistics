# Build Plan

Sequenced to de-risk the hard part first. Estimates assume 2 engineers (one mobile, one
backend) plus part-time design/QA.

## Phase 0 — Prove the OCR (1 week, before committing to anything else)

Not a phase of the product; a go/no-go gate.

- Collect 100+ real photos: container plates and chassis plates, in the conditions officers
  actually work in — dawn, glare, rain, rust, oil, partial obstruction, awkward angles.
- Run ML Kit against them offline. Measure read rate for each plate type separately.
- Apply the ISO 6346 check digit and measure how much it lifts container accuracy.

**Decision point.** Container read rate should land comfortably above 90% with the check
digit applied. Chassis will be lower — that's expected and fine. What you're deciding is
how prominent manual entry needs to be, and whether the vehicle registration plate should
be a required capture rather than optional. Get this wrong and you'll rebuild the capture
flow mid-project.

## Phase 1 — Walking skeleton (3–4 weeks)

The thinnest thing that enforces the rule end to end.

- `shared-rules`: check digits, normalization, outcome table, full test suite
- Auth: login, refresh, roles, device registration
- Schema + migrations
- Admin: CSV/XLSX upload → mapping → preview → commit
- Mobile: login, report list, camera capture (container + chassis), on-device OCR, verdict
  screen, image upload
- API: sync endpoints, server-side reconciliation, evidence storage
- Email: MATCH and MISMATCH via SES, recipients configurable

**Deliverable:** one officer, one location, one DO, online only. Runs a real shift.

## Phase 2 — Field-ready (3–4 weeks)

What Phase 1 will be missing the moment it meets a real yard.

- **Offline mode**: local DB, report caching, queue, background sync, conflict handling
- Manual entry paths with live check-digit validation
- Confusable-character correction and candidate proposal
- Vehicle registration plate as a secondary identifier
- Supervisor override flow with reason codes
- Admin dashboard: live board, exceptions queue, filters, CSV export
- Notification recipient management, delivery log, test-send
- Report versioning and amendments
- Device approval workflow

**Deliverable:** pilot with 5–10 officers across 2 locations, for a month. Instrument
everything: scan-to-verdict time, OCR accuracy by plate type, override rate, offline share.

## Phase 3 — Scale and harden (4–5 weeks)

- PDF report ingest (Textract), routed through the same preview
- Optional email-inbox auto-ingest of DO attachments
- Server-side OCR recheck on low-confidence scans
- Daily/weekly digests, scheduled reports
- Analytics: OCR accuracy trends, per-officer throughput, mismatch patterns by DO
- Push notifications to supervisors on mismatch (faster than email at a gate)
- Performance: image compression tuning, sync batching, index review under real volume
- Security review, penetration test, retention automation

## Phase 4 — Optional depth

Only if the pilot data says they'd pay for themselves:

- Seal number capture and verification
- Container damage photos with condition notes
- Fine-tuned OCR model on your own collected plate images — the Phase 0 corpus is the seed
- Gate-integration: pull from TOS/ERP instead of file upload
- Multi-org tenancy if this becomes a product sold to other operators
- Offline-capable admin view for supervisors in the field

## Team and sequencing notes

- Build `shared-rules` first and get it *right*. Everything else depends on it, and it's
  cheap to test exhaustively.
- The mobile capture screen will take three iterations. Budget for that rather than
  discovering it.
- Do not build the admin dashboard before the pilot. You don't yet know which numbers
  matter; the pilot tells you.
- Ship to real officers as early as Phase 1 allows. Every assumption in this document about
  how a gate operates is worth less than a week of watching someone use it.

## What "done" looks like for the pilot

| Metric | Target |
|---|---|
| Container OCR accuracy (post check-digit) | > 90% auto-read |
| Chassis OCR accuracy | > 70% auto-read, remainder manual |
| Scan-to-verdict | < 15 s per container/vehicle pair |
| Email delivery after reconciliation (online) | < 30 s |
| Override rate | < 5% of reconciliations |
| Officer adoption | > 95% of pickups reconciled through the app |

That last row is the one that matters. If officers are bypassing the app, no other number
means anything.
