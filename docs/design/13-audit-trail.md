# 13 — Audit Trail Design

## 1. What the audit trail is for

Risk 3 from §01: *there is insufficient evidence when something goes wrong.* The test is
concrete — six months later, a customer says their vehicle arrived in the wrong container.
Can the system prove what happened, to someone who is not inclined to believe it?

That standard drives three requirements:

1. **Completeness.** Every security- and business-significant action is recorded, including
   the ones that failed.
2. **Immutability.** No user, including an admin, can alter or delete history.
3. **Verifiability.** The evidence can be shown to be unaltered, not merely asserted to be.

## 2. What is logged

| Category | Events |
|---|---|
| Authentication | `auth.login`, `auth.login_failed`, `auth.logout`, `auth.password_reset`, `auth.mfa_enrolled` |
| Users | `user.created`, `user.role_changed`, `user.deactivated`, `user.yard_assigned`, `user.yard_removed` |
| Devices | `device.registered`, `device.approved`, `device.revoked` |
| Manifests | `manifest.uploaded`, `manifest.parsed`, `manifest.committed`, `manifest.superseded`, `manifest.cancelled`, `manifest.corrected` |
| Assignments | `assignment.created`, `assignment.changed`, `assignment.cancelled` |
| Movements | `movement.claimed`, `movement.submitted`, `movement.verified`, `movement.blocked`, `movement.overridden`, `movement.revalidated` |
| Scans | `scan.captured`, `scan.ocr_completed`, `scan.manual_entry`, `scan.manual_authorized` |
| Exceptions | `exception.raised`, `exception.acknowledged`, `exception.resolved`, `exception.escalated`, `exception.cancelled` |
| Overrides | `override.requested`, `override.approved`, `override.rejected` |
| Evidence | `evidence.uploaded`, `evidence.viewed`, `evidence.exported`, `evidence.purged` |
| Config | `settings.changed`, `recipients.changed`, `thresholds.changed` |

Two that are easy to omit and matter most:

- **`auth.login_failed`** — the only way to see credential stuffing.
- **`evidence.viewed`** — who looked at the images, and when. In a dispute, "was this photo
  seen by anyone before it was produced?" is a real question, and access logging is what
  makes the chain of custody meaningful rather than rhetorical.

## 3. Immutability

Three layers, because any one alone is defeatable.

**Layer 1 — no write grant.**

```sql
revoke all on audit_logs from anon, authenticated;
grant select on audit_logs to authenticated;   -- reads still go through RLS
```
No client can insert, update, or delete. Writes come only from `SECURITY DEFINER` functions.

**Layer 2 — a trigger that refuses.**

```sql
create or replace function audit_immutable() returns trigger
  language plpgsql as $$
begin
  raise exception 'audit_logs is append-only (attempted % by %)', TG_OP, current_user;
end $$;

create trigger audit_no_update before update or delete or truncate on audit_logs
  for each statement execute function audit_immutable();
```
This stops a mistaken migration and a compromised service role alike.

**Layer 3 — a hash chain**, which is what makes tampering *detectable* rather than merely
*prevented*, and it is the layer that matters against T7 (an insider with database access).

```sql
-- set by the insert trigger
row_hash = encode(digest(
    coalesce(prev_hash,'') || occurred_at || actor_id || action ||
    entity_type || entity_id || coalesce(before::text,'') || coalesce(after::text,''),
  'sha256'), 'hex')
```

Each row's hash covers the previous row's hash. Altering row 500 invalidates every hash from
501 onward, and a nightly verification job walks the chain and alerts on a break. Someone
with full database access can still rewrite the whole chain — no in-database scheme prevents
that — so:

**Anchor it externally.** Once a day, write the latest `row_hash`, the row count, and the
timestamp to somewhere the database administrator does not control: an append-only object
store bucket with object lock, a logging service, or an email to compliance. That daily
anchor is what converts "we believe our logs" into "our logs at 00:00 on 21 August hashed
to X, and here is where that was recorded at the time".

This is cheap — one row a day — and it is the difference between an audit trail and a claim.

## 4. Evidence integrity

Images are the evidence; the audit log is the narrative around them.

| Control | Mechanism | Proves |
|---|---|---|
| Content hash | SHA-256 computed on-device pre-upload, stored in `verification_attempts` | The bytes were not altered in transit or at rest |
| Duplicate detection | Perceptual hash, indexed | The same photograph was not reused across movements |
| Capture context | Device time, server receipt time, materialized skew, GPS + accuracy, device id, app version | The photograph was taken where and when it claims |
| Access log | `evidence.viewed` audit events | Chain of custody |
| Storage immutability | Private bucket, no client delete grant, versioning on | The object was not replaced |

Verification at audit time is a button on `/audit/movement/:id`: fetch the object, hash it,
compare to `image_sha256`, show ✓ or ✗. If it cannot be demonstrated in the UI, nobody will
ever check it, and an integrity control nobody exercises is decoration.

## 5. Manifest corrections

The build plan calls these out specifically, and they are the highest-risk mutation in the
system: changing the source of truth after work has been done against it.

Every correction records:

```
manifest_corrections
  ├── manifest_id, assignment_id
  ├── field            'container_no' | 'chassis_no' | 'sequence' | 'capacity'
  ├── before_value     ← mandatory
  ├── after_value      ← mandatory
  ├── reason           ← mandatory, minimum length enforced
  ├── corrected_by, corrected_at
  ├── new_version_id   the manifest version the correction produced
  └── affected_movements[]  movements already verified against the old value
```

Rules:

- A correction **never mutates a row**. It creates a new manifest version (§06 §3), and the
  correction record explains the diff between versions in business terms.
- `reason` is mandatory and free text is required — a dropdown alone lets people click
  through. Minimum length is enforced by a `check` constraint, not by the form.
- If the correction affects a movement already verified, the correction cannot be committed
  without the admin acknowledging the list of affected movements (§04 §5, §07 §3).
- Every correction emails admin and auditor. Silent correction of the source of truth is
  precisely the abuse this system is supposed to make impossible.

## 6. Retention

| Data | Retention | Reason |
|---|---|---|
| `audit_logs` | Indefinite, partitioned monthly | Small, and it is the record |
| `movement_events`, `exceptions`, `overrides`, `verification_attempts` | Indefinite | Same |
| Evidence images | 24 months, configurable | Storage cost; the hash outlives the image |
| `manifest_imports.parsed_rows` | 90 days | Bulky; the committed version is the record |
| Source manifest files | Indefinite | Kilobytes |

When an image is purged, the `verification_attempts` row and its hashes remain, and an
`evidence.purged` audit event is written. So a record always exists showing that a
photograph was taken, what it hashed to, and that it was deleted by policy at a stated time
— which is a materially different situation from a gap.

## 7. Reading the audit trail

An audit log nobody can query is a compliance artifact, not a control.

- `/audit` — search by chassis, container, driver, date range, outcome, exception status.
- `/audit/movement/:id` — the timeline in §04 §6, with inline evidence and a hash-verify
  button.
- `/audit/container/:no` and `/audit/vehicle/:chassis` — the entity-centric views, which are
  what a dispute actually starts from. Nobody phones up with a movement id.
- `/audit/export` — a signed bundle: records as CSV/JSON, images, the manifest version, and
  a manifest of hashes. Generated by an Edge Function, delivered as a time-limited signed
  URL, and the export itself is audited.

Export excludes driver PII by default. An auditor who needs it requests it explicitly, and
that request is logged.
