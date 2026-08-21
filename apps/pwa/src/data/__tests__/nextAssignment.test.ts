import { describe, expect, it } from 'vitest'
import { pickNextAssignment } from '../nextAssignment'
import type { Assignment, AssignmentStatus } from '../types'

function task(
  id: string, containerNo: string, sequenceNo: number, status: AssignmentStatus,
): Assignment {
  return {
    id, containerNo, sequenceNo, status,
    manifestId: 'm', yardId: 'y', containerId: `c-${containerNo}`,
    expectedVehicleCount: 2, containerFilled: 0, chassisNo: `CH-${id}`,
  }
}

describe('pickNextAssignment', () => {
  it('hands out slot 1 before slot 2', () => {
    const next = pickNextAssignment([
      task('b', 'CULVNSA2601795', 2, 'PENDING'),
      task('a', 'CULVNSA2601795', 1, 'PENDING'),
    ])
    expect(next?.id).toBe('a')
  })

  it('moves to slot 2 once slot 1 is completed', () => {
    const next = pickNextAssignment([
      task('a', 'CULVNSA2601795', 1, 'COMPLETED'),
      task('b', 'CULVNSA2601795', 2, 'PENDING'),
    ])
    expect(next?.id).toBe('b')
  })

  it('skips an assignment parked by an exception — the authorised skip', () => {
    // The driver reported they cannot take slot 1. That assignment stays
    // visibly incomplete and the next one opens.
    const next = pickNextAssignment([
      task('a', 'CULVNSA2601795', 1, 'EXCEPTION'),
      task('b', 'CULVNSA2601795', 2, 'PENDING'),
    ])
    expect(next?.id).toBe('b')
  })

  it('does not skip ahead within a container just because a later slot is free', () => {
    const next = pickNextAssignment([
      task('a', 'CULVNSA2601795', 1, 'IN_PROGRESS'),
      task('b', 'CULVNSA2601795', 2, 'PENDING'),
    ])
    expect(next?.id).toBe('a')
  })

  it('works through containers in order', () => {
    const next = pickNextAssignment([
      task('c1', 'CULVNSA2601796', 1, 'PENDING'),
      task('a1', 'CULVNSA2601795', 1, 'COMPLETED'),
      task('a2', 'CULVNSA2601795', 2, 'PENDING'),
    ])
    expect(next?.id).toBe('a2')
  })

  it('sequence is per container, not global', () => {
    // Container 796 slot 1 is workable even though 795 slot 2 is still open,
    // only once 795 slot 1 is resolved — ordering across containers follows
    // the list, but a later container is never blocked by an earlier slot
    // number in a different container.
    const next = pickNextAssignment([
      task('a1', 'CULVNSA2601795', 1, 'EXCEPTION'),
      task('a2', 'CULVNSA2601795', 2, 'EXCEPTION'),
      task('b1', 'CULVNSA2601796', 1, 'PENDING'),
    ])
    expect(next?.id).toBe('b1')
  })

  it('returns null when there is nothing workable', () => {
    expect(pickNextAssignment([])).toBeNull()
    expect(pickNextAssignment([task('a', 'C', 1, 'COMPLETED')])).toBeNull()
    expect(pickNextAssignment([task('a', 'C', 1, 'CANCELLED')])).toBeNull()
  })
})
