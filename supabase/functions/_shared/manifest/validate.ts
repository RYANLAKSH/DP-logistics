/**
 * Manifest validation.
 *
 * Rows are REJECTED, never guessed at. A row the system silently "corrects" is
 * a vehicle sent somewhere nobody chose, and the correction is invisible in
 * the audit trail because no human ever saw it.
 */
import { isBlank, isIso6346Shaped, isValidContainerNo, normalizeCode } from './normalize.ts'
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
}

export interface ValidateOptions {
  /** Rows whose container count differs from this are warned about, not blocked. */
  expectedVehiclesPerContainer?: number
  /** When set, a row carrying a different date is rejected. */
  operatingDate?: string
}

const CHASSIS_PATTERN = /^[A-Z0-9]{5,25}$/
const CONTAINER_PATTERN = /^[A-Z0-9]{4,15}$/

export function validateRows(
  raw: string[][],
  map: ColumnMap,
  options: ValidateOptions = {},
): ValidationResult {
  const expectedPerContainer = options.expectedVehiclesPerContainer ?? 2
  const rows: ParsedRow[] = []

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

    const containerNo = normalizeCode(containerRaw)
    const chassisNo = normalizeCode(chassisRaw)

    if (isBlank(containerRaw)) {
      errors.push('CONTAINER_MISSING: container number is missing')
    } else if (!CONTAINER_PATTERN.test(containerNo)) {
      errors.push(
        `CONTAINER_INVALID_CHARS: "${containerRaw}" contains characters that are not letters or digits, or is the wrong length`,
      )
    } else if (isIso6346Shaped(containerNo) && !isValidContainerNo(containerNo)) {
      // Only checked when the identifier is ISO-shaped: many operators use
      // their own references, which carry no check digit at all.
      errors.push(
        `CONTAINER_CHECK_DIGIT: "${containerNo}" fails its ISO 6346 check digit`,
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
  for (const row of rows) {
    if (row.sequence_no == null && row.container_no && row.errors.length === 0) {
      const n = (nextSlot.get(row.container_no) ?? 0) + 1
      nextSlot.set(row.container_no, n)
      row.sequence_no = n
      row.warnings.push(`SEQUENCE_INFERRED: no sequence given, assigned slot ${n}`)
    } else if (row.sequence_no != null) {
      nextSlot.set(
        row.container_no,
        Math.max(nextSlot.get(row.container_no) ?? 0, row.sequence_no),
      )
    }
  }

  const errorSummary: Record<string, number> = {}
  for (const row of rows) {
    for (const e of row.errors) {
      const code = e.split(':')[0]!
      errorSummary[code] = (errorSummary[code] ?? 0) + 1
    }
  }

  const rejectedCount = rows.filter((r) => r.errors.length > 0).length
  return {
    rows,
    rowCount: rows.length,
    validCount: rows.length - rejectedCount,
    rejectedCount,
    errorSummary,
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
