# 07 — Data Flows

Four flows carry the product. Everything else is CRUD.

## 1. Manifest import → live assignments

```
Admin browser                Storage            Edge Function            Postgres
─────────────────────────────────────────────────────────────────────────────────
 select file
   │ sha256 in browser
   ├──── signed upload ──────►  manifests/
   │                            {org}/{yard}/{date}/{sha}.xlsx
   ├──── invoke parse-manifest ──────────────►
   │                                     read file
   │                                     detect columns (or reuse saved map)
   │                                     per row:
   │                                       normalize container + chassis
   │                                       ISO 6346 check digit
   │                                       dup container / dup chassis
   │                                       slot & capacity sanity
   │                                          │
   │                                          ├── insert manifest_imports ─────►
   │◄──── {valid, rejected[], warnings[]} ────┤   status='ready'
   │
 PREVIEW  ── admin reviews, fixes at source or excludes rows
   │
   ├──── rpc commit_manifest_import(import_id) ────────────────────────────────►
   │                                     (SECURITY DEFINER, one transaction)
   │                                       lock manifests row
   │                                       next version = max+1
   │                                       insert manifest_versions (draft)
   │                                       insert containers + vehicles
   │                                       compute diff vs previous active
   │                                       supersede previous active
   │                                       set this version active
   │                                       insert audit_event manifest.committed
   │◄──── {version, diff, affected_movements[]} ───────────────────────────────┤
   │
   └── if affected_movements is non-empty → re-verify each (§3 below)
```

**Why parsing is an Edge Function and committing is an RPC.** Parsing needs XLSX libraries
and produces no durable state; committing must be atomic against concurrent uploads and
must run with `auth.uid()` available. Splitting them at that seam also means a parse failure
never leaves a half-written manifest.

**Preview is not skippable.** `commit_manifest_import` requires an import in status `ready`
and refuses one whose `parsed_rows` it has not itself produced. There is no code path that
uploads and commits in one call, because the day someone adds one for convenience is the
day a malformed file blocks every truck at the gate.

### 1a. What the real pickup list looks like

The parser was written against an assumed shape — one row per vehicle, container number on
every row, a sequence column. The customer's actual list is none of those things:

```
      A     B                   C                 D             E            F
 1    TATA MOTORS CULVNSA2601795 20x40
 2    SR    CHASSIS NO           MODEL             INVOICE NO    CONT NO      SEAL
 3    1     MAT752389T7R20507    T.7 ULTRA …       MH2730495315  TGCU5033177  11866
 4    2     MAT464844TSR09249    …YODHA …          MH2730502737
 5    3     MAT752389T7R18439    T.7 ULTRA …       MH2730495315  CAIU7456843  13046
 6    4     MAT464844TSR09184    …YODHA …          MH2730502737
```

Four things in that block break naive parsing, and each has a named answer in the code:

| What the file does | What it breaks | Answer |
|---|---|---|
| Title on row 1, header on row 2 | Assuming row 0 is the header | `findHeaderRow` scans the first ten rows for a usable mapping |
| Chassis in column B, container in column E, plus `INVOICE NO` and `SEAL` | Positional parsing | Headers matched by synonym, never by position |
| **Container written once per pair**; the second vehicle's cell is blank | Every second row rejected as `CONTAINER_MISSING` | Container carry-forward, below |
| `SR` runs 1..40 down the sheet | Read as a slot, every row past the sixth is `SEQUENCE_INVALID` | `SR` is deliberately not a `sequenceNo` synonym; slot comes from row order within the container |

**Container carry-forward** is the one inference this parser makes, and it is the reason the
real file is usable at all — without it, half of every manifest is rejected. It is bounded
and disclosed rather than open-ended:

- A blank container cell inherits from the row above **only** while that container is still
  below its expected vehicle count. A third blank row is still `CONTAINER_MISSING`, because
  nobody assigned that vehicle anywhere.
- A container written out again on the next row counts as a second vehicle rather than
  restarting the count, so a file that repeats the number on every row never inherits into
  a row that genuinely has none.
- Every inherited row carries a `CONTAINER_INHERITED` warning naming the container and the
  row it came from, and the preview marks it *from row above* beside the number. A manager
  approves the manifest before a driver can see it, so the inference is reviewed by a human
  every time — which is the difference between an inference and a guess.
- Inheriting is not a way past validation: an inherited number goes through the same
  character and ISO 6346 check-digit rules as a written one.

**`CULVNSA2601795` is the booking reference, not a container.** It appears in the sheet
title; the real containers are ISO 6346 numbers in column E. The system accepts both
shapes, applying the check digit only to identifiers that are ISO-shaped, because operators
do route their own references through the same column.

**One number in the customer's own file fails its check digit** — `BMOU6433014`, where
`BMOU6433015` is the valid form. Twenty of the twenty-one are clean. That row is rejected
at upload rather than warned about, and the error names the digit that would make it valid.
Rejecting costs one correction before publishing; accepting it costs a driver standing at a
container whose real number will never match the manifest, with a manager on the phone.

## 2. Movement verification — the critical path

```
Driver PWA                                              Postgres
──────────────────────────────────────────────────────────────────────────────────
 task claimed (movement id generated client-side = idempotency key)
   │
 scan container ──► OCR worker ──► candidates
   │                                filter ^[A-Z]{4}[0-9]{7}$
   │                                ISO 6346 check digit          ◄── local, instant
   │                                match against expected
   ├─ human confirms
 scan chassis  ──► OCR worker ──► normalize (VIN confusables)
   │                                match against expected + all other manifest lines
   ├─ human confirms
   │
 ADVISORY VERDICT (shared-rules, against IndexedDB manifest cache)   ← shown immediately
   │
   ├──── upload images (signed URLs) ──► Storage  (private, path-scoped)
   │
   └──── rpc verify_movement({                                 ─────────────►
             movement_id, assignment_id,
             scanned_container_no, scanned_chassis_no,
             scan_ids[], client_verdict,
             device_key, gps, submitted_at_device
         })
                                    ┌─────────────────────────────────────────┐
                                    │ ONE TRANSACTION                         │
                                    │ 1. assert caller is driver, yard-scoped │
                                    │ 2. assert device approved               │
                                    │ 3. load assignment via its CURRENT      │
                                    │    active manifest version              │
                                    │ 4. lock the container row (FOR UPDATE)  │
                                    │ 5. re-run the comparison in plpgsql     │
                                    │    (never trust client_verdict)         │
                                    │ 6. capacity + already-loaded checks     │
                                    │ 7. upsert movement on id (idempotent)   │
                                    │ 8. link scans                           │
                                    │ 9. on failure → insert exception        │
                                    │ 10. insert audit_event                  │
                                    └─────────────────────────────────────────┘
   │◄──── {status, outcome, explanation, other_assignment?} ──────────────────┤
   │                                                              │
 RESULT SCREEN                                          pg_net → notify fn → email/push
                                                        Realtime → supervisor board
```

Step 5 is the whole design. The client already computed a verdict and the server ignores
it as an input — it stores it only to compare. If the two disagree, both are recorded and
the disagreement is surfaced (§08 anti-fraud, §10 stale-cache).

Step 3 is subtle and matters: the RPC resolves the assignment through the *currently
active* manifest version, not through the version the client cached. A driver working from
a superseded cache gets outcome `manifest_superseded` and a clear instruction to sync,
rather than a verification against stale data.

### The comparison, in order

Evaluated top to bottom; first hit wins. Ordering is part of the specification — a movement
that is both `container_full` and `wrong_vehicle` must report `wrong_vehicle`, because that
is the more serious and more actionable fact.

| # | Condition | Outcome | Driver sees |
|---|---|---|---|
| 1 | Cached manifest version ≠ active version | `manifest_superseded` | Sync required. Blocked |
| 2 | Scanned container ≠ expected container | `wrong_container` | Blocked, names the correct container |
| 3 | Scanned chassis ≠ expected chassis, matches another assignment | `wrong_vehicle` | Blocked, names that vehicle's real container |
| 4 | Scanned chassis matches nothing in the manifest | `vehicle_not_on_manifest` | Blocked |
| 5 | Scanned container is on no manifest line | `container_not_on_manifest` | Blocked |
| 6 | This vehicle already has a verified movement | `vehicle_already_loaded` | Blocked, shows when and by whom |
| 7 | Container already at capacity | `container_full` | Blocked |
| 8 | Both match | `match` | **VERIFIED** |

Rows 2 and 3 are risks 2 and 1 from §01. Everything else is operational hygiene.

Container comparison is **exact after normalization, never fuzzy** — the ISO 6346 check
digit means a valid-but-different number is a genuinely different container, not a misread.
Chassis comparison allows the graded matching in
[`docs/reconciliation-rules.md` §4](../../reconciliation-rules.md), because chassis plates
carry no reliable check digit; anything below an exact match requires the driver to confirm
explicitly and is recorded as fuzzy.

## 3. Manifest amendment → re-verification

```
commit_manifest_import  (v2 becomes active)
   │
   ├── diff v1 → v2 per assignment
   │
   └── for each movement verified against v1 whose assignment changed:
           re-run the comparison against v2
              still matches  → audit_event movement.revalidated. No user impact
              now mismatches → movement stays 'verified' (the vehicle is physically
                               in the container; a row cannot unload it)
                             → NEW exception 'manifest_error', severity high
                             → notify supervisor + admin immediately
                             → movement flagged manifest_conflict on every screen
```

The judgement here: **do not retroactively invalidate a verified movement.** It happened.
The truck left. What the system owes is a loud, permanent flag and a human in the loop —
not a status change that quietly rewrites history and destroys the audit trail's meaning.

## 4. Evidence upload

```
Browser                                    Storage                    Postgres
──────────────────────────────────────────────────────────────────────────────────
 capture frame → canvas → JPEG q0.8, long edge 1600px
   │
 sha256(blob)  (Web Crypto, in the worker)
 phash(blob)   (perceptual hash, for duplicate detection)
   │
 rpc create_signed_upload(movement_id, kind)  ─────────────────────►
   │                              validates caller owns the movement,
   │                              returns a signed URL for exactly this path:
   │                              evidence/{org}/{yard}/{date}/{movement}/{kind}.jpg
   │◄──────────────────────────────────────────────────────────────┤
   ├──── PUT ────►  private bucket
   │
   └──── rpc register_scan({id, movement_id, kind, image_path, sha256,
                            phash, ocr_text_raw, confidence, value_final, source})
                                                          ─────────►  insert scans
                                                                      + audit_event
```

Two points that are easy to get wrong:

- **The client never chooses the storage path.** It asks for a signed URL for a movement it
  owns, and the server constructs the path. A client-supplied path is a write-anywhere
  primitive.
- **The hash is computed before upload and stored server-side.** Computing it server-side
  after upload proves only that the bytes in the bucket hash to what they hash to. Computing
  it on the device and comparing later proves the bytes were not altered in transit or at
  rest.

Uploads are queued and retried offline (§10). The movement can be verified before its
images have finished uploading — a verified movement with `pending_evidence` is a normal,
short-lived state, and the board shows it. Verification blocking on a 4 MB upload over a bar
of signal would make the app unusable in exactly the conditions it was built for.

## 5. Notification fan-out

```
verify_movement() commits
   │  (no external call inside the transaction — ever)
   └── pg_net async request, or Database Webhook on movements/exceptions
          │
          └── notify Edge Function
                 ├─ resolve recipients: yard + event type, from the recipients table
                 ├─ render template
                 ├─ email provider  /  Web Push
                 ├─ insert notifications row (queued → sent)
                 └─ provider webhook → update to delivered | bounced
```

| Event | Recipients | Timing |
|---|---|---|
| `movement.blocked` | Yard supervisor (push + email), ops | Immediate, high priority |
| `override.approved` | Admin, auditor | Immediate |
| `manifest.committed` | Yard supervisors | Immediate |
| `manifest.conflict` | Admin, supervisor | Immediate, high priority |
| `device.pending_approval` | Yard supervisor | Immediate |
| `movement.verified` | — | Not sent individually. Digest only |
| Shift completeness summary | Supervisor, admin, ops | Scheduled, end of yard shift |

Rate-limit per recipient. One bad manifest can otherwise generate two hundred blocked-
movement emails in a minute and get the alerts spam-filtered exactly when they matter.
Verified movements are never emailed individually — the digest is what people actually read.

**Never call an external service inside the verification transaction.** A slow email
provider must not hold a row lock on a container while a driver waits at a ramp.
