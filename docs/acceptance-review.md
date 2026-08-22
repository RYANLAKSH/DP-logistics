# Business Acceptance Review

Written from the owner's chair, against the problem as it was stated:

> Vehicles are moved from a yard into shipping containers. A daily manifest
> assigns chassis numbers to containers, normally two per container. Prevent
> the wrong vehicle being picked up, prevent the correct vehicle going to the
> wrong container, and have evidence when something goes wrong.

## 1. Does it prevent the two failures?

### Wrong vehicle picked up

**Yes, and the control is upstream of the scan.** The driver is handed one task
at a time and reads the exact chassis number, make, colour and registration
before any camera opens. They do not choose from a list — there is nothing to
pick the wrong item from. The physical chassis plate must then be photographed
and must match.

Where it can still fail: a driver who reads the screen, walks to the wrong
vehicle, and photographs its plate is blocked — correctly — but has wasted a
trip. That is the system working.

### Right vehicle, wrong container

**Yes.** The container plate must be photographed and must match the
assignment. Where the identifier is ISO 6346 the check digit rejects most
misreads before a human sees them. Where it is a customer reference like
`CULVNSA2601795` — fourteen characters, no check digit — comparison is exact
after safe normalisation.

The block names the container the scanned vehicle actually belongs to, which
turns a refusal into a correction: the driver learns where to take it.

**The decision is made by the server, not the phone.** The database grants no
client any write to the movement table — not a restrictive policy, none at all.
A driver who modifies the app, replays a request or edits local storage gets
the same answer.

## 2. Every capability asked for

| Required | State |
|---|---|
| Manifest as source of truth | ✅ Versioned, immutable, one live version per yard per day |
| Sequential driver workflow | ✅ One task at a time, slot order enforced server-side |
| Container scanning | ✅ Camera, OCR, ISO 6346 where applicable |
| Chassis scanning | ✅ Camera, OCR, VIN confusable repair, manual entry |
| OCR | ✅ On-device, offline, behind a provider interface |
| Match verification | ✅ Server-side, atomic, eight outcomes in a specified order |
| Hard blocking | ✅ No dismiss control exists in the driver role |
| Photo evidence | ✅ Both plates, hashed at capture, private bucket |
| GPS evidence | ✅ Event-based, consented, never blocking |
| Real-time dashboard | ✅ Live counters, container fill, activity feed, filters |
| Daily manifest upload | ✅ CSV/XLSX, preview, publish; nothing skippable |
| Exception management | ✅ Sixteen types, lifecycle, resolution codes with consequences |
| Audit trail | ✅ Append-only, hash-chained, every view logged |
| Role-based security | ✅ Three roles, enforced in Postgres |
| RLS | ✅ Every table, default deny, 28 attacks tested and refused |
| Secure image storage | ✅ Private buckets, 5-minute signed URLs, no client write path |
| Offline strategy | ✅ Capture and queue; never a false completion |
| PWA installation | ✅ Installable, service worker, offline shell |
| Historical manifests | ✅ Archived, never overwritten |
| Manifest correction controls | ✅ New version, before/after/reason, blast radius shown |
| Reports | ✅ Board, audit log, corrections, and shift close |

## 3. Gaps I looked for, and what I found

### Human workarounds

The realistic threat is not a hacker; it is a driver at 4pm with six vehicles
left. Countermeasures are behavioural as much as technical: manual entry is
allowed but permanently marked and counted; a photograph is required however
the value was obtained; the compliant path is under a minute.

**Residual, and stated:** the system verifies that the right plates were
photographed, not that the vehicle then entered the container. Closing that
needs hardware — a gate camera, RFID, or a seal scan. Everything else here is
narrowing the window, not eliminating it.

### Driver bypass

Twenty-eight specific attempts are tested and refused (`97_attack.sql`),
including forging a passing scan, editing what a movement says was scanned,
changing an image hash to match a substituted photograph, and approving one's
own override. The offline queue was a real hole — a photograph could be swapped
in IndexedDB before upload — and is now closed by hashing at capture.

### Poor connectivity

Full capture offline, with a queued movement labelled PENDING SYNC and never
VERIFIED. Documented plainly in `docs/design/phase-13-offline.md`.

### OCR false positives

The margin rule: an ambiguous read that scores close to another manifest value
is refused rather than confirmed. Testing against real data corrected this
once — sequential container numbers differ by one character, so the rule had to
exempt exact matches or it would have refused nearly every correct scan.

### Duplicate assignments, two drivers on one vehicle

A chassis cannot be assigned twice in one manifest (schema). Two drivers racing
for the last slot is proven, with two live connections, to produce exactly one
movement.

### Manager mistakes

Preview cannot be skipped. A manifest with rejected rows cannot be published.
Corrections carry a mandatory reason and show which completed movements they
invalidate. The last active admin cannot be demoted.

### Manifest changes during operations

A correction publishes a new version and archives the old. A completed movement
is never retroactively invalidated — the vehicle is physically inside the
container — but a critical exception is raised and the conflict is permanent
and visible.

### Vehicle already moved but the system says pending

Covered by shift close, below.

### Container physically changed after assignment

A correction with a reason, not a silent edit. The old version stays readable.

### End-of-day reconciliation — **THE GAP I FOUND**

This was the one real hole, and it was invisible because nothing was wrong with
any individual movement.

**A container sealed with one vehicle instead of two passes every check in the
system.** Both scans matched. The movement is correct. No exception is raised.
Nothing in the verification flow can see it, because verification is per
movement and this failure only exists in the aggregate.

That is a customs and financial problem — a container ships short, and nobody
knows until it is opened at the far end.

**Implemented** (`shift_report`, and the *Shift close* screen): every container
that received fewer vehicles than assigned, **naming the chassis numbers that
are missing** rather than reporting a count. A number tells a manager something
is wrong; a chassis number tells them where to go. Alongside it: containers not
started, exceptions still open, the override count and rate, values typed by
hand, and movements whose device clock was well off the server's — the
signature of records created in a batch after the fact rather than at the ramp.

## 4. Where I would not sign off yet

Not code, and honest about it:

1. **Nobody has used this in a yard.** Every layer is tested, and no driver has
   held it in the rain. Pilot one yard for two weeks before the second.
2. **Measure the paper baseline first.** Time the current process before
   deploying, or "faster than before" is unprovable — and adoption is decided by
   that, not by features.
3. **Chassis OCR accuracy is unknown on real plates.** Synthetic text reads at
   90%. Corroded stamped metal will not. Manual entry is first-class for exactly
   this reason, and the manual-entry rate is the number to watch.
4. **The production checklist in `docs/deployment.md` is not done** — rate
   limits, enforced MFA, disabled sign-up, the external audit anchor.
5. **Agree a paper fallback before go-live.** A verification system with no
   agreed fallback becomes a reason to stop loading vehicles, and that is how a
   control gets switched off permanently.

## 5. Operational SOP

### Manager, start of day
1. Upload the manifest. Review the preview — rejected rows are rejected, never
   guessed at.
2. Fix the source file and re-upload if anything is rejected.
3. Publish. Drivers see it on their next sync.
4. Approve any device waiting.

### Driver, per vehicle
1. Read the task: container, position, chassis, model, colour.
2. Walk to the container. Photograph the plate. Confirm or type the number.
3. Walk to the vehicle. Photograph the chassis plate. Confirm or type.
4. **Verify vehicle.** If blocked, stop — do not load. Rescan, or ask a manager.
5. Load the vehicle.
6. **Confirm vehicle moved.** Only now is it recorded.
7. Before finishing the shift, open **Sync** and confirm nothing is pending.

### Manager, during the shift
- Watch the board. A blocked movement means a driver is standing still.
- Open the exception, look at both photographs, and decide: corrected and
  rescanned, manifest amended, manual entry authorised, or an override.
- An override is authorised from your own device, never by reading a code to a
  driver. It is recorded against your name permanently.

### Manager, end of day
1. Open **Shift close**.
2. **Resolve every partially loaded container before anything is sealed.** This
   is the check the rest of the system cannot make.
3. Clear open exceptions.
4. Check the override rate. Above 5% means bad manifest data or a process
   problem, and both need a person.
5. Check for drivers with unsynced movements.

### Weekly
- Manual-entry rate by driver: rising means plates or training, not laziness.
- Override rate by manager, and any recurring driver–manager pair.
- False-alarm resolutions: a system that cries wolf gets overridden reflexively,
  which is how a control quietly dies.
- Verify the audit chain, and confirm the daily anchor is being written.
