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
} from './types'

export interface ScanSubmission {
  assignmentId: string
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
  verifyMovement(input: ScanSubmission): Promise<VerificationResult>
  /** The next assignment this driver is permitted to work, or null. */
  nextAssignment(): Promise<Assignment | null>
  raiseException(input: ExceptionSubmission): Promise<ExceptionRecord>
  listMyMovements(): Promise<MovementEvent[]>

  // manager
  getDashboard(yardId: string): Promise<DashboardCounters>
  listActivity(yardId: string): Promise<ActivityItem[]>
  listManifests(): Promise<Manifest[]>
  getManifestImport(id: string): Promise<ManifestImport | null>
  parseManifestFile(file: File, yardId: string, date: string): Promise<ManifestImport>
  publishManifestImport(importId: string): Promise<Manifest>
  listAssignments(yardId: string): Promise<Assignment[]>
  listExceptions(yardId: string): Promise<ExceptionRecord[]>
  resolveException(id: string, resolution: string, note: string): Promise<ExceptionRecord>
  listUsers(): Promise<Profile[]>
  listAuditEntries(): Promise<AuditEntry[]>
}
