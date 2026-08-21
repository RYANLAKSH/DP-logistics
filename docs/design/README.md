# DP Logistics — Design Set (PWA / Supabase)

**Status:** design only. No application code is written against this yet.

This directory is the authoritative design for the product described in the brief:

> A logistics company moves vehicles from a yard into shipping containers. A daily
> manifest assigns vehicle chassis numbers to specific containers — normally two vehicles
> per container. The manifest is the source of truth. The driver is shown the next
> assigned container and chassis number, must physically scan both, and the movement can
> only be completed when both match.

## Documents

| # | Doc | Covers |
|---|---|---|
| 01 | [Product requirements](01-product-requirements.md) | Problem, scope, functional and non-functional requirements, success metrics |
| 02 | [System architecture](02-architecture.md) | Components, stack, the decisions that constrain later development |
| 03 | [Roles and permissions](03-roles-and-permissions.md) | Four roles, the permission matrix, where each rule is enforced |
| 04 | [User journeys](04-user-journeys.md) | Driver, supervisor, admin, auditor — step by step |
| 05 | [Application routes](05-routes.md) | URL map, guards, what each screen may assume |
| 06 | [Database entities](06-data-model.md) | Schema, state machines, constraints, RLS shape |
| 07 | [Data flows](07-data-flows.md) | Manifest import, movement verification, evidence, notification |
| 08 | [Security architecture](08-security.md) | Authn/authz, RLS, RPC boundary, storage, anti-fraud, threat model |
| 09 | [OCR strategy](09-ocr-strategy.md) | Two-tier OCR, constrained matching, acceptance rules, manual entry |
| 10 | [Offline / PWA strategy](10-offline-pwa.md) | Caching tiers, queueing, provisional state, install and update |
| 11 | [Realtime dashboard](11-realtime.md) | Subscription model, RLS under realtime, scaling path |
| 12 | [Exception workflow](12-exceptions.md) | Exception types, lifecycle, override and dual control |
| 13 | [Audit trail](13-audit-trail.md) | Append-only events, evidence integrity, retention, export |
| 14 | [Risks and edge cases](14-risks-and-edge-cases.md) | What will actually go wrong, and the mitigation for each |
| 15 | [Implementation sequence](15-implementation-sequence.md) | Phased build order with exit criteria per phase |

## The five decisions that shape everything downstream

If you read nothing else, read these. Each one is argued in the linked document, and each
one is expensive to reverse once code exists.

1. **The client never decides a match.** The browser computes an advisory verdict for
   instant feedback, but a movement is completed only by a server-side function that
   re-runs verification against the manifest. The front end has no write path that can set
   a movement to `verified`. → [02](02-architecture.md#3-the-verification-boundary),
   [08](08-security.md)

2. **Authorization lives in Postgres, not in React.** Every table is RLS-protected and
   default-deny. Route guards exist for UX only; removing them must not grant a user any
   data. → [08](08-security.md#3-row-level-security)

3. **Verification is a confirmation problem, not a recognition problem.** Because the
   manifest tells us what we expect to see, OCR only has to confirm a known candidate — a
   far easier task than open-ended reading. This is what makes browser-based OCR viable,
   and it comes with a false-confirmation risk that §9 handles explicitly with a margin
   rule. → [09](09-ocr-strategy.md)

4. **Offline capture is supported; offline completion is provisional.** A driver with no
   signal can scan, get an advisory verdict, and queue the movement — but it stays
   `pending_verification` until the server confirms it, and the UI says so. Anything else
   would mean trusting the device. → [10](10-offline-pwa.md)

5. **Manifests are immutable and versioned.** An amendment creates a new version; lines
   are never edited in place. Every movement records the exact manifest version it was
   verified against. → [06](06-data-model.md#3-manifests), [07](07-data-flows.md)

## Relationship to the earlier documents in `docs/`

`docs/architecture.md`, `docs/data-model.md`, `docs/api.md`, `docs/security.md` and
`docs/documents.md` describe an earlier direction: a native Expo app against a self-hosted
NestJS + Postgres API, framed around a DO-issued *pickup report* rather than a daily
manifest. That work is prior art and is **superseded** by this directory for the PWA build.

Two things carry over essentially unchanged, because they are properties of the domain
rather than of the stack, and they are cited rather than restated here:

- [`docs/reconciliation-rules.md`](../reconciliation-rules.md) §1–2 — the ISO 6346 check
  digit and the normalization/confusable-character rules. Still correct, still the highest
  leverage code in the system.
- The existing `packages/shared-rules` implementation and its test suite, which port to
  this architecture without change and will be consumed by both the PWA and the Edge
  Functions.
