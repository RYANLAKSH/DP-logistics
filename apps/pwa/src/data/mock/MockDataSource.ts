/**
 * In-memory implementation of DataSource, for phase 3.
 *
 * It imitates the server's verification rules so the screens can be built and
 * exercised — but it is explicitly NOT an authority, and the code says so. When
 * the Supabase implementation replaces it, `verifyMovement` becomes a call to
 * the SECURITY DEFINER function and every screen is unchanged.
 */
import type {
  DataSource, ExceptionSubmission, ScanSubmission,
} from '../DataSource'
import type {
  ActivityItem, Assignment, AuditEntry, DashboardCounters, ExceptionRecord,
  Manifest, ManifestImport, MovementEvent, Profile, VerificationOutcome,
  VerificationResult, Yard,
} from '../types'
import {
  ACTIVITY, ASSIGNMENTS, AUDIT, EXCEPTIONS, MANIFESTS, MOVEMENTS,
  SAMPLE_IMPORT, USERS, YARDS,
} from './fixtures'

const LATENCY_MS = 180

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS))
}

/**
 * Reads return snapshots, never live references into the store.
 *
 * A network-backed data source physically cannot hand back a mutable pointer
 * into its own state, and code written against one that does will break the
 * moment it is swapped. Copying here keeps the mock honest about the contract.
 */
function snapshot<T>(value: T): T {
  return structuredClone(value)
}

/** Safe normalisation only: case and separators. Mirrors app.normalize_code(). */
function normalize(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '')
}

const SESSION_KEY = 'dp.mock.session'

export class MockDataSource implements DataSource {
  readonly kind = 'mock' as const

  private assignments: Assignment[] = ASSIGNMENTS.map((a) => ({ ...a }))
  private movements: MovementEvent[] = MOVEMENTS.map((m) => ({ ...m }))
  private exceptions: ExceptionRecord[] = EXCEPTIONS.map((x) => ({ ...x }))
  private activity: ActivityItem[] = ACTIVITY.map((a) => ({ ...a }))
  private manifests: Manifest[] = MANIFESTS.map((m) => ({ ...m }))
  private profile: Profile | null = null

  constructor() {
    const stored = globalThis.localStorage?.getItem(SESSION_KEY)
    if (stored) this.profile = USERS.find((u) => u.id === stored) ?? null
  }

  // ------------------------------------------------------------- identity
  async signIn(email: string, _password: string): Promise<Profile> {
    // Phase 3 has no authentication. This selects a persona so the shell can be
    // reviewed; it grants nothing, because nothing is protected yet. Phase 4
    // replaces it with Supabase Auth and real route guards.
    const handle = email.split('@')[0]?.toLowerCase() ?? ''
    const user =
      USERS.find((u) => u.fullName.toLowerCase().startsWith(handle)) ??
      USERS.find((u) => u.role.toLowerCase() === handle) ??
      USERS.find((u) => u.role === 'DRIVER')!
    this.profile = user
    globalThis.localStorage?.setItem(SESSION_KEY, user.id)
    return delay(user)
  }

  async signOut(): Promise<void> {
    this.profile = null
    globalThis.localStorage?.removeItem(SESSION_KEY)
    return delay(undefined)
  }

  async currentProfile(): Promise<Profile | null> {
    return delay(this.profile)
  }

  // --------------------------------------------------------------- driver
  async listYards(): Promise<Yard[]> {
    return delay(snapshot(YARDS))
  }

  async listMyAssignments(): Promise<Assignment[]> {
    const sorted = [...this.assignments].sort(
      (a, b) =>
        a.containerNo.localeCompare(b.containerNo) || a.sequenceNo - b.sequenceNo,
    )
    return delay(snapshot(sorted))
  }

  async getAssignment(id: string): Promise<Assignment | null> {
    return delay(snapshot(this.assignments.find((a) => a.id === id) ?? null))
  }

  /**
   * Imitates the server's decision, in the server's evaluation order.
   *
   * The real implementation is `verify_movement()` in
   * supabase/migrations/…000900. This exists so the result screens can be built
   * before the backend is wired, and it is deliberately written to be
   * replaceable rather than extended.
   */
  async verifyMovement(input: ScanSubmission): Promise<VerificationResult> {
    const a = this.assignments.find((x) => x.id === input.assignmentId)
    if (!a) throw new Error('assignment not found')

    const scannedContainer = normalize(input.scannedContainerNo)
    const scannedChassis = normalize(input.scannedChassisNo)
    const expectedContainer = normalize(a.containerNo)
    const expectedChassis = normalize(a.chassisNo)

    const base = {
      expectedContainerNo: expectedContainer,
      expectedChassisNo: expectedChassis,
      scannedContainerNo: scannedContainer,
      scannedChassisNo: scannedChassis,
    }

    const blocked = (
      outcome: VerificationOutcome,
      extra: Partial<VerificationResult> = {},
    ): VerificationResult => {
      const record: ExceptionRecord = {
        id: `x-${Math.random().toString(36).slice(2, 8)}`,
        yardId: a.yardId,
        assignmentId: a.id,
        type: outcome === 'WRONG_VEHICLE' ? 'WRONG_VEHICLE' : 'CHASSIS_MISMATCH',
        status: 'OPEN',
        severity: 1,
        expectedValue: `${expectedContainer} / ${expectedChassis}`,
        actualValue: `${scannedContainer} / ${scannedChassis}`,
        description: `Blocked by verification: ${outcome}`,
        raisedBy: this.profile?.id ?? 'u-driver',
        raisedByName: this.profile?.fullName ?? 'Dev Driver',
        raisedAt: new Date().toISOString(),
      }
      this.exceptions = [record, ...this.exceptions]
      this.activity = [
        { id: `act-${record.id}`, kind: 'EXCEPTION', occurredAt: record.raisedAt,
          actorName: record.raisedByName, detail: record.description,
          exceptionType: record.type },
        ...this.activity,
      ]
      a.status = 'EXCEPTION'
      return { outcome, status: 'BLOCKED', exceptionId: record.id, ...base, ...extra }
    }

    if (a.status === 'COMPLETED') return delay(blocked('ALREADY_COMPLETED'))

    if (scannedContainer !== expectedContainer) {
      const onManifest = this.assignments.some(
        (x) => normalize(x.containerNo) === scannedContainer,
      )
      return delay(
        blocked(onManifest ? 'WRONG_CONTAINER' : 'CONTAINER_NOT_ON_MANIFEST'),
      )
    }

    if (scannedChassis !== expectedChassis) {
      const other = this.assignments.find(
        (x) => normalize(x.chassisNo) === scannedChassis,
      )
      return delay(
        other
          ? blocked('WRONG_VEHICLE', {
              scannedVehicleBelongsToContainer: other.containerNo,
              bayPosition: other.bayPosition,
            })
          : blocked('CHASSIS_NOT_ON_MANIFEST'),
      )
    }

    if (a.containerFilled >= a.expectedVehicleCount) {
      return delay(
        blocked('CONTAINER_FULL', {
          containerFilled: a.containerFilled,
          containerCapacity: a.expectedVehicleCount,
        }),
      )
    }

    a.status = 'COMPLETED'
    const filled = a.containerFilled + 1
    for (const sibling of this.assignments) {
      if (sibling.containerId === a.containerId) sibling.containerFilled = filled
    }

    const movement: MovementEvent = {
      id: input.movementId,
      assignmentId: a.id,
      yardId: a.yardId,
      containerNo: a.containerNo,
      chassisNo: a.chassisNo,
      driverId: this.profile?.id ?? 'u-driver',
      driverName: this.profile?.fullName ?? 'Dev Driver',
      verifiedAt: new Date().toISOString(),
      status: 'COMPLETED',
    }
    this.movements = [movement, ...this.movements]
    this.activity = [
      { id: `act-${movement.id}`, kind: 'MOVEMENT', occurredAt: movement.verifiedAt,
        actorName: movement.driverName, containerNo: movement.containerNo,
        chassisNo: movement.chassisNo },
      ...this.activity,
    ]

    return delay({
      outcome: 'MATCH' as const,
      status: 'COMPLETED' as const,
      movementId: movement.id,
      containerFilled: filled,
      containerCapacity: a.expectedVehicleCount,
      ...base,
    })
  }

  async raiseException(input: ExceptionSubmission): Promise<ExceptionRecord> {
    const record: ExceptionRecord = {
      id: `x-${Math.random().toString(36).slice(2, 8)}`,
      yardId: 'yard-nsa',
      assignmentId: input.assignmentId,
      type: input.type,
      status: 'OPEN',
      severity: 2,
      description: input.description,
      raisedBy: this.profile?.id ?? 'u-driver',
      raisedByName: this.profile?.fullName ?? 'Dev Driver',
      raisedAt: new Date().toISOString(),
    }
    this.exceptions = [record, ...this.exceptions]
    if (input.assignmentId) {
      const a = this.assignments.find((x) => x.id === input.assignmentId)
      if (a) a.status = 'EXCEPTION'
    }
    return delay(record)
  }

  async listMyMovements(): Promise<MovementEvent[]> {
    return delay(
      snapshot([...this.movements].sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))),
    )
  }

  // -------------------------------------------------------------- manager
  async getDashboard(yardId: string): Promise<DashboardCounters> {
    const mine = this.assignments.filter((a) => a.yardId === yardId)
    const containers = new Map<string, Assignment[]>()
    for (const a of mine) {
      const list = containers.get(a.containerId) ?? []
      list.push(a)
      containers.set(a.containerId, list)
    }
    let containersCompleted = 0
    for (const list of containers.values()) {
      const first = list[0]
      if (first && list.filter((a) => a.status === 'COMPLETED').length >= first.expectedVehicleCount) {
        containersCompleted++
      }
    }
    return delay({
      vehiclesScheduled: mine.length,
      vehiclesCompleted: mine.filter((a) => a.status === 'COMPLETED').length,
      vehiclesPending: mine.filter((a) => a.status === 'PENDING').length,
      vehiclesInProgress: mine.filter((a) => a.status === 'IN_PROGRESS').length,
      vehiclesException: mine.filter((a) => a.status === 'EXCEPTION').length,
      containersScheduled: containers.size,
      containersCompleted,
      openExceptions: this.exceptions.filter(
        (x) => x.yardId === yardId && (x.status === 'OPEN' || x.status === 'UNDER_REVIEW'),
      ).length,
      activeDrivers: new Set(
        mine.filter((a) => a.status === 'IN_PROGRESS').map((a) => a.claimedBy),
      ).size,
    })
  }

  async listActivity(yardId: string): Promise<ActivityItem[]> {
    void yardId
    return delay(snapshot(this.activity.slice(0, 50)))
  }

  async listManifests(): Promise<Manifest[]> {
    return delay(snapshot(this.manifests))
  }

  async getManifestImport(id: string): Promise<ManifestImport | null> {
    return delay(id === SAMPLE_IMPORT.id ? snapshot(SAMPLE_IMPORT) : null)
  }

  async parseManifestFile(
    file: File, yardId: string, date: string,
  ): Promise<ManifestImport> {
    return delay({ ...SAMPLE_IMPORT, fileName: file.name, yardId, operatingDate: date })
  }

  async publishManifestImport(importId: string): Promise<Manifest> {
    void importId
    const published: Manifest = {
      id: `man-${Math.random().toString(36).slice(2, 8)}`,
      yardId: 'yard-nsa',
      yardName: 'Nhava Sheva',
      operatingDate: new Date().toISOString().slice(0, 10),
      version: this.manifests.length + 1,
      status: 'PUBLISHED',
      totalContainers: 2,
      totalVehicles: 4,
      publishedAt: new Date().toISOString(),
      publishedBy: this.profile?.fullName ?? 'Manoj Manager',
    }
    this.manifests = [published, ...this.manifests.map((m) =>
      m.status === 'PUBLISHED' ? { ...m, status: 'ARCHIVED' as const } : m)]
    return delay(published)
  }

  async listAssignments(yardId: string): Promise<Assignment[]> {
    return delay(snapshot(this.assignments.filter((a) => a.yardId === yardId)))
  }

  async listExceptions(yardId: string): Promise<ExceptionRecord[]> {
    return delay(
      snapshot(
        this.exceptions
          .filter((x) => x.yardId === yardId)
          .sort((a, b) => b.raisedAt.localeCompare(a.raisedAt)),
      ),
    )
  }

  async resolveException(
    id: string, resolution: string, note: string,
  ): Promise<ExceptionRecord> {
    const found = this.exceptions.find((x) => x.id === id)
    if (!found) throw new Error('exception not found')
    found.status = 'RESOLVED'
    found.resolution = resolution
    found.resolutionNote = note
    found.resolvedAt = new Date().toISOString()
    return delay({ ...found })
  }

  async listUsers(): Promise<Profile[]> {
    return delay(snapshot(USERS))
  }

  async listAuditEntries(): Promise<AuditEntry[]> {
    return delay(snapshot(AUDIT))
  }
}
