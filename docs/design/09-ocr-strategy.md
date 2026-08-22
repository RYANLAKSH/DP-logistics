# 09 — OCR Strategy

## 1. The reframe that makes this tractable

Browser-based OCR is not good enough to read a filthy stamped chassis plate cold. It does
not have to be.

The manifest already says what we expect: this container, that chassis. So the question is
never *"what does this plate say?"* — it is **"does this photograph show the string we
expect?"** That is a verification problem over a candidate set of one or two, not a
recognition problem over an open vocabulary, and it is enormously easier.

**But it introduces a specific failure mode, and the mitigation is the most important rule
in this document:** an OCR pipeline that is looking for `MAT448291PJ1234` will find it in
noise. Confirmation bias, implemented in software, produces exactly the false PASS the
product exists to prevent.

So the acceptance rule is comparative, never absolute:

> A scan is accepted only if the expected value is the best match **and** either the match
> is **exact**, or it beats the runner-up from the full manifest candidate set by a clear
> margin. A near match that scores close to another manifest value is rejected and the
> driver confirms manually.

**The exact-match carve-out is not a loophole — it is the rule working.** Manifest
containers are numbered sequentially, so `CULVNSA2601795` and `CULVNSA2601796` differ by one
character in fourteen and always score within a few percent of each other. Applying the
margin to an exact read would refuse almost every correct scan in a real yard. This was
found by running the real engine against a rendered plate, not by reasoning about it; the
margin governs *ambiguity*, and an exact read is not ambiguous.

Concretely, the chassis read is scored against **every** chassis in the active manifest, not
just the expected one. If the expected value scores 0.86 and some other vehicle's chassis
scores 0.84, that is not a match — that is an ambiguous read on two similar numbers, which
is precisely the situation where the wrong vehicle gets loaded. Reject and ask.

## 2. Two tiers

| Tier | Where | Engine | Role | Latency |
|---|---|---|---|---|
| **1 — on-device** | Web Worker in the PWA | `tesseract.js` (WASM) | Instant feedback, offline, drives the UI | 300–1500 ms/frame |
| **2 — server recheck** | `ocr-recheck` Edge Function | Google Vision / Textract | Second opinion on low-confidence scans, and a quality baseline | Async, seconds to minutes |

Tier 1 is the product. Tier 2 is not in the critical path and never blocks a driver — it
runs after the fact on scans where tier 1 was uncertain or where the driver typed the value
manually, and it writes its reading alongside. Disagreement between tier 2 and the accepted
value raises a review flag.

Tier 2 is phase 4, not v1 (§15). V1 ships tier 1 plus manual entry, both human-confirmed.
The reason to design tier 2 now is that `scans.ocr_engine` and `ocr_text_raw` must exist
from the first migration, or you cannot add it later without losing the comparison.

## 3. Container numbers — the easy case

ISO 6346 makes this close to solved, and the credit belongs to the check digit rather than
to any OCR engine.

```
frame → grayscale → crop to alignment-guide ROI → adaptive threshold → deskew
      → tesseract (PSM 7 single line, whitelist A-Z0-9)
      → strip separators, uppercase
      → positional confusable repair:  chars 1-4 must be letters, 5-11 must be digits
           "M5KU4512345" → position 2 must be a letter → 5→S → "MSKU4512340"
      → ^[A-Z]{4}[0-9]{7}$ ?
      → ISO 6346 check digit valid ?      ← rejects ~10 of 11 single-character errors
      → equal to the expected container ?
```

The check digit does more for accuracy than any model upgrade. It is arithmetic, it runs in
microseconds, it is offline, and it catches the overwhelming majority of single-character
misreads before a human ever sees a candidate. Run it in the live camera loop, before
displaying anything.

Implementation is already written and tested in `packages/shared-rules/src/checkDigit.ts`,
specified in [`docs/reconciliation-rules.md` §1](../../reconciliation-rules.md). Do not
rewrite it.

Practical camera-loop rules:
- **Stability gate.** Require the same check-digit-valid candidate on 2 consecutive frames
  before auto-filling. Single-frame auto-fill flickers and misfires.
- **Throttle to ~3 fps.** Every frame is a battery and heat cost, and heat throttles the
  camera, which degrades OCR — a feedback loop that makes the app worse the longer it is
  used.
- **Crop to the guide box before OCR.** Feeding the full frame is several times slower and
  measurably less accurate, because the engine finds text elsewhere on the container.

## 4. Chassis numbers — the hard case

Stamped or etched metal, low contrast, often oily, sometimes behind a windscreen at an
angle, and with no check digit to lean on unless the number happens to be a 17-character
ISO 3779 VIN.

**This is the top technical risk in the project.** Plan for it rather than discovering it.

### 4a. What the real labels turned out to be

This section was written before anyone had seen a vehicle. Photographs from the yard
changed two of its assumptions, and the second one changed the code.

**Better than assumed:** the number is not read off stamped metal at all. Tata Motors
applies a printed despatch label — clean black-on-white, machine-set type, flat and
square to the camera. That is a far easier read than a stamped chassis plate, and it
lowers the risk this section opens with.

**Worse than assumed:** the label is not one number. Each carries six or more codes —
`TYPE`, `ASN`, a part number, an engine number, `EVR`, and the chassis number itself —
and the chassis number is neither the largest nor reliably the most confidently read.
Worst of all, `TYPE` is a *substring* of the chassis number:

```
chassis   MAT464844TSR10851
TYPE            464844
```

A pipeline that takes the engine's top-confidence line picks the wrong code routinely,
and a partial read of `TYPE` looks like a partial read of the right field. So the
pipeline scores **every** candidate the frame produced against the manifest and takes
the best match, rather than trusting the loudest line. The clutter becomes irrelevant
instead of dangerous. Nothing is relaxed to achieve it: each candidate still has to
clear the confidence floor, the check digit and the margin rule on its own.

The labels also carry a Code 128 barcode of the chassis number. Reading it is
deliberately **not** implemented — the operator's instruction is to read the chassis
number off the label, and a barcode path is a second source of truth to keep correct,
audit and explain for no gain the label itself does not already give. The `value_source`
enum has room for it if that ever changes.

```
frame → ROI crop → grayscale → CLAHE (local contrast; stamped metal has almost none)
      → threshold → deskew
      → tesseract (PSM 7, whitelist A-Z0-9)
      → normalize: strip separators, uppercase,
                   VIN confusables are unambiguous — I→1, O→0, Q→0
                   (none of I, O, Q are legal in a VIN)
      → score against ALL chassis in the active manifest:
            exact after normalization            → 1.00
            last 6+ characters match             → 0.90   (plates often show only the serial)
            Levenshtein ≤ 2 on a 17-char VIN     → 0.70
            otherwise                            → similarity ratio
      → best = expected AND (best - runner_up) ≥ 0.15 AND best ≥ 0.90 ?
            yes → propose, driver confirms
            no  → manual entry, driver types it, still photographed
```

Three things that materially improve the outcome:

1. **Capture the registration plate as a secondary identifier.** It is high-contrast,
   standardized, designed to be read at distance, and OCRs far more reliably than a stamped
   chassis plate. When the chassis score is between 0.70 and 0.90, agreement between the
   registration plate and the manifest's `vehicle_reg_no` for the same assignment promotes
   the match to acceptable. Disagreement forces manual entry. This single addition is worth
   more than a better OCR engine.
2. **Make manual entry a first-class path, not a walk of shame.** It is one tap from the
   camera screen, the keyboard is numeric-first, and the value validates as it is typed
   against the expected string with a character-level diff. A driver typing 17 characters
   with live validation is *more* reliable than a bad OCR read that a driver rubber-stamps.
   The photograph is still mandatory — the evidence requirement is independent of how the
   text was obtained.
3. **Never auto-accept below exact.** Anything fuzzy requires an explicit tap on a screen
   that shows exactly what is being accepted, with the differing characters highlighted.

## 5. Confidence and thresholds

| Signal | Auto-accept | Propose for confirmation | Reject → manual |
|---|---|---|---|
| Container | check digit valid **and** exact match | check digit valid, one substitution from expected | anything else |
| Chassis | exact match, OCR confidence ≥ 0.85 | score ≥ 0.90 and margin ≥ 0.15 | anything else |
| Reg plate | exact match | ≥ 0.85 | anything else |

Thresholds live in `org_settings`, not in the bundle. They **will** need tuning against a
real yard, in real light, on real phones, and a redeploy to change a number is a bad
feedback loop. Log every scan's raw text, confidence, and final value from day one, so the
tuning is driven by data rather than by whoever complained most recently.

## 6. What the driver actually sees

```
┌──────────────────────────────────┐    Live camera, alignment guide
│ ╔══════════════════════════════╗ │    sized for a container ID panel.
│ ║   [ camera preview ]         ║ │
│ ║  ┌────────────────────────┐  ║ │    Candidate appears under the guide
│ ║  │  MSKU 451234 5      ✓  │  ║ │    as soon as it stabilizes; a green
│ ║  └────────────────────────┘  ║ │    tick means the check digit passed.
│ ╚══════════════════════════════╝ │
│  Expected: MSKU 451234 5         │    The expected value stays visible.
│                                  │    Hiding it to "avoid bias" just makes
│  [ Type it instead ]             │    the driver squint at a paper sheet.
└──────────────────────────────────┘
```

The expected value is shown throughout. The alternative — hiding it so the driver reads the
plate "blind" — sounds more rigorous but is worse in practice: the driver ends up
cross-checking against a printout, which is the failure mode the product replaces. The
verification integrity comes from the photograph and the server-side comparison, not from
keeping the driver ignorant.

## 7. Performance budget

On a mid-range Android phone, which is what drivers actually carry:

| Item | Budget | Note |
|---|---|---|
| `tesseract.js` core + eng traineddata | ~4 MB | Precached at install for the driver role only; never on the critical first paint |
| Worker init | < 2 s, once per session | Warm it when the task screen opens, not when the shutter is pressed |
| Per-frame OCR on a cropped ROI | 300–800 ms | Full frame is 3–5× slower for a worse result |
| Frame rate | 3 fps | Higher gains nothing and costs heat |
| Shutter → verdict | < 3 s | The §01 non-functional requirement |
| Battery | full shift | Suspend the OCR loop the moment the app is backgrounded or a candidate is accepted |

Consider a language data subset. The full English model carries far more than the 36
characters this application ever needs, and a trimmed traineddata restricted to `A-Z0-9`
loads faster and is slightly more accurate for being unable to propose punctuation.

## 8. Measuring it

Track weekly, per yard and per driver, because these numbers decide whether tier 2 gets
built:

- Auto-accept rate, container vs chassis, separately. They will differ by a lot.
- Manual-entry rate. Above 25% for chassis, the phase-4 server OCR moves up the plan.
- Retake rate — how often a driver rejects the OCR proposal. This is the honest accuracy
  signal, better than any confidence score the engine reports about itself.
- Disagreement rate between tier 1 and tier 2, once tier 2 exists.
- Time from camera open to accepted value. This is the adoption metric.

Build the logging in phase 3 with the first scan flow. Retrofitting it means the first month
of real-world OCR data — the most valuable tuning data the project will ever have — is gone.
