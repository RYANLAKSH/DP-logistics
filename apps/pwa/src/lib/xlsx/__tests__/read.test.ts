import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readWorkbook } from '../read'
import {
  detectColumns, findHeaderRow, isUsableMapping, validateRows,
} from '@shared/manifest/index.ts'

/**
 * A golden file: the workbook a manager actually uploaded, byte for byte.
 *
 * Unit tests on a hand-written grid prove the parser reasons correctly about
 * a shape someone imagined. Only the real file proves the reader survives what
 * Excel actually writes — blank cells omitted from the XML entirely, a sheet
 * addressed by relationship id, shared strings, and spacer rows.
 */
// Resolved from the project root rather than import.meta.url: under jsdom the
// module URL is an http:// one, and fileURLToPath refuses it.
const bytes = readFileSync(
  resolve(process.cwd(), 'src/lib/xlsx/__tests__/fixtures/tata-motors-pickup-list.xlsx'))
// The reader takes bytes, so the test does not depend on jsdom's Blob.
const file = new Uint8Array(bytes)

describe('reading the real workbook', () => {
  it('finds the sheet and its name', async () => {
    const sheets = await readWorkbook(file)
    expect(sheets).toHaveLength(1)
    expect(sheets[0]!.name).toBe('new')
  })

  it('keeps blank cells in place instead of shifting later columns left', async () => {
    // The failure this guards against is silent and severe: Excel omits empty
    // cells, so a naive reader slides CONT NO into the INVOICE NO column and
    // every vehicle is assigned to an invoice number.
    const [sheet] = await readWorkbook(file)
    const header = sheet!.rows[1]!
    expect(header).toEqual(['SR', 'CHASSIS NO', 'MODEL', 'INVOICE NO', 'CONT NO', 'SEAL'])

    // Row 4 (index 3) is a second vehicle: no container, no seal.
    expect(sheet!.rows[3]).toEqual(
      ['2', 'MAT464844TSR09257', 'ARCTIC_WHITE-YODHA 2.2L SC 4X4 E4', 'MH2730502738', '', ''])
  })

  it('preserves the blank spacer rows between pairs', async () => {
    const [sheet] = await readWorkbook(file)
    const blanks = sheet!.rows.filter((r) => r.every((c) => c === ''))
    expect(blanks.length).toBeGreaterThan(0)
  })

  it('parses end to end into a publishable manifest', async () => {
    const [sheet] = await readWorkbook(file)
    const header = findHeaderRow(sheet!.rows)
    expect(header).toBe(1)

    const map = detectColumns(sheet!.rows[header]!)
    expect(isUsableMapping(map)).toBe(true)
    expect(map).toMatchObject({
      chassisNo: 1, makeModel: 2, invoiceNo: 3, containerNo: 4, sealNo: 5,
    })

    const result = validateRows(sheet!.rows.slice(header + 1), map)
    expect(result.errorSummary).toEqual({})
    expect(result.validCount).toBe(40)
    expect(result.warningSummary.CONTAINER_INHERITED).toBe(20)
  })

  it('holds one chassis to one container, and two chassis per container', async () => {
    const [sheet] = await readWorkbook(file)
    const header = findHeaderRow(sheet!.rows)
    const rows = validateRows(sheet!.rows.slice(header + 1),
      detectColumns(sheet!.rows[header]!)).rows

    const containerOf = new Map<string, Set<string>>()
    const vehiclesIn = new Map<string, Set<string>>()
    for (const r of rows) {
      ;(containerOf.get(r.chassis_no) ?? containerOf.set(r.chassis_no, new Set()).get(r.chassis_no)!)
        .add(r.container_no)
      ;(vehiclesIn.get(r.container_no) ?? vehiclesIn.set(r.container_no, new Set()).get(r.container_no)!)
        .add(r.chassis_no)
    }
    expect([...containerOf].filter(([, s]) => s.size !== 1)).toEqual([])
    expect([...vehiclesIn].filter(([, s]) => s.size !== 2)).toEqual([])
    expect(vehiclesIn.size).toBe(20)
  })

  it('carries the acceptance scenario', async () => {
    const [sheet] = await readWorkbook(file)
    const header = findHeaderRow(sheet!.rows)
    const rows = validateRows(sheet!.rows.slice(header + 1),
      detectColumns(sheet!.rows[header]!)).rows
    const loaded = rows
      .filter((r) => r.container_no === 'TRHU8755445')
      .sort((a, b) => (a.sequence_no ?? 0) - (b.sequence_no ?? 0))
      .map((r) => r.chassis_no)
    expect(loaded).toEqual(['MAT752389T7R20588', 'MAT464844TSR09113'])
  })
})

describe('files it should refuse', () => {
  it('says so plainly when the file is not a ZIP at all', async () => {
    await expect(readWorkbook(new TextEncoder().encode('container,chassis\nA,B')))
      .rejects.toThrow(/not a spreadsheet/i)
  })
})
