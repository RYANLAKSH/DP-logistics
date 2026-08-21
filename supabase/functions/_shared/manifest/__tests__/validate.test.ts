import { describe, expect, it } from 'vitest'
import { detectColumns, findHeaderRow, isUsableMapping } from '../columns.ts'
import { parseDate, validateRows } from '../validate.ts'
import { parseCsv } from '../csv.ts'
import { isValidContainerNo } from '../normalize.ts'

const MAP = { containerNo: 0, chassisNo: 1, sequenceNo: 2 }

function rows(...lines: Array<[string, string, string]>): string[][] {
  return lines.map((l) => [...l])
}

/** Codes only, so assertions do not depend on message wording. */
function codes(result: ReturnType<typeof validateRows>, rowNo: number): string[] {
  const row = result.rows.find((r) => r.row_no === rowNo)
  return (row?.errors ?? []).map((e) => e.split(':')[0]!)
}

describe('the worked example from the build plan', () => {
  it('accepts it cleanly', () => {
    const result = validateRows(
      rows(
        ['CULVNSA2601795', 'MAT752389T7R19810', '1'],
        ['CULVNSA2601795', 'MAT464844TSR09249', '2'],
      ),
      MAP,
    )
    expect(result.validCount).toBe(2)
    expect(result.rejectedCount).toBe(0)
    expect(result.rows.every((r) => r.warnings.length === 0)).toBe(true)
  })
})

describe('per-row validation', () => {
  it('rejects a missing container number', () => {
    const r = validateRows(rows(['', 'MAT752389T7R19810', '1']), MAP)
    expect(codes(r, 1)).toContain('CONTAINER_MISSING')
  })

  it('rejects a missing chassis number', () => {
    const r = validateRows(rows(['CULVNSA2601795', '', '1']), MAP)
    expect(codes(r, 1)).toContain('CHASSIS_MISSING')
  })

  it('rejects invalid characters', () => {
    const r = validateRows(rows(['CULV#NSA@2601', 'MAT-752/389', '1']), MAP)
    // Normalisation strips the punctuation, so these are judged on what is left.
    expect(r.rows[0]!.container_no).toBe('CULVNSA2601')
    expect(r.rows[0]!.chassis_no).toBe('MAT752389')
  })

  it('rejects a container that is too short to be an identifier', () => {
    const r = validateRows(rows(['AB', 'MAT752389T7R19810', '1']), MAP)
    expect(codes(r, 1)).toContain('CONTAINER_INVALID_CHARS')
  })

  it('rejects an ISO-shaped container that fails its check digit', () => {
    expect(isValidContainerNo('MSKU4512345')).toBe(false)
    const r = validateRows(rows(['MSKU4512345', 'MAT752389T7R19810', '1']), MAP)
    expect(codes(r, 1)).toContain('CONTAINER_CHECK_DIGIT')
  })

  it('accepts an ISO-shaped container with a correct check digit', () => {
    const r = validateRows(rows(['MSKU4512340', 'MAT752389T7R19810', '1']), MAP)
    expect(codes(r, 1)).toEqual([])
  })

  it('does not demand a check digit from a non-ISO reference', () => {
    // CULVNSA2601795 is fourteen characters and carries no check digit.
    // Rejecting it would make the product unusable at the yard it was built for.
    const r = validateRows(rows(['CULVNSA2601795', 'MAT752389T7R19810', '1']), MAP)
    expect(codes(r, 1)).toEqual([])
  })

  it('rejects a sequence that is not a small whole number', () => {
    expect(codes(validateRows(rows(['CULVNSA2601795', 'MAT111', 'x']), MAP), 1))
      .toContain('SEQUENCE_INVALID')
    expect(codes(validateRows(rows(['CULVNSA2601795', 'MAT111', '0']), MAP), 1))
      .toContain('SEQUENCE_INVALID')
    expect(codes(validateRows(rows(['CULVNSA2601795', 'MAT111', '99']), MAP), 1))
      .toContain('SEQUENCE_INVALID')
    expect(codes(validateRows(rows(['CULVNSA2601795', 'MAT111', '1.5']), MAP), 1))
      .toContain('SEQUENCE_INVALID')
  })

  it('skips entirely empty rows rather than reporting them', () => {
    // Trailing blank lines are normal in exported spreadsheets. Reporting them
    // trains administrators to ignore the error list.
    const r = validateRows(
      rows(['CULVNSA2601795', 'MAT752389T7R19810', '1'], ['', '', '']),
      MAP,
    )
    expect(r.rowCount).toBe(1)
    expect(r.rejectedCount).toBe(0)
  })

  it('warns about a VIN-length chassis containing I, O or Q', () => {
    const r = validateRows(rows(['CULVNSA2601795', 'MATO52389T7R19810', '1']), MAP)
    expect(r.rows[0]!.warnings.join()).toContain('CHASSIS_VIN_CONFUSABLE')
  })
})

describe('cross-row validation — the checks that stop wrong loads', () => {
  it('rejects a chassis promised to two different containers', () => {
    const r = validateRows(
      rows(
        ['CULVNSA2601795', 'MAT752389T7R19810', '1'],
        ['CULVNSA2601796', 'MAT752389T7R19810', '1'],
      ),
      MAP,
    )
    expect(codes(r, 2)).toContain('CHASSIS_DUPLICATE')
    expect(r.rows[1]!.errors[0]).toContain('CULVNSA2601795')   // names the first
    expect(codes(r, 1)).toEqual([])                            // the first row stands
  })

  it('reports an identical repeated line as a duplicate row, not a conflict', () => {
    const r = validateRows(
      rows(
        ['CULVNSA2601795', 'MAT752389T7R19810', '1'],
        ['CULVNSA2601795', 'MAT752389T7R19810', '1'],
      ),
      MAP,
    )
    expect(codes(r, 2)).toContain('ROW_DUPLICATE')
    expect(codes(r, 2)).not.toContain('CHASSIS_DUPLICATE')
  })

  it('rejects two vehicles in the same slot of one container', () => {
    const r = validateRows(
      rows(
        ['CULVNSA2601795', 'MAT111222A1B00001', '1'],
        ['CULVNSA2601795', 'MAT111222A1B00002', '1'],
      ),
      MAP,
    )
    expect(codes(r, 2)).toContain('SEQUENCE_DUPLICATE')
  })

  it('warns — but does not block — an unusual vehicle count per container', () => {
    const three = validateRows(
      rows(
        ['CULVNSA2601795', 'MAT111222A1B00001', '1'],
        ['CULVNSA2601795', 'MAT111222A1B00002', '2'],
        ['CULVNSA2601795', 'MAT111222A1B00003', '3'],
      ),
      MAP,
    )
    expect(three.rejectedCount).toBe(0)
    expect(three.rows[0]!.warnings.join()).toContain('CONTAINER_VEHICLE_COUNT')
  })

  it('infers a missing sequence in row order, and says it did', () => {
    const r = validateRows(
      rows(
        ['CULVNSA2601795', 'MAT111222A1B00001', ''],
        ['CULVNSA2601795', 'MAT111222A1B00002', ''],
      ),
      MAP,
    )
    expect(r.rows.map((x) => x.sequence_no)).toEqual([1, 2])
    expect(r.rows[0]!.warnings.join()).toContain('SEQUENCE_INFERRED')
  })

  it('does not silently overwrite a sequence that was given and is wrong', () => {
    const r = validateRows(rows(['CULVNSA2601795', 'MAT111', '9']), MAP)
    expect(codes(r, 1)).toContain('SEQUENCE_INVALID')
    expect(r.rows[0]!.sequence_no).toBeNull()
  })

  it('summarises errors by code for the preview', () => {
    const r = validateRows(
      rows(
        ['', 'MAT111222A1B00001', '1'],
        ['', 'MAT111222A1B00002', '1'],
        ['CULVNSA2601795', '', '1'],
      ),
      MAP,
    )
    expect(r.errorSummary.CONTAINER_MISSING).toBe(2)
    expect(r.errorSummary.CHASSIS_MISSING).toBe(1)
    expect(r.rejectedCount).toBe(3)
  })
})

describe('dates', () => {
  it('accepts ISO', () => expect(parseDate('2026-08-21')).toBe('2026-08-21'))

  it('reads an unambiguous d/m/y or m/d/y', () => {
    expect(parseDate('21/08/2026')).toBe('2026-08-21')
    expect(parseDate('08/21/2026')).toBe('2026-08-21')
  })

  it('refuses an ambiguous date rather than guessing', () => {
    // 03/04 could be 3 April or 4 March. Guessing shifts a whole manifest.
    expect(parseDate('03/04/2026')).toBeNull()
  })

  it('refuses nonsense', () => {
    expect(parseDate('not a date')).toBeNull()
    expect(parseDate('45/45/2026')).toBeNull()
  })

  it('rejects a row dated differently from the manifest', () => {
    const r = validateRows(
      [['CULVNSA2601795', 'MAT752389T7R19810', '1', '2026-08-20']],
      { ...MAP, operatingDate: 3 },
      { operatingDate: '2026-08-21' },
    )
    expect(codes(r, 1)).toContain('DATE_MISMATCH')
  })
})

describe('column detection', () => {
  it('matches the obvious headers', () => {
    const map = detectColumns(['Container Number', 'Chassis Number', 'Sequence'])
    expect(map).toMatchObject({ containerNo: 0, chassisNo: 1, sequenceNo: 2 })
    expect(isUsableMapping(map)).toBe(true)
  })

  it('matches synonyms and ignores case and punctuation', () => {
    const map = detectColumns(['CNTR_NO', 'VIN', 'Slot No.', 'Reg No', 'Model'])
    expect(map).toMatchObject({
      containerNo: 0, chassisNo: 1, sequenceNo: 2, vehicleRegNo: 3, makeModel: 4,
    })
  })

  it('reports an unusable mapping rather than guessing', () => {
    expect(isUsableMapping(detectColumns(['Foo', 'Bar']))).toBe(false)
  })

  it('finds a header that is not the first row', () => {
    // Real files carry a title and a blank line before the table.
    const rows = parseCsv(
      'DAILY LOADING MANIFEST\n\nNhava Sheva\nContainer,Chassis,Seq\nCULVNSA2601795,MAT1,1',
    )
    expect(findHeaderRow(rows)).toBe(3)
  })

  it('returns -1 when no row looks like a header', () => {
    expect(findHeaderRow(parseCsv('1,2,3\n4,5,6'))).toBe(-1)
  })
})
