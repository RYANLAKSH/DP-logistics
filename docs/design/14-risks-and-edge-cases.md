# 14 — Risks and Edge Cases

## 1. Top project risks

Ordered by expected damage, which is likelihood × cost, not by how technical they sound.

### R1 — Drivers work around the app

**The single biggest risk, and it is not technical.** If a FAIL is slow, or the camera is
flaky, or the app blocks something the driver knows is fine, they will wave the vehicle
through and reconcile later — or reconcile from the cab, in bulk, at the end of the shift.
The system then produces perfect records of a process that did not happen.

Mitigations:
- Make the compliant path faster than the workaround. Under 60 seconds, two scans (§01).
- Measure the gap between `verified_at` and the physical departure. A cluster of movements
  all verified within two minutes at the end of a shift is bulk back-filling — surface it.
- Watch manual-entry rate and override rate per driver (§09, §12).
- A container marked complete with no scans in the preceding hour is a signal, not a stat.
- Ask drivers what is slow, monthly, and act on it. This is a product risk with a product
  answer.

### R2 — OCR accuracy on chassis plates

Stamped metal, oil, dirt, poor angles, no check digit. This is the top *technical* risk and
it is fully mitigated only in the sense that manual entry always works.

Mitigations: registration plate as a secondary identifier; first-class manual entry with
live character-level validation; tunable thresholds in the database; tier-2 server OCR ready
to promote if the manual-entry rate exceeds 25% (§09).

### R3 — A false PASS

The worst possible failure, because it is invisible. A wrong vehicle is verified and loaded,
and the system says it was correct. The likeliest cause is the confirmation bias described in
§09 §1: an OCR pipeline that is looking for the expected string finds it in noise.

Mitigations: the margin rule (best candidate must beat the runner-up from the whole manifest
by ≥ 0.15); no fuzzy matching on containers at all; every scan photographed so a false pass
is at least discoverable afterwards; sample audits comparing photographs to recorded values.

### R4 — A manifest changes mid-operation

Operations amends the manifest at 11:00. Six movements are already verified against v1, two
of them for assignments the amendment changed. The vehicles are physically inside containers.

Mitigations: versioned manifests; the amendment preview shows affected verified movements
before commit; verified movements are never retroactively invalidated — they are flagged
`manifest_conflict` and escalated to a human (§07 §3). The system's job here is to be loud,
not to be clever.

### R5 — Two drivers, one vehicle or one container slot

Concurrency at shift change, made worse by offline claims.

Mitigations: `SELECT … FOR UPDATE` on the container row inside the verification transaction;
a unique partial index preventing two verified movements for one assignment; offline claims
are provisional and the loser is told clearly (§10 §7).

### R6 — Partial container loading

Every scan passes; the container gets one vehicle instead of two; it is sealed and shipped.
No per-movement check can see this.

Mitigation: the end-of-shift completeness sweep (§12 §7), which is a v1 requirement
precisely because it catches what verification structurally cannot.

### R7 — RLS misconfiguration

One missing policy or one `security_invoker = false` view exposes another organization's
data. Silent until someone finds it.

Mitigations: default deny everywhere; pgTAP tests asserting denial, not just permission; a
CI check failing any `public` table with `rowsecurity = false`; separate Supabase projects
per environment; a manual RLS review before each production migration.

### R8 — Storage or connectivity loss of evidence

Images queued on a phone that is lost, wiped, or runs out of storage. The movement is
verified; the evidence never arrives.

Mitigations: `navigator.storage.persist()`; storage warnings at 100 MB and a hard stop at
200 MB; an exception raised for any movement unsynced beyond 24 hours; pending-evidence
count on the supervisor board.

## 2. Edge cases, and the decided behaviour

Decided now, so they are not decided ad hoc during implementation.

### Manifest and assignment

| Case | Behaviour |
|---|---|
| Container appears twice in the manifest | Rejected at preview. `unique (manifest_version_id, container_no)` |
| Chassis appears twice in the same manifest | Rejected at preview. `unique (manifest_version_id, chassis_no)` — a vehicle cannot go to two containers |
| Chassis appears in yesterday's and today's manifest | Allowed. Uniqueness is per manifest version, not global. A vehicle can legitimately be re-manifested if a previous move was cancelled |
| Container with one vehicle | Allowed. `capacity = 1` |
| Container with three or more | Allowed, flagged as unusual in the preview. Not blocked — the brief says "normally two" |
| Container with zero vehicles | Rejected. It is not an assignment |
| Blank chassis on a row | Rejected. Unlike the earlier pickup-report design, an unassigned vehicle has no meaning here — the manifest *is* the assignment |
| Manifest for a past date | Allowed with a warning. Back-dated corrections are legitimate |
| Manifest for a future date | Allowed. Not active until its date |
| Two manifests for one yard and date | Impossible. `unique (org_id, yard_id, manifest_date)`; a second upload becomes version 2 |
| Manifest with 5,000 rows | Parse in the Edge Function with a row cap (10,000) and a size cap (10 MB). Preview paginates |

### Scanning and verification

| Case | Behaviour |
|---|---|
| Scanned container is valid and on the manifest but is another vehicle's | `wrong_container`. Blocked, names the correct container |
| Scanned chassis matches another assignment | `wrong_vehicle`. Blocked, names that vehicle's container. **The core case** |
| Chassis matches two assignments equally well | Never auto-accept. Force manual entry (§09 margin rule) |
| Container check digit fails | Never accepted. Re-scan or manual entry, and manual entry validates the check digit too |
| Driver scans the same plate twice (once as container, once as chassis) | Format check catches it — a container number cannot be a chassis number |
| Driver photographs a plate on a different container | phash + GPS + inter-scan timing flags. Not blocked; flagged |
| Movement submitted twice | Idempotent on the client-generated movement id |
| Movement submitted with the same id but different values | Not a retry. Exception raised, not overwritten |
| Vehicle already verified into a container | `vehicle_already_loaded`. Blocked, shows when and by whom |
| Container already at capacity | `container_full`. Blocked |
| Driver's cached manifest is superseded | `manifest_superseded`. Blocked, forced sync |
| Driver has no yard assignment | No tasks. Explicit empty state naming the reason, not a blank screen |
| Assignment cancelled while the driver is mid-scan | Verification returns `assignment_cancelled`; the driver is told before loading |

### Device, permissions, environment

| Case | Behaviour |
|---|---|
| Camera permission denied | Explain why it is required and how to re-grant, per browser. Movement cannot proceed — the photograph is the evidence |
| Location permission denied | Allowed. GPS is corroborating, not required. Recorded as `gps_denied` |
| GPS times out or is wildly inaccurate | Store accuracy; flag anything above 100 m. Never block |
| Device clock is wrong | Both timestamps stored; skew materialized; flag beyond 5 minutes |
| Unapproved device | Driver can view tasks, cannot complete. Supervisor approves from their own session |
| Browser without `getUserMedia` | `/unsupported` with specific guidance. Do not degrade to a file input — that would defeat live capture |
| iOS below 16.4 | Works, but no web push. Supervisors get email. Stated in rollout notes |
| Phone rotates mid-scan | Camera stream re-initializes; captures already taken are preserved in IndexedDB |
| Phone call interrupts the flow | Scan state is persisted per capture; the flow resumes (§05 §4) |
| Storage full | Warn at 100 MB, block new captures at 200 MB with instructions. Never silently fail to store evidence |

### People and process

| Case | Behaviour |
|---|---|
| Driver leaves mid-shift with unsynced movements | Supervisor sees pending-sync count; a 24-hour-old item raises an exception |
| Supervisor unreachable for an override | Escalation ladder to admin at 30 minutes (§12 §6) |
| Supervisor overrides everything | Rate monitoring per supervisor, on the dashboard, with a driver–supervisor pair analysis |
| Admin publishes the wrong manifest | Cancel the version. Movements verified against it are flagged, not deleted |
| Employee dismissed | Deactivate + `auth.admin.signOut`. Both, automatically, in one admin action |
| Vehicle physically moved before the app existed | Supervisor closes the assignment with `vehicle_rescheduled` or an explicit reconciliation exception. Never by editing the manifest to match reality |
| Container swapped physically after assignment | New manifest version. This is a correction, with a reason, not a silent edit |

## 3. Known limitations — stated, not hidden

Honest constraints that no amount of engineering removes. Say them at go-live rather than
discovering them in an incident review.

1. **The system verifies a photograph, not a physical act.** It proves a driver photographed
   the right container and the right chassis. It cannot prove the vehicle then entered that
   container. Verification immediately before loading, plus GPS and timing, narrows the gap;
   it does not close it. Closing it needs hardware — a gate camera, RFID, or a seal scan.
2. **Browser GPS is spoofable.** On a rooted device or with devtools it can be faked. It is
   corroborating evidence, never a sole basis for a conclusion.
3. **Offline verdicts can be wrong** against an amended manifest. Unavoidable without
   connectivity; made loud rather than hidden (§10 §6).
4. **A determined, colluding pair can defeat this.** A driver and a supervisor working
   together can override anything. The controls make it slow, logged, and statistically
   visible — which is the realistic goal for any system where humans hold the final authority.
5. **OCR will never be perfect on damaged plates.** The manual-entry path is a permanent part
   of the design, not a temporary crutch.
6. **PWA camera access is worse than native.** No frame-processor API, no torch control on
   some devices, no direct access to autofocus modes. If a measured share of scans fail for
   reasons that are specifically browser limitations, a native wrapper becomes the answer —
   and the entire architecture behind the client survives that change unchanged, which is one
   more reason the verification authority sits on the server.
