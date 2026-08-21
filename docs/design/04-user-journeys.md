# 04 — Main User Journeys

## 1. Driver — the happy path

The journey the product lives or dies on. Target: under 60 seconds, two scans, four taps.

```
1. Open app (installed PWA, already signed in — refresh token is 30 days)
       ↓
2. TODAY screen:  "Yard: Nhava Sheva · Manifest 21 Aug v1 · 14 of 32 done"
       ↓  [Start next task]
3. TASK screen — before any camera opens, the driver is told what to do:

       ┌────────────────────────────────────┐
       │  TASK 15 of 32                     │
       │                                    │
       │  CONTAINER    MSKU 451234 5        │
       │  Position     Bay C, row 4         │
       │                                    │
       │  VEHICLE      MAT448291PJ1234      │
       │  Make/model   Tata Nexon (white)   │
       │  Slot         1 of 2               │
       │                                    │
       │  [ Scan container ] [ Scan vehicle ]│
       │  [ Can't do this task ]            │
       └────────────────────────────────────┘
       ↓  (either scan first — order is not enforced)
4. SCAN CONTAINER: live camera, alignment guide sized to a container ID panel.
   OCR runs on frames continuously. A candidate that matches ^[A-Z]{4}[0-9]{7}$ AND
   passes the ISO 6346 check digit auto-fills and the shutter fires.
       ↓
5. CONFIRM: the photo, the extracted number, large. [Correct] / [Retake] / [Type it]
       ↓
6. SCAN VEHICLE: same, on the chassis plate. Chassis plates are stamped metal and
   messier — expect the manual-entry path here more often (§09).
       ↓
7. CONFIRM.
       ↓
8. Advisory verdict renders immediately from the cached manifest (offline-safe).
   Simultaneously the movement is submitted to verify_movement().
       ↓
9. RESULT — full screen, unmistakable:

       ┌────────────────────────────────────┐
       │              ✓                     │
       │           VERIFIED                 │
       │  Load MAT448291PJ1234              │
       │  into MSKU4512340                  │
       │                                    │
       │  Container slot 1 of 2 filled      │
       │  Next: chassis MAT448300PJ5678     │
       │  [ Start next task ]               │
       └────────────────────────────────────┘
```

Design notes that are requirements, not decoration:

- **Step 3 comes before any camera.** The driver reads the assignment first. This is what
  prevents risk 1 (wrong vehicle picked up) before a single photo is taken.
- **The verdict never depends on colour alone.** Green plus a tick plus the word VERIFIED;
  red plus a cross plus DO NOT LOAD. Sunlight and colour blindness both apply here.
- **Step 9 tells the driver what is next.** Because containers take two vehicles, the
  second task for the same container should be offered immediately — the driver is already
  standing there.

## 2. Driver — the mismatch path

This is the journey that justifies the project.

```
4–7 as above, but the scanned chassis is MAT447102PJ9981
       ↓
8. Advisory verdict: FAIL. The submission still goes to the server, because a blocked
   attempt is evidence and must be recorded.
       ↓
9. RESULT:

       ┌────────────────────────────────────┐
       │              ✕                     │
       │         DO NOT LOAD                │
       │                                    │
       │  Container  MSKU4512340            │
       │  expects    MAT448291PJ1234        │
       │  You scanned MAT447102PJ9981       │
       │                                    │
       │  That vehicle is assigned to       │
       │  container TGHU7781237 (Bay A).    │
       │                                    │
       │  Supervisor notified.              │
       │  [ Rescan vehicle ]                │
       │  [ Request supervisor override ]   │
       └────────────────────────────────────┘
```

- There is **no dismiss control**. The driver may rescan (they may have photographed the
  wrong plate) or request an override. They cannot proceed.
- The screen names the *other* container. That turns a block into a correction: the driver
  now knows this vehicle's actual destination, and often the right vehicle is nearby.
- The exception is already in the supervisor's queue before the driver finishes reading it
  (§11).

## 3. Driver — blocked for a reason that is not a mismatch

From the task screen or mid-scan, `[Can't do this task]` opens a short list — no free text
first, because a taxonomy is what makes the data useful later:

| Reason | What happens |
|---|---|
| Container plate unreadable / damaged | Exception raised, photo attached, supervisor may authorize a manual container entry |
| Chassis plate unreadable / damaged | Same, for the vehicle. Registration plate captured as a secondary identifier |
| Vehicle not in the yard | Exception raised; task is parked, not failed. Supervisor reassigns |
| Container not at the stated position | Exception raised with GPS |
| Container already full | Exception raised — usually means someone loaded out of sequence |
| Other | Free text, mandatory |

The task returns to the pool in every case except "unreadable plate", which stays with the
driver pending a supervisor decision, so two drivers do not both attempt it.

## 4. Supervisor — a shift

```
Start of shift
  → BOARD: live tiles per yard — tasks done / in progress / blocked, and the exception
    count. Updates without refresh (§11).

An exception arrives
  → It appears at the top of the queue with a sound and, if the tab is backgrounded, a
    web push.
  → Supervisor opens it: both photographs, extracted text, expected values, the driver,
    the GPS point, the timestamps, and the manifest line.
  → Decision:
      · Genuine driver error   → resolve as CORRECTED, driver rescans. No override.
      · Manifest is wrong      → resolve as MANIFEST_ERROR, notify admin to amend.
                                 Movement stays blocked; an amendment is the fix.
      · Real substitution      → APPROVE OVERRIDE with a reason code (§12).
      · Damaged plate          → authorize manual entry for this movement only,
                                 recorded as such.

End of shift
  → Any container with a partially filled complement is flagged: "MSKU4512340 has 1 of 2
    vehicles". This is the report that catches the error nobody noticed.
```

The last point deserves emphasis. A container that received one vehicle instead of two is
not caught by any per-scan check — every individual scan passed. It is caught by a
completeness sweep at the end of the shift, and that sweep is a v1 requirement, not a
nice-to-have.

## 5. Admin — the daily manifest

```
1. Receives the day's manifest file (XLSX/CSV) by email from operations.
2. MANIFESTS → Upload → pick yard, pick date, drop the file.
3. Column mapping. Auto-detected from the headers; the mapping is saved per source so
   tomorrow's file needs no mapping at all. Admin confirms.
4. PREVIEW — the step that must never be skippable:

       28 containers · 54 vehicles · 2 rows rejected

       ✕ Row 31  Container MSKU4512340 — check digit invalid (expected 5)
       ✕ Row 47  Chassis blank
       ⚠ Row 12  Container TGHU7781237 has 3 vehicles (unusual, not blocked)

5. Fix at source and re-upload, or commit with the rejected rows excluded.
6. Commit → manifest v1 becomes active → drivers' devices pick it up on next sync.
```

**Amendment.** A re-upload for the same yard and date creates v2. Before committing, the
admin is shown the blast radius:

```
   Amending 21 Aug · Nhava Sheva  v1 → v2

   6 assignments changed.
   → 2 of them have movements ALREADY VERIFIED against v1:

       MSKU4512340 / MAT448291PJ1234  verified 09:14 by R. Kumar
         v2 assigns this container to MAT449900PJ0001

   Committing will re-verify these movements against v2. Outcomes may change
   from VERIFIED to MISMATCH, which raises an exception for each.
   [ Cancel ]  [ Commit and re-verify ]
```

This is the ugliest workflow in the system and it must not be hidden. A vehicle that is
physically inside a container cannot be un-loaded by a database update; what the system can
do is make the discrepancy loud and route it to a human.

## 6. Auditor — a dispute, six months later

```
A customer claims their vehicle arrived in the wrong container.
  → AUDIT → search by chassis MAT448291PJ1234
  → Timeline for that vehicle:

      21 Aug 09:11  Task issued        manifest v1 line 15
      21 Aug 09:13  Container scanned  MSKU4512340  OCR conf 0.97  [photo]
      21 Aug 09:14  Chassis scanned    MAT448291PJ1234  conf 0.88  [photo]
      21 Aug 09:14  VERIFIED           server, against manifest v1
                      device 4f2a… · driver R. Kumar · 18.9481N 72.9214E
                      client verdict agreed
      21 Aug 09:14  Notification sent  ops@…, do@…  (delivered 09:14)

  → Open either photograph. Verify its SHA-256 against the stored hash.
  → Export the movement, its evidence, and the manifest version as a signed bundle.
```

The auditor's journey is the reason for every "store this too" decision elsewhere in the
design. If this screen cannot settle the dispute in two minutes, the audit design has
failed regardless of how much data was collected.
