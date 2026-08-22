/**
 * Domain types.
 *
 * These mirror the database in `supabase/migrations` and are the contract the
 * mock data source and the (later) Supabase data source both satisfy. Keeping
 * them here — rather than generating them from the database — means the UI
 * compiles against a shape it chose, and a schema change that breaks the UI
 * shows up as a type error in the adapter rather than at runtime in a yard.
 */

export type UserRole = 'ADMIN' | 'MANAGER' | 'DRIVER'

export interface Profile {
  id: string
  fullName: string
  role: UserRole
  employeeNo?: string
  yardIds: string[]
  orgId: string
}

export interface Yard {
  id: string
  code: string
  name: string
}

export type ManifestStatus =
  | 'DRAFT'
  | 'VALIDATION_FAILED'
  | 'READY'
  | 'PUBLISHED'
  | 'ARCHIVED'

export interface Manifest {
  id: string
  yardId: string
  yardName: string
  operatingDate: string
  version: number
  status: ManifestStatus
  referenceNo?: string
  totalContainers: number
  totalVehicles: number
  publishedAt?: string
  publishedBy?: string
}

export type AssignmentStatus =
  | 'PENDING'
  | 'IN_PROGRESS'
  | 'COMPLETED'
  | 'EXCEPTION'
  | 'CANCELLED'

/**
 * One row of the manifest: this chassis goes in this container, in this slot.
 * The single record the whole product exists to enforce.
 */
export interface Assignment {
  id: string
  manifestId: string
  yardId: string
  containerId: string
  containerNo: string
  bayPosition?: string
  expectedVehicleCount: number
  containerFilled: number
  chassisNo: string
  sequenceNo: number
  vehicleRegNo?: string
  makeModel?: string
  colour?: string
  status: AssignmentStatus
  claimedBy?: string
}

export type VerificationOutcome =
  | 'MATCH'
  | 'WRONG_CONTAINER'
  | 'WRONG_CHASSIS'
  | 'WRONG_VEHICLE'
  | 'CHASSIS_NOT_ON_MANIFEST'
  | 'CONTAINER_NOT_ON_MANIFEST'
  | 'ALREADY_COMPLETED'
  | 'CONTAINER_FULL'
  | 'ASSIGNMENT_NOT_ACTIVE'
  | 'MANIFEST_NOT_PUBLISHED'
  | 'MANIFEST_SUPERSEDED'
  | 'DRIVER_NOT_AUTHORISED'
  | 'DEVICE_NOT_APPROVED'
  | 'EVIDENCE_MISSING'
  | 'REPLAY_CONFLICT'
  | 'OUT_OF_SEQUENCE'

export interface VerificationResult {
  outcome: VerificationOutcome
  status: 'COMPLETED' | 'BLOCKED' | 'PENDING_SYNC' | 'READY_TO_CONFIRM'
  movementId?: string
  exceptionId?: string
  expectedContainerNo: string
  expectedChassisNo: string
  scannedContainerNo?: string
  scannedChassisNo?: string
  containerFilled?: number
  containerCapacity?: number
  /** When the scanned vehicle belongs elsewhere, where it actually belongs. */
  scannedVehicleBelongsToContainer?: string
  bayPosition?: string
}

export interface MovementEvent {
  id: string
  assignmentId: string
  yardId: string
  containerNo: string
  chassisNo: string
  driverId: string
  driverName: string
  verifiedAt: string
  status: 'COMPLETED' | 'OVERRIDDEN' | 'REVERSED'
}

export type ExceptionType =
  | 'CONTAINER_MISMATCH'
  | 'CHASSIS_MISMATCH'
  | 'OCR_FAILURE'
  | 'WRONG_VEHICLE'
  | 'WRONG_CONTAINER'
  | 'VEHICLE_UNAVAILABLE'
  | 'DAMAGED_CHASSIS_MARKING'
  | 'DAMAGED_CONTAINER_MARKING'
  | 'MISSING_VEHICLE'
  | 'CONTAINER_FULL'
  | 'ALREADY_COMPLETED'
  | 'SYNC_ISSUE'
  | 'MANIFEST_ERROR'
  | 'MANIFEST_CONFLICT'
  | 'DEVICE_UNAPPROVED'
  | 'OTHER'

export type ExceptionStatus = 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'CANCELLED'

export interface ExceptionRecord {
  id: string
  yardId: string
  assignmentId?: string
  type: ExceptionType
  status: ExceptionStatus
  severity: 1 | 2 | 3
  expectedValue?: string
  actualValue?: string
  description?: string
  raisedBy: string
  raisedByName: string
  raisedAt: string
  resolvedAt?: string
  resolution?: string
  resolutionNote?: string
  overrideRequested?: boolean
  acknowledgedAt?: string
}

export interface DashboardCounters {
  vehiclesScheduled: number
  vehiclesCompleted: number
  vehiclesPending: number
  vehiclesInProgress: number
  vehiclesException: number
  containersScheduled: number
  containersCompleted: number
  openExceptions: number
  activeDrivers: number
}

export interface ActivityItem {
  id: string
  kind: 'MOVEMENT' | 'EXCEPTION'
  occurredAt: string
  actorName: string
  containerNo?: string
  chassisNo?: string
  detail?: string
  exceptionType?: ExceptionType
}

export interface AuditEntry {
  id: string
  occurredAt: string
  actorName: string
  actorRole: UserRole
  action: string
  entityType: string
  entityId?: string
  detail?: Record<string, unknown>
}

/** A row as parsed from an uploaded manifest file, before it is published. */
export interface ParsedManifestRow {
  rowNo: number
  containerNo: string
  chassisNo: string
  sequenceNo: number | null
  /** Set when the container came from the row above, not from this row. */
  containerInherited?: boolean
  invoiceNo?: string
  sealNo?: string
  errors: string[]
  warnings: string[]
}

export interface ManifestImport {
  id: string
  yardId: string
  operatingDate: string
  fileName: string
  rowCount: number
  validCount: number
  rejectedCount: number
  rows: ParsedManifestRow[]
}

export interface BoardContainer {
  container_no: string
  bay_position: string | null
  capacity: number
  filled: number
}

/** Everything the manager's board renders, from one call. */
export interface YardBoard {
  yardId: string
  operatingDate: string
  counters: {
    vehiclesScheduled: number
    vehiclesCompleted: number
    vehiclesInProgress: number
    vehiclesException: number
    vehiclesPending: number
    activeDrivers: number
  }
  containers: BoardContainer[]
  openExceptions: number
  activity: ActivityItem[]
  exceptionFeed: ActivityItem[]
}

export interface EvidenceAttempt {
  id: string
  kind: 'CONTAINER' | 'CHASSIS' | 'FINAL' | 'VEHICLE_REG'
  result: string
  outcome?: string
  valueSource?: string
  ocrTextRaw?: string
  ocrConfidence?: number
  ocrEngine?: string
  scannedContainerNo?: string
  scannedChassisNo?: string
  imagePath?: string
  imageSha256?: string
  gps?: { lat: number; lng: number; accuracyM: number } | null
  gpsDenied?: boolean
  attemptedAtDevice?: string
  receivedAt?: string
  clockSkewSeconds?: number
}

export interface MovementEvidence {
  movement: {
    id: string
    status: string
    yardId: string
    expectedContainerNo: string
    expectedChassisNo: string
    scannedContainerNo: string
    scannedChassisNo: string
    verifiedAt: string
    completedAtDevice?: string
    clockSkewSeconds?: number
    gps?: { lat: number; lng: number; accuracyM: number } | null
    driverName?: string
    appVersion?: string
  }
  attempts: EvidenceAttempt[]
}

export interface AuditFilter {
  action?: string
  from?: string
  to?: string
  search?: string
  limit?: number
}

export interface ManifestCorrection {
  id: string
  fieldName: string
  beforeValue?: string
  afterValue?: string
  reason: string
  containerNo?: string
  chassisNo?: string
  correctedAt: string
  correctedByName?: string
  affectedMovementCount: number
}

export interface PartiallyLoadedContainer {
  containerNo: string
  bayPosition?: string | null
  expected: number
  loaded: number
  missing: string[]
}

export interface ShiftReport {
  yardId: string
  operatingDate: string
  partiallyLoaded: PartiallyLoadedContainer[]
  notStarted: number
  openExceptions: number
  overrides?: { count: number; ratePercent: number } | null
  clockAnomalies: number
  manualEntries: number
  completed: number
}
