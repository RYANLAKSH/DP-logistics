# 12 — Exception Workflow

## 1. Principle

An exception is what happens when the system stops a movement. It is not an error message —
it is a work item with an owner, a lifecycle, and a permanent record.

Three rules, and they are the whole design:

1. **A driver can raise an exception. A driver can never resolve one.** The person who hit
   the block is not the person who clears it.
2. **A block is never dismissible.** There is no "continue anyway" in the driver role. The
   only way past a block is a supervisor's authenticated decision.
3. **Nothing is deleted or edited.** Resolution appends. An exception's history is complete
   from raise to close, and a cancelled exception still exists.

## 2. Types

| Type | Raised by | Typical cause | Blocks the movement? |
|---|---|---|---|
| `mismatch_container` | System | Scanned container ≠ assignment | Yes |
| `mismatch_chassis` | System | Scanned chassis ≠ assignment — **the core case** | Yes |
| `wrong_vehicle` | System | Scanned chassis belongs to a different container | Yes |
| `wrong_container` | System | Scanned container is another vehicle's assignment | Yes |
| `ocr_failure` | Driver | OCR could not read after retries | No — manual entry path |
| `container_unreadable` | Driver | Plate painted over, damaged, obscured | Yes, pending authorization |
| `chassis_unreadable` | Driver | Stamped plate illegible or inaccessible | Yes, pending authorization |
| `vehicle_absent` | Driver | Vehicle not in the yard | Task parked |
| `container_absent` | Driver | Container not at its stated position | Task parked |
| `container_full` | System | Capacity already reached | Yes |
| `vehicle_already_loaded` | System | Vehicle has a verified movement already | Yes |
| `manifest_error` | Supervisor | The manifest is wrong, not the driver | Yes, until amended |
| `manifest_conflict` | System | Amendment invalidated a verified movement | Informational, high priority |
| `sync_failure` | System | Outbox item unsynced beyond 24 h | Yes |
| `device_unapproved` | System | Login from an unregistered device | Driver blocked from completing |
| `other` | Driver | Free text, mandatory | Task parked |

System-raised exceptions are written by `verify_movement()` inside the same transaction that
blocks the movement. There is no path where a movement is blocked and no exception exists —
they are the same write.

## 3. Lifecycle

```
                      ┌────────┐
   raised ───────────►│  OPEN  │
                      └───┬────┘
              supervisor opens it
                      ┌───▼────────────┐
                      │ UNDER_REVIEW   │───── escalate ──► admin queue
                      └───┬────────────┘
                          │  resolution + code, mandatory
                      ┌───▼────────┐         ┌────────────┐
                      │  RESOLVED  │         │ CANCELLED  │  (raised in error;
                      └────────────┘         └────────────┘   kept, never deleted)
```

Resolution codes — a taxonomy, because free text produces data nobody can analyse:

| Code | Meaning | Side effect |
|---|---|---|
| `corrected_and_rescanned` | Driver error. They rescanned correctly | Movement proceeds normally |
| `manifest_amended` | The manifest was wrong; admin published a correction | Movement re-verified against the new version |
| `override_approved` | Genuine operational exception; supervisor authorized it | Movement → `overridden`, override row written |
| `manual_entry_authorized` | Plate unreadable; supervisor authorized typed entry | Movement proceeds, scan marked `manual_authorized` |
| `task_reassigned` | Another driver took it | Task returns to the pool |
| `vehicle_rescheduled` | Vehicle not available today | Assignment cancelled for this manifest |
| `no_action_required` | Investigated, nothing to do | — |
| `false_alarm` | System raised it wrongly | Flagged for engineering review |

`false_alarm` deserves attention: a rising count means the verification rules or the OCR
thresholds are wrong, and it should be reported weekly. A system that cries wolf gets
overridden reflexively, which is how a control quietly dies.

## 4. Overrides — the dangerous path

An override lets a vehicle be loaded into a container the manifest did not assign. It is the
one operation that defeats the product's core control, so it is the most constrained.

```
Driver blocked
   │  taps "Request supervisor override", picks a reason, adds a note
   ├──► exception status OPEN, override_requested = true
   │    ├─ realtime → supervisor board
   │    └─ web push + email → supervisor, ops
   │
Supervisor, ON THEIR OWN DEVICE, in their own session:
   │  sees both photographs, expected vs scanned, GPS, driver, timestamps
   │  ├─ REJECT → exception resolved 'corrected_and_rescanned'. Movement stays blocked
   │  └─ APPROVE → reason code (mandatory) + note
   │        └─ rpc approve_override(exception_id, reason, note)
   │              · asserts caller is supervisor/admin for that yard
   │              · asserts approver ≠ requester (also a CHECK constraint)
   │              · movement → 'overridden'
   │              · overrides row written
   │              · audit_event
   │              · immediate email to admin + auditor
   │
Driver's screen updates in realtime: "Override approved by A. Sharma — proceed"
```

**The approval happens on the supervisor's device.** Not a PIN typed into the driver's
phone, not a code read over the radio. Both of those reduce dual control to "the supervisor
told me the number once", which is not dual control. The cost is that a supervisor must be
reachable; that cost is the point.

Reason codes: `last_minute_substitution`, `manifest_error`, `damaged_plate`,
`operational_exception`, `other` (free text mandatory, minimum length enforced in a `check`
constraint).

**Override monitoring is a first-class feature, not a report someone might run.** On the
admin dashboard, permanently:

- Override rate per driver, per supervisor, per yard, trended weekly.
- Any supervisor approving more than 20% of the overrides in a yard.
- Any driver-supervisor pair appearing repeatedly. This is the collusion signal (T3, §08),
  and it is invisible in aggregate numbers.

A rising override rate has exactly two causes — bad manifest data or process abuse — and
both need a human to look. The number being on a screen is what makes anyone look.

## 5. Unreadable plates

Expected to be a meaningful share of exceptions, not a rare edge case. Container plates get
painted over; chassis plates get corroded.

```
Driver: "I can't read this plate"
   → photograph is still mandatory — of the plate area, whatever state it is in
   → for a vehicle, capture the registration plate as a secondary identifier
   → exception raised, supervisor notified
   → supervisor reviews the photo and either:
        · authorizes manual entry for THIS MOVEMENT ONLY
          (scans.source = 'manual_authorized' — permanently distinguishable in the audit)
        · or rejects and sends someone to clean/verify the plate physically
```

Manual entry is authorized per movement, never as a mode a driver can switch on. A driver
who could enable manual entry themselves has a way to bypass every scan in the system, which
would make the product decorative.

## 6. Ageing and escalation

Exceptions that sit are exceptions that failed.

| Age | Action |
|---|---|
| 0 min | Realtime + push to yard supervisor |
| 15 min | Re-notify supervisor; highlight red on the board |
| 30 min | Escalate to admin, email ops |
| 60 min | Daily-summary flag; counts toward the yard's SLA metric |
| 24 h | Auto-escalate to `escalated`, admin queue, weekly review |

A truck at a ramp for 30 minutes is an operational problem regardless of who is at fault,
so the escalation ladder is time-based and does not wait for anyone to notice.

## 7. End-of-shift sweep

The exception nobody raises. Run at the yard's shift end, and surface it on `/shift-report`
and by email:

```
NHAVA SHEVA · 21 Aug · shift close

  ⚠ 3 containers partially loaded
      TGHU7781237   1 of 2   missing MAT449900PJ0001
      CAIU2298766   1 of 2   missing MAT450012PJ7788
      MSCU9087610   0 of 2   not started

  ⚠ 2 movements pending sync for more than 4 hours   (drivers: S. Patel)
  ⚠ 1 exception open for 6 hours
     4 overrides today (12% — above the 5% threshold)
```

Every line here is an error class that per-movement verification cannot detect, because each
individual movement was correct. Partial loading is the most consequential: a container
sealed with one vehicle instead of two is a real financial and customs problem, and nothing
in the scan flow can see it.
