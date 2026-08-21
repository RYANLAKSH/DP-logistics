import type { Assignment } from './types'

/**
 * Which task the driver is allowed to work next.
 *
 * The driver does not choose. Work is handed out one at a time, in loading
 * order: containers in manifest sequence, and slots within a container in
 * order — where a vehicle sits inside a container is not arbitrary.
 *
 * An assignment parked by an exception is skipped, which is exactly the
 * manager-authorised skip: the driver reports why they cannot take a vehicle,
 * that assignment stays visibly incomplete, and the next one opens.
 *
 * This is a convenience so the UI hands out the right task. It is not the
 * control — verify_movement independently returns OUT_OF_SEQUENCE, so a client
 * that ignored this ordering would still be refused.
 */
export function pickNextAssignment(assignments: Assignment[]): Assignment | null {
  const workable = assignments
    .filter((a) => a.status === 'PENDING' || a.status === 'IN_PROGRESS')
    .sort(
      (a, b) =>
        a.containerNo.localeCompare(b.containerNo) || a.sequenceNo - b.sequenceNo,
    )

  for (const candidate of workable) {
    const earlierStillOpen = assignments.some(
      (other) =>
        other.containerId === candidate.containerId &&
        other.sequenceNo < candidate.sequenceNo &&
        (other.status === 'PENDING' || other.status === 'IN_PROGRESS'),
    )
    if (!earlierStillOpen) return candidate
  }
  return null
}
