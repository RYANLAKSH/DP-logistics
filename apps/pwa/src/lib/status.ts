/**
 * The status vocabulary the whole UI speaks.
 *
 * Every status carries a word, an icon and a colour. Never colour alone —
 * sunlight washes out hue, and roughly one man in twelve cannot separate red
 * from green. If a screen conveys pass/fail by colour only, it is broken.
 */

export type StatusKey =
  | 'READY'
  | 'SCANNING'
  | 'VERIFIED'
  | 'MISMATCH'
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'EXCEPTION'
  | 'PENDING_SYNC'

export type StatusTone = 'ok' | 'bad' | 'warn' | 'info' | 'idle'

export interface StatusMeta {
  label: string
  tone: StatusTone
  icon: string
  /** One line a driver can act on. */
  hint?: string
}

export const STATUS: Record<StatusKey, StatusMeta> = {
  READY:       { label: 'Ready',       tone: 'info', icon: '●', hint: 'Ready to scan' },
  SCANNING:    { label: 'Scanning',    tone: 'info', icon: '◎', hint: 'Reading the plate' },
  VERIFIED:    { label: 'Verified',    tone: 'ok',   icon: '✓', hint: 'Both values match the manifest' },
  MISMATCH:    { label: 'Mismatch',    tone: 'bad',  icon: '✕', hint: 'Do not load' },
  PENDING:     { label: 'Pending',     tone: 'idle', icon: '○', hint: 'Not started' },
  IN_PROGRESS: { label: 'In progress', tone: 'warn', icon: '◐', hint: 'A driver is on this' },
  COMPLETED:   { label: 'Completed',   tone: 'ok',   icon: '✓' },
  EXCEPTION:   { label: 'Exception',   tone: 'bad',  icon: '!', hint: 'Needs a manager' },
  PENDING_SYNC:{ label: 'Pending sync',tone: 'warn', icon: '↻',
                 hint: 'Captured on this device. Not yet confirmed by the server' },
}

const TONE_CLASSES: Record<StatusTone, string> = {
  ok:   'bg-ok-100 text-ok-500 border-ok-500',
  bad:  'bg-bad-100 text-bad-500 border-bad-500',
  warn: 'bg-warn-100 text-warn-500 border-warn-500',
  info: 'bg-info-100 text-info-500 border-info-500',
  idle: 'bg-idle-100 text-idle-500 border-idle-500',
}

export function toneClasses(tone: StatusTone): string {
  return TONE_CLASSES[tone]
}

/** Maps a domain status onto the shared vocabulary. */
export function assignmentStatusKey(s: string): StatusKey {
  switch (s) {
    case 'IN_PROGRESS': return 'IN_PROGRESS'
    case 'COMPLETED': return 'COMPLETED'
    case 'EXCEPTION': return 'EXCEPTION'
    case 'CANCELLED': return 'PENDING'
    default: return 'PENDING'
  }
}

/**
 * What the driver sees for a verification outcome, in the words they need.
 * MATCH is the only outcome that is not a block.
 */
export function outcomeStatusKey(outcome: string): StatusKey {
  return outcome === 'MATCH' ? 'VERIFIED' : 'MISMATCH'
}

export const OUTCOME_MESSAGE: Record<string, string> = {
  MATCH: 'Both values match the manifest.',
  WRONG_CONTAINER: 'This is not the container assigned to this vehicle.',
  WRONG_CHASSIS: 'This is not the vehicle assigned to this container.',
  WRONG_VEHICLE: 'This vehicle is assigned to a different container.',
  CHASSIS_NOT_ON_MANIFEST: 'This chassis number is not on today’s manifest.',
  CONTAINER_NOT_ON_MANIFEST: 'This container is not on today’s manifest.',
  ALREADY_COMPLETED: 'This vehicle has already been moved.',
  CONTAINER_FULL: 'This container already holds all the vehicles assigned to it.',
  ASSIGNMENT_NOT_ACTIVE: 'This assignment has been cancelled.',
  MANIFEST_NOT_PUBLISHED: 'The manifest for this task is not live.',
  MANIFEST_SUPERSEDED: 'The manifest has changed. Sync before continuing.',
  DRIVER_NOT_AUTHORISED: 'You are not assigned to this yard.',
  DEVICE_NOT_APPROVED: 'This device has not been approved. Ask your manager.',
  EVIDENCE_MISSING: 'Both photographs are required before a movement can complete.',
  REPLAY_CONFLICT: 'This movement was already recorded with different values.',
}
