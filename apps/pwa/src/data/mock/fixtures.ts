/**
 * Mock data. ISOLATED — nothing outside `src/data/mock` imports this file.
 *
 * The scenario is the one in the build plan, so the screens are exercised
 * against the numbers the business actually uses:
 *
 *   TRHU8755445   MAT752389T7R20588 (1 of 2)
 *                 MAT464844TSR09113 (2 of 2)
 */
import type {
  ActivityItem, Assignment, AuditEntry, ExceptionRecord, Manifest,
  ManifestImport, MovementEvent, Profile, Yard,
} from '../types'

export const YARDS: Yard[] = [
  { id: 'yard-nsa', code: 'NSA', name: 'Nhava Sheva' },
  { id: 'yard-mun', code: 'MUN', name: 'Mundra' },
]

export const USERS: Profile[] = [
  { id: 'u-admin', fullName: 'Asha Admin', role: 'ADMIN', orgId: 'org-1',
    yardIds: ['yard-nsa', 'yard-mun'], employeeNo: 'E-001' },
  { id: 'u-manager', fullName: 'Manoj Manager', role: 'MANAGER', orgId: 'org-1',
    yardIds: ['yard-nsa'], employeeNo: 'E-014' },
  { id: 'u-driver', fullName: 'Dev Driver', role: 'DRIVER', orgId: 'org-1',
    yardIds: ['yard-nsa'], employeeNo: 'E-107' },
  { id: 'u-driver-2', fullName: 'Dina Driver', role: 'DRIVER', orgId: 'org-1',
    yardIds: ['yard-nsa'], employeeNo: 'E-108' },
]

const today = new Date().toISOString().slice(0, 10)

export const MANIFESTS: Manifest[] = [
  { id: 'man-today', yardId: 'yard-nsa', yardName: 'Nhava Sheva', operatingDate: today,
    version: 1, status: 'PUBLISHED', referenceNo: 'REF-2601', totalContainers: 6,
    totalVehicles: 12, publishedAt: `${today}T06:40:00Z`, publishedBy: 'Manoj Manager' },
  { id: 'man-yest-2', yardId: 'yard-nsa', yardName: 'Nhava Sheva', operatingDate: '2026-08-20',
    version: 2, status: 'ARCHIVED', referenceNo: 'REF-2598', totalContainers: 5,
    totalVehicles: 10, publishedAt: '2026-08-20T11:15:00Z', publishedBy: 'Manoj Manager' },
  { id: 'man-yest-1', yardId: 'yard-nsa', yardName: 'Nhava Sheva', operatingDate: '2026-08-20',
    version: 1, status: 'ARCHIVED', referenceNo: 'REF-2598', totalContainers: 5,
    totalVehicles: 10, publishedAt: '2026-08-20T06:30:00Z', publishedBy: 'Manoj Manager' },
]

interface Spec {
  container: string
  bay: string
  vehicles: Array<{ chassis: string; reg?: string; model?: string; colour?: string }>
  done?: number
}

/**
 * Straight from the pickup list, so the fixture obeys the rule the product
 * exists to hold: each chassis appears against exactly one container, and each
 * container carries exactly two. The first entry is the acceptance scenario.
 *
 * The two models alternate the way the real list does — a T.7 ULTRA loaded
 * first, a YODHA second — because the sequence rule is what stops a driver
 * loading them the other way round.
 */
const SPECS: Spec[] = [
  { container: 'TRHU8755445', bay: 'Bay C · row 4', done: 0, vehicles: [
    { chassis: 'MAT752389T7R20588', reg: 'MH04 AB 1234', model: 'T.7 ULTRA DCR35HSD', colour: 'White' },
    { chassis: 'MAT464844TSR09113', reg: 'MH04 AB 5678', model: 'YODHA 2.2L SC 4X4', colour: 'Arctic White' },
  ]},
  { container: 'CAIU4330430', bay: 'Bay C · row 5', done: 0, vehicles: [
    { chassis: 'MAT752389T7R18439', reg: 'MH04 CD 1111', model: 'T.7 ULTRA DCR35HSD', colour: 'White' },
    { chassis: 'MAT464844TSR09257', reg: 'MH04 CD 2222', model: 'YODHA 2.2L SC 4X4', colour: 'Arctic White' },
  ]},
  { container: 'TGBU8901124', bay: 'Bay D · row 1', done: 2, vehicles: [
    { chassis: 'MAT752389T7R19760', reg: 'MH04 EF 3333', model: 'T.7 ULTRA DCR35HSD', colour: 'White' },
    { chassis: 'MAT464844TSR09235', reg: 'MH04 EF 4444', model: 'YODHA 2.2L SC 4X4', colour: 'Arctic White' },
  ]},
  { container: 'TRHU6366932', bay: 'Bay D · row 2', done: 1, vehicles: [
    { chassis: 'MAT752389T7R20607', reg: 'MH04 GH 5555', model: 'T.7 ULTRA DCR35HSD', colour: 'White' },
    { chassis: 'MAT464844TSR09065', reg: 'MH04 GH 6666', model: 'YODHA 2.2L SC 4X4', colour: 'Arctic White' },
  ]},
]

export const ASSIGNMENTS: Assignment[] = SPECS.flatMap((spec, ci) =>
  spec.vehicles.map((v, vi) => ({
    id: `a-${ci + 1}-${vi + 1}`,
    manifestId: 'man-today',
    yardId: 'yard-nsa',
    containerId: `c-${ci + 1}`,
    containerNo: spec.container,
    containerSequenceNo: ci + 1,
    bayPosition: spec.bay,
    expectedVehicleCount: spec.vehicles.length,
    containerFilled: spec.done ?? 0,
    chassisNo: v.chassis,
    sequenceNo: vi + 1,
    vehicleRegNo: v.reg,
    makeModel: v.model,
    colour: v.colour,
    status: vi < (spec.done ?? 0) ? ('COMPLETED' as const) : ('PENDING' as const),
  })),
)

export const MOVEMENTS: MovementEvent[] = ASSIGNMENTS
  .filter((a) => a.status === 'COMPLETED')
  .map((a, i) => ({
    id: `m-${i + 1}`,
    assignmentId: a.id,
    yardId: a.yardId,
    containerNo: a.containerNo,
    chassisNo: a.chassisNo,
    driverId: 'u-driver',
    driverName: 'Dev Driver',
    verifiedAt: new Date(Date.now() - (i + 1) * 21 * 60_000).toISOString(),
    status: 'COMPLETED' as const,
  }))

export const EXCEPTIONS: ExceptionRecord[] = [
  { id: 'x-1', yardId: 'yard-nsa', assignmentId: 'a-4-2', type: 'WRONG_VEHICLE',
    status: 'OPEN', severity: 1,
    expectedValue: 'TRHU6366932 / MAT464844TSR09065',
    actualValue: 'TRHU6366932 / MAT464844TSR09235',
    description: 'Blocked by server verification: WRONG_VEHICLE',
    raisedBy: 'u-driver-2', raisedByName: 'Dina Driver',
    raisedAt: new Date(Date.now() - 8 * 60_000).toISOString() },
  { id: 'x-2', yardId: 'yard-nsa', type: 'DAMAGED_CONTAINER_MARKING',
    status: 'UNDER_REVIEW', severity: 2,
    description: 'Container plate painted over on the door end.',
    raisedBy: 'u-driver', raisedByName: 'Dev Driver',
    raisedAt: new Date(Date.now() - 47 * 60_000).toISOString() },
  { id: 'x-3', yardId: 'yard-nsa', type: 'OCR_FAILURE', status: 'RESOLVED', severity: 3,
    description: 'Chassis plate unreadable after three attempts.',
    raisedBy: 'u-driver', raisedByName: 'Dev Driver',
    raisedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    resolvedAt: new Date(Date.now() - 2.5 * 3600_000).toISOString(),
    resolution: 'MANUAL_ENTRY_AUTHORISED',
    resolutionNote: 'Authorised typed entry after inspecting the plate.' },
]

export const ACTIVITY: ActivityItem[] = [
  ...MOVEMENTS.map((m) => ({
    id: `act-${m.id}`, kind: 'MOVEMENT' as const, occurredAt: m.verifiedAt,
    actorName: m.driverName, containerNo: m.containerNo, chassisNo: m.chassisNo,
  })),
  ...EXCEPTIONS.map((x) => ({
    id: `act-${x.id}`, kind: 'EXCEPTION' as const, occurredAt: x.raisedAt,
    actorName: x.raisedByName, detail: x.description, exceptionType: x.type,
  })),
].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))

export const AUDIT: AuditEntry[] = ([
  { id: 'au-1', occurredAt: `${today}T06:40:12Z`, actorName: 'Manoj Manager',
    actorRole: 'MANAGER' as const, action: 'manifest.published', entityType: 'manifest',
    entityId: 'man-today', detail: { version: 1, containers: 6, vehicles: 12 } },
  ...MOVEMENTS.map((m, i) => ({
    id: `au-m-${i}`, occurredAt: m.verifiedAt, actorName: m.driverName,
    actorRole: 'DRIVER' as const, action: 'movement.verified',
    entityType: 'movement_event', entityId: m.id,
    detail: { container_no: m.containerNo, chassis_no: m.chassisNo },
  })),
  ...EXCEPTIONS.map((x, i) => ({
    id: `au-x-${i}`, occurredAt: x.raisedAt, actorName: x.raisedByName,
    actorRole: 'DRIVER' as const, action: 'movement.blocked',
    entityType: 'exception', entityId: x.id, detail: { type: x.type },
  })),
] satisfies AuditEntry[]).sort((a, b) => b.occurredAt.localeCompare(a.occurredAt))

/** A parsed upload that deliberately contains the error classes phase 5 detects. */
export const SAMPLE_IMPORT: ManifestImport = {
  id: 'imp-1',
  yardId: 'yard-nsa',
  operatingDate: today,
  fileName: 'manifest-sample.csv',
  rowCount: 6,
  validCount: 4,
  rejectedCount: 2,
  rows: [
    { rowNo: 1, containerNo: 'TRHU8755445', chassisNo: 'MAT752389T7R20588',
      sequenceNo: 1, errors: [], warnings: [] },
    { rowNo: 2, containerNo: 'TRHU8755445', chassisNo: 'MAT464844TSR09113',
      sequenceNo: 2, errors: [], warnings: [] },
    { rowNo: 3, containerNo: 'CAIU4330430', chassisNo: 'MAT752389T7R18439',
      sequenceNo: 1, errors: [], warnings: [] },
    { rowNo: 4, containerNo: 'CAIU4330430', chassisNo: 'MAT464844TSR09257',
      sequenceNo: 2, errors: [], warnings: [] },
    { rowNo: 5, containerNo: '', chassisNo: 'MAT999888Z9Y00033', sequenceNo: 1,
      errors: ['Container number is missing'], warnings: [] },
    { rowNo: 6, containerNo: 'TGBU8901124', chassisNo: 'MAT752389T7R20588',
      sequenceNo: 1,
      errors: ['Chassis MAT752389T7R20588 is already assigned to TRHU8755445'],
      warnings: [] },
  ],
}
