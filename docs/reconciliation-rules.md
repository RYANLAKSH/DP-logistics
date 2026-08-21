# Reconciliation Rules

This is the specification for `packages/shared-rules`. It runs identically on the phone
(offline, advisory) and on the server (authoritative). One implementation, imported twice.

## 1. Container number format — ISO 6346

```
M S K U   4 5 1 2 3 4   0
└──┬──┘   └────┬────┘   │
owner    serial (6)     check digit
+ category                (computed from the 10 preceding chars)
(4 letters, 4th is U/J/Z)
```

Regex: `^[A-Z]{4}[0-9]{7}$`, with the 4th letter normally `U` for freight containers.

### Check digit

Each of the first 10 characters gets a value, multiplied by `2^position`, summed, mod 11,
with 10 mapping to 0.

Letter values skip every multiple of 11:

```
A=10 B=12 C=13 D=14 E=15 F=16 G=17 H=18 I=19 J=20 K=21 L=23
M=24 N=25 O=26 P=27 Q=28 R=29 S=30 T=31 U=32 V=34 W=35 X=36 Y=37 Z=38
```

```ts
const LETTER_VALUES: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  let v = 10;
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') {
    while (v % 11 === 0) v++;      // skip 11, 22, 33
    map[ch] = v++;
  }
  return map;
})();

export function containerCheckDigit(first10: string): number | null {
  if (!/^[A-Z]{4}[0-9]{6}$/.test(first10)) return null;
  let sum = 0;
  for (let i = 0; i < 10; i++) {
    const ch = first10[i];
    const value = i < 4 ? LETTER_VALUES[ch] : Number(ch);
    sum += value * (1 << i);       // 2^i
  }
  return (sum % 11) % 10;          // 10 → 0
}

export function isValidContainerNo(input: string): boolean {
  const s = normalizeContainerNo(input);
  if (!/^[A-Z]{4}[0-9]{7}$/.test(s)) return false;
  return containerCheckDigit(s.slice(0, 10)) === Number(s[10]);
}
```

`MSKU4512340` validates; flip any digit and it almost certainly won't. Roughly 10 in 11
single-character OCR errors are caught here — locally, instantly, for free. Use it in the
camera loop to filter candidates before you ever show one to the officer.

## 2. Normalization

Applied to every value — OCR output, manual entry, and report ingest alike — before any
comparison. Comparing un-normalized strings is the classic source of phantom mismatches.

```ts
export function normalizeContainerNo(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[\s\-_.]/g, '')      // "MSKU 451234-0" → "MSKU4512340"
    .trim();
}
```

**Confusable characters.** OCR on stamped or painted metal confuses these constantly:

| Read as | Often actually | Where |
|---|---|---|
| `O` `Q` `D` | `0` | numeric section |
| `I` `l` `|` | `1` | numeric section |
| `S` | `5` | numeric section |
| `B` | `8` | numeric section |
| `Z` | `2` | numeric section |
| `G` | `6` | numeric section |
| `0` | `O`/`D` | alpha section |

Because the container format is positionally strict, resolve by position: characters 1–4
must be letters, 5–11 must be digits. Apply the mapping in the direction the position
demands, then check-digit validate. If a single substitution produces a check-digit-valid
number, propose it — flagged as corrected, still requiring officer confirmation.

VIN normalization differs: `I`, `O`, and `Q` are **never valid in a VIN**, so any
occurrence is unambiguously `1`, `0`, `0` respectively.

## 3. Container matching

Exact, after normalization. No fuzzy matching on container numbers, ever — the check digit
means a valid-but-wrong number is a genuinely different container, not a misread.

```
scanned container → normalize → check digit valid?
   no  → prompt re-scan / manual entry (do not proceed)
   yes → look up active report lines for this location + date window
           found     → proceed to chassis
           not found → CONTAINER_NOT_IN_REPORT
```

## 4. Chassis matching

Messier. Chassis/VIN plates are stamped, dirty, and inconsistently formatted, and Indian
chassis numbers don't reliably carry a check digit.

```
scanned chassis → normalize (strip spaces/hyphens, upper, VIN confusables)
   1. Exact match against line.chassis_no        → MATCH (confidence 1.0)
   2. Suffix match, last 6+ characters           → MATCH (confidence 0.9)
        (plates are commonly stamped with only the serial portion visible)
   3. Levenshtein distance ≤ 2 on a 17-char VIN  → LIKELY (confidence 0.7)
        → officer must confirm explicitly; recorded as fuzzy
   4. Otherwise                                  → compare against ALL lines
        matches a DIFFERENT line → MISMATCH (this is the case the product exists for)
        matches nothing          → CHASSIS_NOT_IN_REPORT
```

Two things make this materially more reliable:

- **Capture the vehicle registration plate too.** It's high-contrast, standardized, and
  OCRs far better than a stamped chassis plate. When chassis confidence is below 0.9,
  agreement between reg plate and chassis on the same line promotes the match; disagreement
  forces manual verification.
- **Threshold, then confirm.** Anything below exact requires an explicit officer tap that
  says what's being accepted. Never silently accept a fuzzy match.

## 5. Outcome resolution

```ts
export function reconcile(input: {
  containerNo: string;
  chassisNo: string;
  vehicleRegNo?: string;
  lines: PickupReportLine[];
  now: Date;
  reportValidTo: Date;
  alreadyReconciled: Set<string>;   // container numbers with an active MATCH
}): ReconResult
```

Evaluated in order — first hit wins:

| # | Condition | Outcome | `reason_code` | UI |
|---|---|---|---|---|
| 1 | Report window expired | `EXPIRED_REPORT` | `REPORT_EXPIRED` | Block, contact ops |
| 2 | Container has an active MATCH already | `DUPLICATE` | `CONTAINER_ALREADY_RELEASED` | Block, supervisor |
| 3 | Container not on any active line | `CONTAINER_NOT_IN_REPORT` | `CONTAINER_UNKNOWN` | Block |
| 4 | Container found, chassis matches that line | `MATCH` | `EXACT` / `SUFFIX` / `FUZZY` | **PASS** |
| 5 | Container found, chassis matches a *different* line | `MISMATCH` | `WRONG_VEHICLE` | **FAIL**, show both |
| 6 | Container found, chassis matches nothing | `CHASSIS_NOT_IN_REPORT` | `VEHICLE_UNKNOWN` | Block |
| 7 | Container found, line has no expected chassis | `MATCH` | `NO_CHASSIS_ON_REPORT` | PASS, flag to ops |

Row 5 is the whole point of the system. The FAIL screen should be explicit and
unambiguous:

> **DO NOT LOAD**
> Container `MSKU4512340` is assigned to chassis `MAT448291PJ1234`
> You scanned `MAT447102PJ9981` — assigned to container `TGHU7781237`
> Supervisor has been notified.

Row 7 deserves a note: reports sometimes arrive with the vehicle column blank because
allocation happens at the gate. Passing is the pragmatic call — blocking every such line
makes the app unusable — but flag it, count it, and report the rate back to the DO. If it
climbs, the report quality is the problem, not the app.

## 6. Overrides

Real operations need an escape hatch, or officers route around the system entirely.

- Only `supervisor` and `admin` may override.
- A reason code is mandatory: `REPORT_ERROR`, `LAST_MINUTE_SUBSTITUTION`,
  `DAMAGED_PLATE`, `OPERATIONAL_EXCEPTION`, `OTHER` (free text required).
- An override writes a **new** `reconciliations` row with `supersedes_id` set. The original
  MISMATCH row is never modified.
- Every override emails admin + auditor immediately.
- Track override rate per officer and per location on the admin dashboard. A rising rate
  is either a data-quality problem or a process-abuse problem, and both need visibility.

## 7. Test coverage

`shared-rules` should be the most thoroughly tested package in the repo. At minimum:

- Check digit: known-good container numbers from real BICs, every single-digit mutation,
  every letter-position mutation, boundary cases where `sum % 11 === 10`.
- Normalization: every confusable substitution in both directions, mixed separators,
  lowercase input, leading/trailing whitespace, unicode lookalikes.
- Outcome table: one test per row above, plus the ordering (a container that is both
  expired *and* duplicate must return `EXPIRED_REPORT`).
- Fuzzy chassis: suffix matches at exactly 6 and 5 characters, Levenshtein at 2 and 3,
  the case where a fuzzy match hits two different lines equally well (→ must not auto-pick;
  force manual).
- Property test: for any valid container number, no single-character mutation validates.

Golden-file tests against a set of real anonymized pickup reports are worth the setup cost
— they catch ingest regressions that unit tests miss.
