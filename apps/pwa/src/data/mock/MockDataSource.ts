/**
 * In-memory implementation of DataSource, for phase 3.
 *
 * It imitates the server's verification rules so the screens can be built and
 * exercised — but it is explicitly NOT an authority, and the code says so. When
 * the Supabase implementation replaces it, `verifyMovement` becomes a call to
 * the SECURITY DEFINER function and every screen is unchanged.
 */
import type {
  DataSource, ExceptionSubmission, ScanEvidence, ScanRecord, ScanSubmission,
} from '../DataSource'
import { pickNextAssignment } from '../nextAssignment'
import type {
  ActivityItem, Assignment, AuditEntry, DashboardCounters, ExceptionRecord,
  Manifest, ManifestImport, MovementEvent, Profile, VerificationOutcome,
  VerificationResult, Yard, YardBoard, MovementEvidence, EvidenceAttempt,
} from '../types'
import type { ConnectionState } from '@/lib/realtime'
import {
  detectColumns, findHeaderRow, isUsableMapping, parseDelimited, validateRows,
} from '@shared/manifest/index.ts'
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
  private lastImport: ManifestImport | null = null

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

  async nextAssignment(): Promise<Assignment | null> {
    return delay(snapshot(pickNextAssignment(this.assignments)))
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
  async recordScan(input: ScanEvidence): Promise<ScanRecord> {
    const a = this.assignments.find((x) => x.id === input.assignmentId)
    const expected = input.kind === 'CONTAINER' ? a?.containerNo : a?.chassisNo
    return delay({
      attemptId: input.attemptId,
      result: normalize(input.scannedValue) === normalize(expected ?? '')
        ? 'PASS' : 'FAIL_MISMATCH',
    })
  }

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

    const earlierStillOpen = this.assignments.some(
      (other) =>
        other.containerId === a.containerId &&
        other.sequenceNo < a.sequenceNo &&
        (other.status === 'PENDING' || other.status === 'IN_PROGRESS'),
    )
    if (earlierStillOpen) return delay(blocked('OUT_OF_SEQUENCE'))

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

    // A check runs the identical decision and records nothing.
    if (input.commit === false) {
      return delay({
        outcome: 'MATCH' as const,
        status: 'READY_TO_CONFIRM' as const,
        containerFilled: a.containerFilled,
        containerCapacity: a.expectedVehicleCount,
        ...base,
      })
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

  async getBoard(yardId: string, date?: string): Promise<YardBoard> {
    const counters = await this.getDashboard(yardId)
    const containers = new Map<string, { capacity: number; filled: number; bay: string | null }>()
    for (const a of this.assignments.filter((x) => x.yardId === yardId)) {
      const entry = containers.get(a.containerNo)
        ?? { capacity: a.expectedVehicleCount, filled: 0, bay: a.bayPosition ?? null }
      if (a.status === 'COMPLETED') entry.filled += 1
      containers.set(a.containerNo, entry)
    }
    return delay(snapshot({
      yardId,
      operatingDate: date ?? new Date().toISOString().slice(0, 10),
      counters: {
        vehiclesScheduled: counters.vehiclesScheduled,
        vehiclesCompleted: counters.vehiclesCompleted,
        vehiclesInProgress: counters.vehiclesInProgress,
        vehiclesException: counters.vehiclesException,
        vehiclesPending: counters.vehiclesPending,
        activeDrivers: counters.activeDrivers,
      },
      containers: [...containers.entries()]
        .map(([container_no, v]) => ({
          container_no, bay_position: v.bay, capacity: v.capacity, filled: v.filled,
        }))
        .sort((a, b) => a.container_no.localeCompare(b.container_no)),
      openExceptions: counters.openExceptions,
      activity: this.activity.filter((a) => a.kind === 'MOVEMENT').slice(0, 30),
      exceptionFeed: this.activity.filter((a) => a.kind === 'EXCEPTION').slice(0, 30),
    }))
  }

  /**
   * The mock has no realtime, and says so rather than pretending.
   *
   * A dashboard that claims to be live and silently is not is worse than one
   * that shows a disconnected state: a manager may believe a truck has been
   * stopped when it has not.
   */
  subscribeToYard(
    _yardId: string,
    _onChange: () => void,
    onState: (state: ConnectionState) => void,
  ): () => void {
    onState('offline')
    return () => {}
  }

  async listActivity(yardId: string): Promise<ActivityItem[]> {
    void yardId
    return delay(snapshot(this.activity.slice(0, 50)))
  }

  async listManifests(): Promise<Manifest[]> {
    return delay(snapshot(this.manifests))
  }

  async getManifestImport(id: string): Promise<ManifestImport | null> {
    if (this.lastImport?.id === id) return delay(snapshot(this.lastImport))
    return delay(id === SAMPLE_IMPORT.id ? snapshot(SAMPLE_IMPORT) : null)
  }

  /**
   * Runs the REAL parser and the REAL validation rules, in the browser.
   *
   * In production this happens in the parse-manifest Edge Function, because
   * `parsed_rows` is what becomes live assignments and no client may write it.
   * Here it runs locally so the preview screen is exercised against the actual
   * rules rather than a second implementation that would drift from them.
   */
  async parseManifestFile(
    file: File, yardId: string, date: string,
  ): Promise<ManifestImport> {
    if (!file.name.toLowerCase().endsWith('.csv')) {
      // Spreadsheet decoding lives in the Edge Function. Falling back to the
      // fixture keeps the demo usable without pretending to parse XLSX here.
      return delay({ ...SAMPLE_IMPORT, fileName: file.name, yardId, operatingDate: date })
    }

    const text = await file.text()
    const grid = parseDelimited(text)
    const headerRow = findHeaderRow(grid)
    const map = headerRow >= 0 ? detectColumns(grid[headerRow]!) : {}

    if (!isUsableMapping(map)) {
      throw new Error(
        'Could not find a container column and a chassis column in that file.',
      )
    }

    const result = validateRows(grid.slice(headerRow + 1), map, { operatingDate: date })
    this.lastImport = {
      id: SAMPLE_IMPORT.id,
      yardId,
      operatingDate: date,
      fileName: file.name,
      rowCount: result.rowCount,
      validCount: result.validCount,
      rejectedCount: result.rejectedCount,
      rows: result.rows.map((r) => ({
        rowNo: r.row_no,
        containerNo: r.container_no,
        chassisNo: r.chassis_no,
        sequenceNo: r.sequence_no,
        errors: r.errors,
        warnings: r.warnings,
      })),
    }
    return delay(snapshot(this.lastImport))
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

  private mustFindException(id: string): ExceptionRecord {
    const found = this.exceptions.find((x) => x.id === id)
    if (!found) throw new Error('exception not found')
    return found
  }

  async acknowledgeException(id: string): Promise<ExceptionRecord> {
    const found = this.mustFindException(id)
    if (found.status !== 'OPEN') throw new Error(`this exception is ${found.status}`)
    found.status = 'UNDER_REVIEW'
    found.acknowledgedAt = new Date().toISOString()
    return delay(snapshot(found))
  }

  async resolveException(
    id: string, resolution: string, note: string,
  ): Promise<ExceptionRecord> {
    const found = this.mustFindException(id)
    if (found.status === 'RESOLVED' || found.status === 'CANCELLED') {
      throw new Error(`this exception is already ${found.status}`)
    }
    if (resolution === 'OVERRIDE_APPROVED') {
      throw new Error('use the override approval to authorise a movement')
    }
    if (note.trim().length < 5) throw new Error('a resolution needs a note')

    found.status = 'RESOLVED'
    found.resolution = resolution
    found.resolutionNote = note
    found.resolvedAt = new Date().toISOString()

    // Releasing the task is an explicit consequence of certain resolutions.
    if (found.assignmentId && ['CORRECTED_AND_RESCANNED', 'MANUAL_ENTRY_AUTHORISED',
        'FALSE_ALARM', 'NO_ACTION_REQUIRED'].includes(resolution)) {
      const a = this.assignments.find((x) => x.id === found.assignmentId)
      if (a && a.status === 'EXCEPTION') a.status = 'PENDING'
    }
    if (found.assignmentId && resolution === 'VEHICLE_RESCHEDULED') {
      const a = this.assignments.find((x) => x.id === found.assignmentId)
      if (a && a.status !== 'COMPLETED') a.status = 'CANCELLED'
    }
    return delay(snapshot(found))
  }

  async cancelException(id: string, note: string): Promise<ExceptionRecord> {
    const found = this.mustFindException(id)
    if (note.trim().length < 5) throw new Error('say why it is being cancelled')
    found.status = 'CANCELLED'
    found.resolutionNote = note
    found.resolvedAt = new Date().toISOString()
    return delay(snapshot(found))
  }

  async requestOverride(exceptionId: string, note: string): Promise<ExceptionRecord> {
    const found = this.mustFindException(exceptionId)
    found.overrideRequested = true
    found.description = `${found.description ?? ''}\nDriver: ${note}`.trim()
    return delay(snapshot(found))
  }

  async approveOverride(
    exceptionId: string, reason: string, note: string,
  ): Promise<{ movementId: string }> {
    const found = this.mustFindException(exceptionId)
    if (found.raisedBy === this.profile?.id) {
      throw new Error('you cannot approve an override you requested yourself')
    }
    const a = this.assignments.find((x) => x.id === found.assignmentId)
    if (!a) throw new Error('this exception is not attached to an assignment')

    a.status = 'COMPLETED'
    const filled = a.containerFilled + 1
    for (const sibling of this.assignments) {
      if (sibling.containerId === a.containerId) sibling.containerFilled = filled
    }

    const movement: MovementEvent = {
      id: `mv-${Math.random().toString(36).slice(2, 8)}`,
      assignmentId: a.id,
      yardId: a.yardId,
      containerNo: a.containerNo,
      chassisNo: a.chassisNo,
      driverId: found.raisedBy,
      driverName: found.raisedByName,
      verifiedAt: new Date().toISOString(),
      status: 'OVERRIDDEN',
    }
    this.movements = [movement, ...this.movements]

    found.status = 'RESOLVED'
    found.resolution = 'OVERRIDE_APPROVED'
    found.resolutionNote = `${reason}: ${note}`
    found.resolvedAt = new Date().toISOString()
    return delay({ movementId: movement.id })
  }

  async getMovementEvidence(movementId: string): Promise<MovementEvidence> {
    const m = this.movements.find((x) => x.id === movementId)
    if (!m) throw new Error('movement not found')
    return delay({
      movement: {
        id: m.id, status: m.status, yardId: m.yardId,
        expectedContainerNo: m.containerNo, expectedChassisNo: m.chassisNo,
        scannedContainerNo: m.containerNo, scannedChassisNo: m.chassisNo,
        verifiedAt: m.verifiedAt, driverName: m.driverName,
        clockSkewSeconds: 2, appVersion: 'mock',
        gps: { lat: 18.9481, lng: 72.9214, accuracyM: 12 },
      },
      attempts: [],
    })
  }

  async getExceptionEvidence(): Promise<{ attempts: EvidenceAttempt[] }> {
    return delay({ attempts: [] })
  }

  /** No object store behind the mock. The viewer must say so, not show a gap. */
  async getEvidenceUrl(): Promise<string | null> {
    return delay(null)
  }

  async listUsers(): Promise<Profile[]> {
    return delay(snapshot(USERS))
  }

  async listAuditEntries(): Promise<AuditEntry[]> {
    return delay(snapshot(AUDIT))
  }
}
