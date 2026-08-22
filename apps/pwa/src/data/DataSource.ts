/**
 * The seam between the UI and its backend.
 *
 * Phase 3 ships a mock implementation so the interface can be exercised before
 * Supabase exists. Phase 4 onward adds a Supabase implementation and swaps the
 * provider — no screen changes, because no screen imports mock data directly.
 *
 * Two rules keep that seam honest:
 *   1. Nothing outside `src/data/mock` may import from `src/data/mock`.
 *   2. `verifyMovement` returns a server decision. The mock imitates the
 *      server's rules; it never becomes the authority. When the real one
 *      arrives, the UI cannot tell the difference — which is the point.
 */
import type {
  ActivityItem, Assignment, AuditEntry, DashboardCounters, ExceptionRecord,
  Manifest, ManifestImport, MovementEvent, Profile, VerificationResult, Yard,
  YardBoard, MovementEvidence, EvidenceAttempt,
} from './types'
import type { ConnectionState } from '@/lib/realtime'

export interface ScanSubmission {
  assignmentId: string
  /** Attempt ids for the two captures. The server requires both to exist. */
  containerAttemptId?: string
  chassisAttemptId?: string
  scannedContainerNo: string
  scannedChassisNo: string
  /** Client-generated. The idempotency key for the whole movement. */
  movementId: string
  /**
   * false runs the identical server-side decision WITHOUT recording the
   * movement, so the driver sees VERIFIED before asserting the vehicle has
   * physically been moved. A block is recorded either way.
   */
  commit?: boolean
  /** Event-based location, when the driver has granted it. Never watched. */
  gps?: { lat: number; lng: number; accuracy: number } | null
}

export interface ScanEvidence {
  /** Client-generated. The idempotency key for this attempt. */
  attemptId: string
  assignmentId: string
  kind: 'CONTAINER' | 'CHASSIS' | 'VEHICLE_REG'
  /** The value a human confirmed. Never the raw OCR text. */
  scannedValue: string
  /** The full frame, at full resolution. The crop is a UI aid, not evidence. */
  image: Blob
  /** Exactly what the engine produced, kept verbatim. */
  ocrTextRaw?: string
  ocrConfidence?: number
  ocrEngine?: string
  source: 'OCR_AUTO' | 'OCR_CONFIRMED' | 'MANUAL_ENTRY' | 'MANUAL_AUTHORISED'
}

export interface ScanRecord {
  attemptId: string
  /** The server's grading of this attempt. Advisory: the movement decides. */
  result: string
}

export interface ExceptionSubmission {
  assignmentId?: string
  type: ExceptionRecord['type']
  description: string
}

export interface DataSource {
  readonly kind: 'mock' | 'supabase'

  // identity
  signIn(email: string, password: string): Promise<Profile>
  signOut(): Promise<void>
  currentProfile(): Promise<Profile | null>

  // driver
  listYards(): Promise<Yard[]>
  listMyAssignments(): Promise<Assignment[]>
  getAssignment(id: string): Promise<Assignment | null>
  /** Uploads the evidence image and records the attempt, pass or fail. */
  recordScan(input: ScanEvidence): Promise<ScanRecord>
  verifyMovement(input: ScanSubmission): Promise<VerificationResult>
  /** The next assignment this driver is permitted to work, or null. */
  nextAssignment(): Promise<Assignment | null>
  raiseException(input: ExceptionSubmission): Promise<ExceptionRecord>
  listMyMovements(): Promise<MovementEvent[]>

  // manager
  getDashboard(yardId: string): Promise<DashboardCounters>
  listActivity(yardId: string): Promise<ActivityItem[]>
  /** Everything the board shows, in one round trip. */
  getBoard(yardId: string, date?: string): Promise<YardBoard>
  /**
   * Subscribe to yard activity. Returns an unsubscribe function.
   *
   * The handler is a signal to refetch, never data to render — see
   * src/lib/realtime.ts. A backend with no realtime returns a no-op and
   * reports 'offline', which the UI must show honestly rather than pretending
   * to be live.
   */
  subscribeToYard(
    yardId: string,
    onChange: () => void,
    onState: (state: ConnectionState) => void,
  ): () => void
  listManifests(): Promise<Manifest[]>
  getManifestImport(id: string): Promise<ManifestImport | null>
  parseManifestFile(file: File, yardId: string, date: string): Promise<ManifestImport>
  publishManifestImport(importId: string): Promise<Manifest>
  listAssignments(yardId: string): Promise<Assignment[]>
  listExceptions(yardId: string): Promise<ExceptionRecord[]>
  acknowledgeException(id: string): Promise<ExceptionRecord>
  resolveException(id: string, resolution: string, note: string): Promise<ExceptionRecord>
  cancelException(id: string, note: string): Promise<ExceptionRecord>
  /** Driver asks; only a different person can approve. */
  requestOverride(exceptionId: string, note: string): Promise<ExceptionRecord>
  approveOverride(
    exceptionId: string, reason: string, note: string,
  ): Promise<{ movementId: string }>
  /** The full evidence record for one movement. Viewing it is audited. */
  getMovementEvidence(movementId: string): Promise<MovementEvidence>
  getExceptionEvidence(exceptionId: string): Promise<{ attempts: EvidenceAttempt[] }>
  /**
   * A short-lived URL for one stored image. Returns null when the backend has
   * no object store — the viewer must then say so rather than show a broken
   * image.
   */
  getEvidenceUrl(path: string): Promise<string | null>

  listUsers(): Promise<Profile[]>
  listAuditEntries(): Promise<AuditEntry[]>
}
