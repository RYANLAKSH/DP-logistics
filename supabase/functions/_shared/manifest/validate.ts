/**
 * Manifest validation.
 *
 * Rows are REJECTED, never guessed at. A row the system silently "corrects" is
 * a vehicle sent somewhere nobody chose, and the correction is invisible in
 * the audit trail because no human ever saw it.
 *
 * Container carry-forward (below) is the one inference this module makes, and
 * it is not silent: every inherited row carries a CONTAINER_INHERITED warning
 * into the preview, and a manager approves the manifest before any driver can
 * see it. See the comment on `carryForwardContainer`.
 */
import {
  containerCheckDigit, isBlank, isIso6346Shaped, isValidContainerNo, normalizeCode,
} from './normalize.ts'
import type { ColumnMap } from './columns.ts'

export interface ParsedRow {
  row_no: number
  container_no: string
  chassis_no: string
  sequence_no: number | null
  vehicle_reg_no?: string
  make_model?: string
  colour?: string
  bay_position?: string
  invoice_no?: string
  seal_no?: string
  /** True when the container number came from the row above, not this row. */
  container_inherited?: boolean
  errors: string[]
  warnings: string[]
}

export interface ValidationResult {
  rows: ParsedRow[]
  rowCount: number
  validCount: number
  rejectedCount: number
  /** Counts per error code, for the preview summary. */
  errorSummary: Record<string, number>
  /** Counts per warning code. Inherited containers show up here. */
  warningSummary: Record<string, number>
}

export interface ValidateOptions {
  /** Rows whose container count differs from this are warned about, not blocked. */
  expectedVehiclesPerContainer?: number
  /** When set, a row carrying a different date is rejected. */
  operatingDate?: string
  /**
   * Whether a blank container cell inherits the container from the row above.
   *
   * The real pickup lists write the container number once per container and
   * leave it blank on the second vehicle:
   *
   *     SR  CHASSIS NO          MODEL      INVOICE NO    CONT NO      SEAL
   *     1   MAT752389T7R20507   T.7 ULTRA  MH2730495315  TGCU5033177  11866
   *     2   MAT464844TSR09249   YODHA      MH2730502737
   *
   * Without this, half of every real file is rejected as CONTAINER_MISSING and
   * the product is unusable on day one. It is bounded rather than open-ended:
   * a container only absorbs rows up to its expected vehicle count, so a third
   * blank row is still an error rather than a third vehicle nobody assigned.
   */
  carryForwardContainer?: boolean
}

const CHASSIS_PATTERN = /^[A-Z0-9]{5,25}$/
const CONTAINER_PATTERN = /^[A-Z0-9]{4,15}$/

export function validateRows(
  raw: string[][],
  map: ColumnMap,
  options: ValidateOptions = {},
): ValidationResult {
  const expectedPerContainer = options.expectedVehiclesPerContainer ?? 2
  const carryForward = options.carryForwardContainer ?? true
  const rows: ParsedRow[] = []

  // The container most recently declared by a row, and how many rows have been
  // attributed to it so far (including the one that declared it).
  let openContainer: string | null = null
  let openContainerRowNo = 0
  let openContainerCount = 0

  const cell = (r: string[], index: number | undefined): string =>
    index === undefined ? '' : (r[index] ?? '').trim()

  // ---------------------------------------------------------------- pass 1
  // Per-row checks. Everything that can be judged without seeing the file.
  raw.forEach((r, offset) => {
    const rowNo = offset + 1
    const errors: string[] = []
    const warnings: string[] = []

    const containerRaw = cell(r, map.containerNo)
    const chassisRaw = cell(r, map.chassisNo)
    const sequenceRaw = cell(r, map.sequenceNo)
    const dateRaw = cell(r, map.operatingDate)

    // An entirely empty row is skipped, not reported. Trailing blank lines are
    // normal in exported spreadsheets and reporting them as errors would train
    // administrators to ignore the error list.
    if (r.every((c) => isBlank(c))) return

    let containerNo = normalizeCode(containerRaw)
    const chassisNo = normalizeCode(chassisRaw)
    let inherited = false

    // Carry-forward runs before validation so an inherited number is checked
    // exactly as strictly as a written one.
    if (isBlank(containerRaw) && carryForward && !isBlank(chassisRaw)) {
      if (openContainer && openContainerCount < expectedPerContainer) {
        containerNo = openContainer
        inherited = true
        openContainerCount += 1
        warnings.push(
          `CONTAINER_INHERITED: no container on this row, taken from ${openContainer} on row ${openContainerRowNo}`,
        )
      } else if (openContainer) {
        errors.push(
          `CONTAINER_MISSING: container number is missing, and ${openContainer} on row ${openContainerRowNo} already holds ${openContainerCount} vehicle${openContainerCount === 1 ? '' : 's'}`,
        )
      }
    }

    if (!isBlank(containerRaw)) {
      if (containerNo === openContainer) {
        // The same container written out again on the next line. Counting it
        // as a second vehicle rather than restarting the count is what stops a
        // file that repeats the number on every row from then inheriting into
        // a blank row that genuinely has no container.
        openContainerCount += 1
      } else {
        openContainer = containerNo
        openContainerRowNo = rowNo
        openContainerCount = 1
      }
    }

    if (isBlank(containerRaw) && !inherited) {
      if (!errors.some((e) => e.startsWith('CONTAINER_MISSING'))) {
        errors.push('CONTAINER_MISSING: container number is missing')
      }
    } else if (!CONTAINER_PATTERN.test(containerNo)) {
      errors.push(
        `CONTAINER_INVALID_CHARS: "${containerRaw}" contains characters that are not letters or digits, or is the wrong length`,
      )
    } else if (isIso6346Shaped(containerNo) && !isValidContainerNo(containerNo)) {
      // Only checked when the identifier is ISO-shaped: many operators use
      // their own references, which carry no check digit at all.
      //
      // This stays a rejection, not a warning, and the customer's own list
      // proves why: one number in it (BMOU6433014) fails here. A container
      // number is typed into the spreadsheet by hand, and the driver will scan
      // the real one off the physical box. A typo the upload lets through
      // becomes a driver blocked at a container with a manager on the phone.
      // Catching it at upload costs one correction; catching it in the yard
      // costs a movement. Naming the digit that would make it valid turns the
      // correction into a ten-second job.
      const expected = containerCheckDigit(containerNo.slice(0, 10))
      errors.push(
        `CONTAINER_CHECK_DIGIT: "${containerNo}" fails its ISO 6346 check digit`
        + (expected === null
          ? ''
          : ` — ${containerNo.slice(0, 10)}${expected} would be valid. Check it against the container itself.`),
      )
    }

    if (isBlank(chassisRaw)) {
      errors.push('CHASSIS_MISSING: chassis number is missing')
    } else if (!CHASSIS_PATTERN.test(chassisNo)) {
      errors.push(
        `CHASSIS_INVALID_CHARS: "${chassisRaw}" contains characters that are not letters or digits, or is the wrong length`,
      )
    } else if (/[IOQ]/.test(chassisNo) && chassisNo.length === 17) {
      // I, O and Q are never valid in a 17-character VIN.
      warnings.push(
        `CHASSIS_VIN_CONFUSABLE: "${chassisNo}" is VIN-length but contains I, O or Q`,
      )
    }

    let sequenceNo: number | null = null
    if (!isBlank(sequenceRaw)) {
      const parsed = Number(sequenceRaw)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 6) {
        errors.push(
          `SEQUENCE_INVALID: "${sequenceRaw}" is not a whole number between 1 and 6`,
        )
      } else {
        sequenceNo = parsed
      }
    }

    if (!isBlank(dateRaw) && options.operatingDate) {
      const parsed = parseDate(dateRaw)
      if (!parsed) {
        errors.push(`DATE_INVALID: "${dateRaw}" is not a date this system can read`)
      } else if (parsed !== options.operatingDate) {
        errors.push(
          `DATE_MISMATCH: row is dated ${parsed}, this manifest is for ${options.operatingDate}`,
        )
      }
    }

    rows.push({
      row_no: rowNo,
      container_no: containerNo,
      chassis_no: chassisNo,
      sequence_no: sequenceNo,
      vehicle_reg_no: cell(r, map.vehicleRegNo) || undefined,
      make_model: cell(r, map.makeModel) || undefined,
      colour: cell(r, map.colour) || undefined,
      bay_position: cell(r, map.bayPosition) || undefined,
      invoice_no: cell(r, map.invoiceNo) || undefined,
      // The seal belongs to the container, so an inherited row has none of its
      // own. Reading it off the declaring row would invent a second seal.
      seal_no: cell(r, map.sealNo) || undefined,
      container_inherited: inherited || undefined,
      errors,
      warnings,
    })
  })

  // ---------------------------------------------------------------- pass 2
  // Cross-row checks. These are the ones that actually stop vehicles going to
  // the wrong place, and none of them can be judged one row at a time.
  const chassisFirstSeen = new Map<string, ParsedRow>()
  const pairFirstSeen = new Map<string, ParsedRow>()
  const slotFirstSeen = new Map<string, ParsedRow>()
  const containerCounts = new Map<string, number>()

  for (const row of rows) {
    if (row.chassis_no) {
      const previous = chassisFirstSeen.get(row.chassis_no)
      if (previous) {
        if (previous.container_no === row.container_no) {
          // Same vehicle, same container, twice: a duplicated line.
          row.errors.push(
            `ROW_DUPLICATE: identical to row ${previous.row_no}`,
          )
        } else {
          // The dangerous one: one vehicle promised to two containers.
          row.errors.push(
            `CHASSIS_DUPLICATE: ${row.chassis_no} is already assigned to ${previous.container_no} on row ${previous.row_no}`,
          )
        }
      } else {
        chassisFirstSeen.set(row.chassis_no, row)
      }
    }

    const pairKey = `${row.container_no}|${row.chassis_no}`
    if (row.container_no && row.chassis_no) {
      const previous = pairFirstSeen.get(pairKey)
      if (previous && previous !== row) {
        if (!row.errors.some((e) => e.startsWith('ROW_DUPLICATE'))) {
          row.errors.push(`ASSIGNMENT_DUPLICATE: same pairing as row ${previous.row_no}`)
        }
      } else {
        pairFirstSeen.set(pairKey, row)
      }
    }

    if (row.container_no && row.sequence_no != null) {
      const slotKey = `${row.container_no}|${row.sequence_no}`
      const previous = slotFirstSeen.get(slotKey)
      if (previous) {
        row.errors.push(
          `SEQUENCE_DUPLICATE: slot ${row.sequence_no} of ${row.container_no} is already taken by row ${previous.row_no}`,
        )
      } else {
        slotFirstSeen.set(slotKey, row)
      }
    }

    if (row.container_no && row.errors.length === 0) {
      containerCounts.set(row.container_no, (containerCounts.get(row.container_no) ?? 0) + 1)
    }
  }

  // Vehicle count per container. A warning, not an error: the brief says
  // "normally two", and blocking every exception would make the product
  // unusable the first time a container legitimately takes one or three.
  for (const row of rows) {
    const count = containerCounts.get(row.container_no)
    if (count != null && count !== expectedPerContainer) {
      row.warnings.push(
        `CONTAINER_VEHICLE_COUNT: ${row.container_no} has ${count} vehicle${count === 1 ? '' : 's'}, expected ${expectedPerContainer}`,
      )
    }
  }

  // Fill in sequence numbers the file did not supply, in row order within the
  // container. Doing this AFTER validation means an explicitly wrong sequence
  // is still an error rather than being quietly overwritten.
  const nextSlot = new Map<string, number>()
  // A file with no sequence column at all is the normal case, not an anomaly —
  // none of the real pickup lists carry one. Warning on every row of every
  // upload teaches managers to ignore the warning banner, which costs more
  // than it buys. A blank cell in a file that DOES have the column is
  // different: something was left out, and that is worth a second look.
  const hasSequenceColumn = map.sequenceNo !== undefined
  for (const row of rows) {
    if (row.sequence_no == null && row.container_no && row.errors.length === 0) {
      const n = (nextSlot.get(row.container_no) ?? 0) + 1
      nextSlot.set(row.container_no, n)
      row.sequence_no = n
      if (hasSequenceColumn) {
        row.warnings.push(`SEQUENCE_INFERRED: no sequence given, assigned slot ${n}`)
      }
    } else if (row.sequence_no != null) {
      nextSlot.set(
        row.container_no,
        Math.max(nextSlot.get(row.container_no) ?? 0, row.sequence_no),
      )
    }
  }

  const errorSummary: Record<string, number> = {}
  const warningSummary: Record<string, number> = {}
  for (const row of rows) {
    for (const e of row.errors) {
      const code = e.split(':')[0]!
      errorSummary[code] = (errorSummary[code] ?? 0) + 1
    }
    for (const w of row.warnings) {
      const code = w.split(':')[0]!
      warningSummary[code] = (warningSummary[code] ?? 0) + 1
    }
  }

  const rejectedCount = rows.filter((r) => r.errors.length > 0).length
  return {
    rows,
    rowCount: rows.length,
    validCount: rows.length - rejectedCount,
    rejectedCount,
    errorSummary,
    warningSummary,
  }
}

/** Accepts ISO, d/m/y and m/d/y only when unambiguous. Returns YYYY-MM-DD. */
export function parseDate(raw: string): string | null {
  const s = raw.trim()
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s

  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})$/)
  if (!m) return null
  const a = Number(m[1]), b = Number(m[2])
  let year = Number(m[3])
  if (year < 100) year += 2000

  // Ambiguous (both <= 12) is refused rather than guessed. Reading 03/04 as
  // the wrong date silently shifts a whole manifest by a month.
  let day: number, month: number
  if (a > 12 && b <= 12) { day = a; month = b }
  else if (b > 12 && a <= 12) { month = a; day = b }
  else return null

  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  const iso = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  const check = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(check.getTime()) ? null : iso
}
