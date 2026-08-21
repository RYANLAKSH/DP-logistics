import { describe, expect, it } from 'vitest'
import { diffPositions, groupCode, relativeTime } from '../format'

describe('groupCode', () => {
  it('groups for character-by-character reading', () => {
    expect(groupCode('CULVNSA2601795')).toBe('CULV NSA2 6017 95')
  })

  it('is presentation only — it never alters the value', () => {
    const raw = 'MAT752389T7R19810'
    expect(groupCode(raw).replace(/ /g, '')).toBe(raw)
  })
})

describe('diffPositions', () => {
  it('finds the characters that differ', () => {
    expect(diffPositions('MAT752389T7R19810', 'MAT752389T7R19811')).toEqual([16])
  })

  it('reports every position when lengths differ', () => {
    expect(diffPositions('ABC', 'ABCDE')).toEqual([3, 4])
  })

  it('is empty for identical values', () => {
    expect(diffPositions('CULVNSA2601795', 'CULVNSA2601795')).toEqual([])
  })
})

describe('relativeTime', () => {
  const now = new Date('2026-08-21T10:00:00Z').getTime()
  it('reads naturally at each scale', () => {
    expect(relativeTime('2026-08-21T09:59:30Z', now)).toBe('just now')
    expect(relativeTime('2026-08-21T09:45:00Z', now)).toBe('15 min ago')
    expect(relativeTime('2026-08-21T07:00:00Z', now)).toBe('3 h ago')
    expect(relativeTime('2026-08-19T10:00:00Z', now)).toBe('2 d ago')
  })
})
