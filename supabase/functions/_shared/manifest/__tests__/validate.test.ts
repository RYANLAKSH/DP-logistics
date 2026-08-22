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

/**
 * The customer's actual pickup list, transcribed verbatim.
 *
 * Everything that made it fail before is preserved: the title on row 1, the
 * header on row 2, "SR" as a running serial rather than a slot, the container
 * number written only on the first vehicle of each pair, and — on the second
 * sheet — a blank spacer row between pairs.
 */
describe('the real TATA MOTORS pickup list', () => {
  const SHEET = [
    ['TATA MOTORS CULVNSA2601795 20x40 ', '', '', '', '', ''],
    ['SR', 'CHASSIS NO', 'MODEL', 'INVOICE NO', 'CONT NO', 'SEAL'],
    ['1', 'MAT752389T7R20507', 'T.7 ULTRA DCR35HSD 155E4M6', 'MH2730495315', 'TGCU5033177', '11866'],
    ['2', 'MAT464844TSR09249', 'ARCTIC_WHITE-YODHA 2.2L SC 4X4 E4', 'MH2730502737', '', ''],
    ['3', 'MAT752389T7R18439', 'T.7 ULTRA DCR35HSD 155E4M6', 'MH2730495315', 'CAIU7456843', '13046'],
    ['4', 'MAT464844TSR09184', 'ARCTIC_WHITE-YODHA 2.2L SC 4X4 E4', 'MH2730502737', '', ''],
    ['', '', '', '', '', ''],
    ['5', 'MAT752389T7R20477', 'T.7 ULTRA DCR35HSD 155E4M6', 'MH2730495315', 'TGCU5034147', '13048'],
    ['6', 'MAT464844TSR09120', 'ARCTIC_WHITE-YODHA 2.2L SC 4X4 E4', 'MH2730502737', '', ''],
  ]

  const header = findHeaderRow(SHEET)
  const map = detectColumns(SHEET[header]!)
  const body = SHEET.slice(header + 1)
  const result = validateRows(body, map)

  it('finds the header under the title row', () => {
    expect(header).toBe(1)
    expect(isUsableMapping(map)).toBe(true)
  })

  it('maps chassis before container, and picks up invoice and seal', () => {
    expect(map).toMatchObject({
      chassisNo: 1, makeModel: 2, invoiceNo: 3, containerNo: 4, sealNo: 5,
    })
  })

  it('does not mistake the SR serial for a slot number', () => {
    // "SR" runs 1..40 down the sheet. Read as a slot it rejects every row past
    // the sixth, and silently mis-slots the ones before it.
    expect(map.sequenceNo).toBeUndefined()
  })

  it('accepts every vehicle row', () => {
    expect(result.rejectedCount).toBe(0)
    expect(result.validCount).toBe(6)
    expect(result.errorSummary).toEqual({})
  })

  it('carries the container forward to the second vehicle of each pair', () => {
    const byChassis = (c: string) => result.rows.find((r) => r.chassis_no === c)!
    expect(byChassis('MAT752389T7R20507').container_no).toBe('TGCU5033177')
    expect(byChassis('MAT464844TSR09249').container_no).toBe('TGCU5033177')
    expect(byChassis('MAT752389T7R18439').container_no).toBe('CAIU7456843')
    expect(byChassis('MAT464844TSR09184').container_no).toBe('CAIU7456843')
  })

  it('discloses every inherited container instead of inheriting silently', () => {
    expect(result.warningSummary.CONTAINER_INHERITED).toBe(3)
    const second = result.rows.find((r) => r.chassis_no === 'MAT464844TSR09249')!
    expect(second.container_inherited).toBe(true)
    expect(second.warnings.join(' ')).toContain('TGCU5033177')
  })

  it('does not let a blank spacer row break the pairing', () => {
    const after = result.rows.find((r) => r.chassis_no === 'MAT752389T7R20477')!
    expect(after.container_no).toBe('TGCU5034147')
    expect(after.container_inherited).toBeUndefined()
  })

  it('does not warn about inferred slots when the file has no such column', () => {
    // Otherwise every row of every real upload carries a warning, and the
    // banner that flags genuine anomalies gets ignored.
    expect(result.warningSummary.SEQUENCE_INFERRED).toBeUndefined()
  })

  it('numbers the slots from row order within each container', () => {
    const slots = result.rows.map((r) => [r.container_no, r.sequence_no])
    expect(slots).toEqual([
      ['TGCU5033177', 1], ['TGCU5033177', 2],
      ['CAIU7456843', 1], ['CAIU7456843', 2],
      ['TGCU5034147', 1], ['TGCU5034147', 2],
    ])
  })

  it('keeps the seal on the container row, not on both vehicles', () => {
    const rows = result.rows.filter((r) => r.container_no === 'TGCU5033177')
    expect(rows.map((r) => r.seal_no)).toEqual(['11866', undefined])
    expect(rows.map((r) => r.invoice_no))
      .toEqual(['MH2730495315', 'MH2730502737'])
  })

  it('validates the real container numbers against ISO 6346', () => {
    for (const c of ['TGCU5033177', 'CAIU7456843', 'TGCU5034147', 'CICU7368618',
                     'CICU7048574', 'TRHU8755445', 'CAIU4330430', 'FFAU3426306',
                     'CULU6322000', 'TGBU8901124', 'TRHU6366932']) {
      expect(isValidContainerNo(c), c).toBe(true)
    }
  })

  it('catches the one number in the real list that is mistyped', () => {
    // BMOU6433014 appears on the customer's sheet and fails its own check
    // digit — 20 of the 21 numbers in that file are clean, this one is not.
    // Rejecting it at upload is the whole point: otherwise a driver discovers
    // it standing at a container that will never match.
    const r = validateRows(
      [['MAT752389T7R20507', 'BMOU6433014']],
      { chassisNo: 0, containerNo: 1 },
    )
    expect(codes(r, 1)).toEqual(['CONTAINER_CHECK_DIGIT'])
    // And it says what the number probably should have been.
    expect(r.rows[0]!.errors[0]).toContain('BMOU6433015')
  })
})

describe('container carry-forward is bounded', () => {
  const MAP6 = { chassisNo: 0, containerNo: 1 }

  it('refuses a third blank row rather than overfilling the container', () => {
    const r = validateRows([
      ['MAT752389T7R20507', 'TGCU5033177'],
      ['MAT464844TSR09249', ''],
      ['MAT464844TSR09184', ''],      // nobody assigned this one anywhere
    ], MAP6)
    expect(codes(r, 3)).toEqual(['CONTAINER_MISSING'])
  })

  it('does not inherit into a file that writes the container on every row', () => {
    // Here the blank row is a genuine omission, not the second half of a pair:
    // the container above it already has both its vehicles.
    const r = validateRows([
      ['MAT752389T7R20507', 'TGCU5033177'],
      ['MAT464844TSR09249', 'TGCU5033177'],
      ['MAT464844TSR09184', ''],
    ], MAP6)
    expect(codes(r, 3)).toEqual(['CONTAINER_MISSING'])
    expect(r.rows[2]!.container_no).toBe('')
  })

  it('refuses to inherit when no container has been declared yet', () => {
    const r = validateRows([['MAT464844TSR09249', '']], MAP6)
    expect(codes(r, 1)).toEqual(['CONTAINER_MISSING'])
  })

  it('can be turned off, and then rejects the second vehicle of every pair', () => {
    const r = validateRows([
      ['MAT752389T7R20507', 'TGCU5033177'],
      ['MAT464844TSR09249', ''],
    ], MAP6, { carryForwardContainer: false })
    expect(codes(r, 2)).toEqual(['CONTAINER_MISSING'])
  })

  it('still applies the check digit to an inherited number', () => {
    // Inheriting must not be a way past validation the written row would fail.
    const r = validateRows([
      ['MAT752389T7R20507', 'TGCU5033178'],   // one digit out
      ['MAT464844TSR09249', ''],
    ], MAP6)
    expect(codes(r, 1)).toEqual(['CONTAINER_CHECK_DIGIT'])
    expect(codes(r, 2)).toEqual(['CONTAINER_CHECK_DIGIT'])
  })
})
