# 01 — Product Requirements

## 1. The problem in one paragraph

Vehicles sit in a yard. Each day a manifest arrives that assigns each vehicle, by chassis
number, to a specific shipping container — normally two vehicles per container. Drivers
move vehicles from the yard into containers. Today nothing physically prevents a driver
from taking the wrong vehicle, or from putting the right vehicle into the wrong container,
and when a mistake surfaces days later at a port or a customer there is no record that
establishes what actually happened, when, or who did it.

## 2. The three risks, and what the product does about each

| # | Risk | What actually goes wrong | Control |
|---|---|---|---|
| 1 | Driver picks up the wrong vehicle | Chassis numbers on a yard of similar vehicles differ by a few characters. The driver works from a printed sheet or memory. | The app assigns work one task at a time and names the exact chassis expected. The physical chassis plate must be scanned and must match before the movement can proceed. |
| 2 | Right vehicle, wrong container | Containers in a row look identical; the driver reads the wrong one, or two tasks get transposed. | The physical container number must be scanned and must match the assignment. ISO 6346 check digits reject most misreads locally and instantly. |
| 3 | No evidence when something goes wrong | Disputes are settled by argument. Nobody can prove which vehicle went into which container. | Every movement stores both photographs, the extracted text, the manifest version verified against, the operator, the device, GPS, and both device and server timestamps — in append-only storage. |

Risk 2 is the one the product exists for. A driver who scans container `MSKU4512340` while
holding a vehicle assigned to `TGHU7781237` must be stopped at that moment, not audited
next week.

## 3. Scope

### In scope (v1)

- Daily manifest import (XLSX/CSV), preview, commit, versioned amendment.
- Driver PWA: assigned task queue, camera scan of container plate and chassis plate,
  OCR extraction, server-verified completion, blocked completion on mismatch.
- Supervisor: live board of movements in progress and completed, exception queue,
  override with reason code.
- Admin: users, yards, manifest management, notification recipients.
- Auditor: read-only access to every movement and its evidence.
- Immutable audit trail and evidence retention.
- Installable, offline-capable PWA on Android and iOS.

### Out of scope (v1, deliberately)

- Native app store distribution. The PWA install banner is the delivery mechanism.
- Container sealing, seal-number verification, and gate-out documentation.
- Customs/trade document handling (the earlier `docs/documents.md` work).
- Route planning, driver scheduling, or telematics.
- Multi-language UI. English only in v1; the strings are externalized so it is cheap later.
- Automatic manifest ingestion from a mailbox. Admin uploads the file.

### Explicitly deferred, with a reason

- **PDF manifest parsing.** Real DO output is often PDF. It is a materially harder ingest
  problem than XLSX/CSV and should not gate v1. Phase 5.
- **Server-side cloud OCR as a second opinion.** Designed for in §09, built in phase 4.
  V1 ships on-device OCR plus manual entry, both human-confirmed.

## 4. Functional requirements

Each is written so it can be tested.

### Manifest

- **FR-M1** An admin can upload a manifest file (XLSX or CSV) for a given yard and date.
- **FR-M2** The system parses it into container/vehicle assignments and presents a preview
  showing valid rows, rejected rows, and the reason per rejection. Nothing becomes live
  until the admin commits.
- **FR-M3** A row whose container number fails the ISO 6346 check digit is rejected, not
  auto-corrected.
- **FR-M4** A container may carry one or more vehicles; two is the default and the system
  must not hard-code it. Capacity comes from the manifest.
- **FR-M5** Committing a manifest creates version 1. A re-upload for the same yard and date
  creates version 2, marks version 1 `superseded`, and never mutates version 1's rows.
- **FR-M6** Amending a manifest that has movements already verified against it must show
  the admin exactly which verified movements are affected before the commit.

### Driver

- **FR-D1** A driver sees only tasks for yards they are assigned to, for the active
  manifest, and only tasks that are not already completed by someone else.
- **FR-D2** A task shows the expected container number and the expected chassis number
  before any scanning begins. The driver is never asked to recall either.
- **FR-D3** The driver must capture a photograph of the physical container number plate and
  of the physical chassis plate. Uploading an existing file instead of using the camera is
  not offered in the driver flow.
- **FR-D4** The app extracts text from each photograph and presents it for confirmation.
  The driver may correct it by typing.
- **FR-D5** The driver cannot complete a movement whose container or chassis does not match
  the assignment. There is no "proceed anyway" control in the driver role.
- **FR-D6** On a mismatch the app states plainly what was expected, what was scanned, and —
  when the scanned value belongs to a different assignment — what that vehicle or container
  is actually for.
- **FR-D7** Scan order is not fixed. Container-first and chassis-first must both work.
- **FR-D8** A driver can raise an exception from any point in the flow (unreadable plate,
  vehicle not present, damaged plate) without completing the movement.

### Verification

- **FR-V1** Verification is performed server-side against the manifest version the movement
  is bound to. The client's verdict is advisory and is stored as such.
- **FR-V2** A movement transitions to `verified` only through the server verification
  function. No client has a grant permitting it to write that state.
- **FR-V3** A container that has already received its full assigned complement of vehicles
  cannot receive another; the attempt raises an exception.
- **FR-V4** A vehicle already loaded cannot be loaded again; the attempt raises an
  exception.
- **FR-V5** If the manifest version changed between task issue and completion, the movement
  is re-verified against the current version and any change in outcome is itself an event.

### Supervisor and exceptions

- **FR-S1** Every blocked attempt creates an exception record. Exceptions are not dismissible
  by the driver.
- **FR-S2** A supervisor sees a live queue of open exceptions for their yards, updating
  without a page refresh.
- **FR-S3** A supervisor can override a blocked movement with a mandatory reason code. The
  override is a new record; the original block is never modified.
- **FR-S4** An override is authorized from the supervisor's own authenticated session, not
  by entering a code on the driver's device.

### Audit

- **FR-A1** Every movement retains both images, their SHA-256 hashes, extracted text, OCR
  confidence, manifest version, operator, device, GPS, device time, and server time.
- **FR-A2** Movement and audit records are append-only. Corrections are new rows that
  reference the record they supersede.
- **FR-A3** An auditor can retrieve the complete history of any movement, container, or
  vehicle, and export it.

## 5. Non-functional requirements

| Area | Requirement | Why this number |
|---|---|---|
| Scan-to-verdict | Under 3 seconds from shutter to on-screen verdict, online or offline | Longer than that and drivers stop using it |
| Complete task time | Under 60 seconds for the happy path, two scans included | Must be faster than the paper process it replaces |
| Offline | Full task list, scanning, and advisory verdict with zero connectivity | Yards have dead spots between container stacks |
| Realtime board latency | Under 5 seconds from server verification to supervisor's screen | Supervisors act on mismatches while the truck is still there |
| Device support | Android Chrome 108+, iOS Safari 16.4+ | 16.4 is where iOS gained web push and usable PWA behaviour |
| Availability | 99.5% during yard operating hours | Managed Supabase; the offline tier absorbs short outages |
| Evidence durability | Images retained 24 months, records indefinitely | Records are small; images are not |
| Battery | A full shift of scanning on one charge | Camera plus WASM OCR is the expensive part; §09 budgets for it |
| Accessibility | WCAG 2.1 AA on all non-camera screens; verdict never conveyed by colour alone | Sunlight, gloves, and colour-blind users |

## 6. Success metrics

The product is working if, after one month of use at a pilot yard:

- **Zero** vehicles loaded into a container other than the one the manifest assigns.
- Blocked-at-scan mismatches are non-zero. If nothing is ever blocked, either the yard has
  no error rate — unlikely — or drivers are working around the app.
- Override rate below 5% of movements, and trending down. A high or rising override rate
  means either the manifest data is bad or the app is being circumvented; both need
  visibility, and §12 puts it on the dashboard.
- Manual-entry rate below 25% of scans. Above that, OCR is not carrying its weight and
  §09's phase-4 server OCR moves up the plan.
- Median task time below the paper baseline measured before rollout. Measure the baseline
  before you deploy anything, or you will never be able to prove this.

## 7. Assumptions

Stated so they can be challenged early rather than discovered late.

1. Container numbers are ISO 6346 compliant and physically legible on the container. If a
   meaningful share of containers have painted-over or damaged plates, §12's damaged-plate
   exception path becomes a primary flow rather than an edge case.
2. Chassis plates are physically accessible to a person with a phone, on a vehicle in the
   yard. If some vehicles require the driver to be inside or underneath, the flow needs a
   secondary identifier — the registration plate, per §09.
3. Drivers have smartphones with a working camera, or the company issues them. The PWA
   assumes one device per driver and binds to it.
4. One manifest per yard per day is the norm; amendments happen but are not hourly.
5. Two vehicles per container is typical, not universal. Capacity is data, not a constant.
6. There is at least intermittent connectivity somewhere in the yard — enough to sync a
   manifest at shift start and drain a queue during the shift. A yard with genuinely zero
   connectivity all day is viable but pushes every movement into the provisional state
   described in §10, and the supervisor board stops being live.
