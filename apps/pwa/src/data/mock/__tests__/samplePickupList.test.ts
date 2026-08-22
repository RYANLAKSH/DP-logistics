import { describe, expect, it } from 'vitest'
import {
  detectColumns, findHeaderRow, parseDelimited, validateRows,
} from '@shared/manifest/index.ts'
import {
  SAMPLE_PICKUP_LIST_CSV, SAMPLE_PICKUP_LIST_EARLIER_CSV,
} from '../samplePickupList'

function parse(csv: string) {
  const grid = parseDelimited(csv)
  const header = findHeaderRow(grid)
  const map = detectColumns(grid[header]!)
  return { map, result: validateRows(grid.slice(header + 1), map) }
}

/**
 * The rule the product exists to enforce, asserted against the customer's own
 * paperwork: one chassis belongs to exactly one container, and one container
 * carries exactly two chassis.
 */
describe('the current plan (sheet "new")', () => {
  const { result } = parse(SAMPLE_PICKUP_LIST_CSV)
  const rows = result.rows.filter((r) => r.errors.length === 0)

  it('parses without a single rejection', () => {
    expect(result.errorSummary).toEqual({})
    expect(result.validCount).toBe(40)
  })

  it('gives every chassis exactly one container', () => {
    const containers = new Map<string, Set<string>>()
    for (const r of rows) {
      const set = containers.get(r.chassis_no) ?? new Set()
      set.add(r.container_no)
      containers.set(r.chassis_no, set)
    }
    expect(containers.size).toBe(40)
    const shared = [...containers].filter(([, set]) => set.size > 1)
    expect(shared).toEqual([])
  })

  it('gives every container exactly two chassis', () => {
    const vehicles = new Map<string, Set<string>>()
    for (const r of rows) {
      const set = vehicles.get(r.container_no) ?? new Set()
      set.add(r.chassis_no)
      vehicles.set(r.container_no, set)
    }
    expect(vehicles.size).toBe(20)
    expect([...vehicles].filter(([, set]) => set.size !== 2)).toEqual([])
  })

  it('pairs TRHU8755445 with the two vehicles the acceptance scenario names', () => {
    const loaded = rows
      .filter((r) => r.container_no === 'TRHU8755445')
      .sort((a, b) => (a.sequence_no ?? 0) - (b.sequence_no ?? 0))
      .map((r) => r.chassis_no)
    expect(loaded).toEqual(['MAT752389T7R20588', 'MAT464844TSR09113'])
  })

  it('carries every container number forward to its second vehicle', () => {
    expect(result.warningSummary.CONTAINER_INHERITED).toBe(20)
  })
})

describe('the earlier plan (sheet 1)', () => {
  const { result } = parse(SAMPLE_PICKUP_LIST_EARLIER_CSV)

  it('is a complete plan in its own right', () => {
    expect(result.rowCount).toBe(40)
    // Every rejection in it is the one mistyped container, nothing structural.
    expect(Object.keys(result.errorSummary)).toEqual(['CONTAINER_CHECK_DIGIT'])
  })

  it('is blocked only by BMOU6433014, which the later sheet writes as BMOU6533014', () => {
    const bad = result.rows.filter((r) => r.errors.length > 0)
    expect(bad).toHaveLength(2)          // both vehicles of that container
    expect(bad[0]!.container_no).toBe('BMOU6433014')
    expect(SAMPLE_PICKUP_LIST_CSV).toContain('BMOU6533014')
  })

  it('allocates the same vehicles to different containers than the current plan', () => {
    // This is why the two sheets must never be uploaded as one manifest.
    const current = parse(SAMPLE_PICKUP_LIST_CSV).result.rows
    const earlier = result.rows
    const where = new Map(current.map((r) => [r.chassis_no, r.container_no]))
    const moved = earlier.filter((r) => where.get(r.chassis_no) !== r.container_no)
    expect(moved.length).toBeGreaterThan(30)
  })
})

describe('the two plans concatenated, as one file', () => {
  // What happens if someone pastes both sheets together. Every vehicle would
  // then be promised to two containers, which is the exact failure the yard
  // cannot recover from — so it has to be a rejection, not a warning.
  const both = SAMPLE_PICKUP_LIST_CSV
    + parseDelimited(SAMPLE_PICKUP_LIST_EARLIER_CSV).slice(2).map((r) => r.join(',')).join('\n')
  const { result } = parse(both)

  it('rejects every vehicle that a second row sends somewhere else', () => {
    expect(result.errorSummary.CHASSIS_DUPLICATE).toBeGreaterThan(30)
    expect(result.rejectedCount).toBeGreaterThan(30)
  })

  it('names the container the vehicle was already promised to', () => {
    const dupe = result.rows.find((r) =>
      r.errors.some((e) => e.startsWith('CHASSIS_DUPLICATE')))!
    expect(dupe.errors[0]).toMatch(/is already assigned to [A-Z]{4}\d{7} on row \d+/)
  })
})
