import { describe, expect, it } from 'vitest'
import {
  detectColumns, findHeaderRow, parseDelimited, validateRows,
} from '@shared/manifest/index.ts'
import { SAMPLE_PICKUP_LIST_CSV } from '../samplePickupList'

function parse(csv: string) {
  const grid = parseDelimited(csv)
  const header = findHeaderRow(grid)
  const map = detectColumns(grid[header]!)
  return { grid, map, result: validateRows(grid.slice(header + 1), map) }
}

const { grid, result } = parse(SAMPLE_PICKUP_LIST_CSV)
const accepted = result.rows.filter((r) => r.errors.length === 0)

/**
 * The rule the product exists to enforce, asserted against the real list:
 * one chassis belongs to exactly one container, one container carries exactly
 * two chassis. If this file ever stops holding that, the acceptance scenario
 * below is testing something the business would never ship.
 */
describe('the pickup list', () => {
  it('parses without a single rejection', () => {
    expect(result.errorSummary).toEqual({})
    expect(result.validCount).toBe(40)
  })

  it('gives every chassis exactly one container', () => {
    const containers = new Map<string, Set<string>>()
    for (const r of accepted) {
      const set = containers.get(r.chassis_no) ?? new Set<string>()
      set.add(r.container_no)
      containers.set(r.chassis_no, set)
    }
    expect(containers.size).toBe(40)
    expect([...containers].filter(([, set]) => set.size > 1)).toEqual([])
  })

  it('gives every container exactly two chassis', () => {
    const vehicles = new Map<string, Set<string>>()
    for (const r of accepted) {
      const set = vehicles.get(r.container_no) ?? new Set<string>()
      set.add(r.chassis_no)
      vehicles.set(r.container_no, set)
    }
    expect(vehicles.size).toBe(20)
    expect([...vehicles].filter(([, set]) => set.size !== 2)).toEqual([])
  })

  it('validates every container number against ISO 6346', () => {
    // A check digit failure here would mean the list itself is mistyped.
    expect(result.errorSummary.CONTAINER_CHECK_DIGIT).toBeUndefined()
  })

  it('carries every container number forward to its second vehicle', () => {
    expect(result.warningSummary.CONTAINER_INHERITED).toBe(20)
  })

  it('survives the blank spacer rows between pairs', () => {
    // The file separates pairs with an empty row. Counting them as vehicles,
    // or letting one break the pairing, would mis-slot half the manifest.
    const blanks = grid.filter((r) => r.every((c) => c.trim() === '')).length
    expect(blanks).toBeGreaterThan(0)
    expect(result.rowCount).toBe(40)
  })
})

describe('the acceptance scenario', () => {
  it('pairs TRHU8755445 with exactly the two vehicles it is tested with', () => {
    const loaded = accepted
      .filter((r) => r.container_no === 'TRHU8755445')
      .sort((a, b) => (a.sequence_no ?? 0) - (b.sequence_no ?? 0))
      .map((r) => r.chassis_no)
    expect(loaded).toEqual(['MAT752389T7R20588', 'MAT464844TSR09113'])
  })

  it('puts neither of those vehicles in any other container', () => {
    for (const chassis of ['MAT752389T7R20588', 'MAT464844TSR09113']) {
      const rows = accepted.filter((r) => r.chassis_no === chassis)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.container_no).toBe('TRHU8755445')
    }
  })
})

describe('a vehicle listed against a second container', () => {
  // The failure the rule exists to catch, built from the real list: take the
  // first vehicle of one container and list it again under another.
  const lines = SAMPLE_PICKUP_LIST_CSV.trimEnd().split('\n')
  const forged = [...lines, '41,MAT752389T7R20588,T.7 ULTRA,MH2730495315,CAIU4330430,99999'].join('\n')
  const { result: withDupe } = parse(forged)

  it('is rejected, not merged or warned about', () => {
    expect(withDupe.errorSummary.CHASSIS_DUPLICATE).toBe(1)
    expect(withDupe.rejectedCount).toBe(1)
  })

  it('names the container that vehicle was already promised to', () => {
    const dupe = withDupe.rows.find((r) =>
      r.errors.some((e) => e.startsWith('CHASSIS_DUPLICATE')))!
    expect(dupe.errors[0]).toContain('TRHU8755445')
  })

  it('leaves the original assignment untouched', () => {
    const original = withDupe.rows.filter((r) => r.chassis_no === 'MAT752389T7R20588')
    expect(original[0]!.container_no).toBe('TRHU8755445')
    expect(original[0]!.errors).toEqual([])
  })
})
