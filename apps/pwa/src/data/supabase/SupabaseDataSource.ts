/**
 * The real backend.
 *
 * Every read is a select that RLS filters. Every write that decides an outcome
 * is an RPC — this class has no `insert` or `update` against movement_events,
 * exceptions, manifests or audit_logs, because the database grants it none.
 * If a method here ever needs one, the authorisation model has been broken.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  DataSource, ExceptionSubmission, ScanEvidence, ScanRecord, ScanSubmission,
} from '../DataSource'
import type {
  ActivityItem, Assignment, AuditEntry, DashboardCounters, ExceptionRecord,
  Manifest, ManifestImport, MovementEvent, Profile, VerificationResult, Yard,
} from '../types'
import { pickNextAssignment } from '../nextAssignment'
import { getSupabase } from './client'

/** Shape of the me() RPC. */
interface MeRow {
  id: string
  orgId: string
  role: Profile['role']
  fullName: string
  employeeNo: string | null
  yards: Yard[]
}

function unwrap<T>({ data, error }: { data: T | null; error: { message: string } | null }): T {
  if (error) throw new Error(error.message)
  if (data === null) throw new Error('no data returned')
  return data
}

export class SupabaseDataSource implements DataSource {
  readonly kind = 'supabase' as const

  private yardCache: Yard[] = []

  constructor(private readonly db: SupabaseClient = getSupabase()) {}

  // ------------------------------------------------------------- identity
  async signIn(email: string, password: string): Promise<Profile> {
    const { error } = await this.db.auth.signInWithPassword({ email, password })
    if (error) throw new Error(error.message)
    const profile = await this.currentProfile()
    if (!profile) {
      // Authenticated but with no active profile: an identity without any
      // authorisation. Do not leave a half-signed-in session lying around.
      await this.db.auth.signOut()
      throw new Error(
        'This account is not set up for the yard. Ask an administrator to activate it.',
      )
    }
    return profile
  }

  async signOut(): Promise<void> {
    await this.db.auth.signOut()
    this.yardCache = []
  }

  async currentProfile(): Promise<Profile | null> {
    const { data: sessionData } = await this.db.auth.getSession()
    if (!sessionData.session) return null

    const { data, error } = await this.db.rpc('me')
    if (error) throw new Error(error.message)
    if (!data) return null

    const me = data as MeRow
    this.yardCache = me.yards ?? []
    return {
      id: me.id,
      orgId: me.orgId,
      role: me.role,
      fullName: me.fullName,
      employeeNo: me.employeeNo ?? undefined,
      yardIds: (me.yards ?? []).map((y) => y.id),
    }
  }

  /** Fires when Supabase refreshes, restores or drops the session. */
  onAuthChange(handler: (signedIn: boolean) => void): () => void {
    const { data } = this.db.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_OUT') handler(false)
      if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') handler(true)
    })
    return () => data.subscription.unsubscribe()
  }

  // --------------------------------------------------------------- driver
  async listYards(): Promise<Yard[]> {
    if (this.yardCache.length) return this.yardCache
    const rows = unwrap(await this.db.from('yards').select('id, code, name'))
    return rows as Yard[]
  }

  async listMyAssignments(): Promise<Assignment[]> {
    const rows = unwrap(
      await this.db
        .from('v_driver_tasks')
        .select('*')
        .order('container_no')
        .order('sequence_no'),
    )
    return (rows as TaskRow[]).map(toAssignment)
  }

  async getAssignment(id: string): Promise<Assignment | null> {
    const { data, error } = await this.db
      .from('v_driver_tasks')
      .select('*')
      .eq('assignment_id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data ? toAssignment(data as TaskRow) : null
  }

  /**
   * Upload the photograph, then record the attempt.
   *
   * The hash is computed here, on the device, BEFORE upload. Hashing
   * server-side after upload would only prove that the bytes in the bucket
   * hash to what they hash to; hashing here and comparing later proves the
   * image has not been altered in transit or at rest.
   *
   * The client does not choose the storage path — it asks for one.
   */
  async recordScan(input: ScanEvidence): Promise<ScanRecord> {
    const path = unwrap(
      await this.db.rpc('create_evidence_upload_path', {
        p_assignment_id: input.assignmentId,
        p_kind: input.kind,
        p_attempt_id: input.attemptId,
      }),
    ) as unknown as string

    const bytes = new Uint8Array(await input.image.arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0')).join('')

    const upload = await this.db.storage
      .from('evidence')
      .upload(path, input.image, { contentType: 'image/jpeg', upsert: false })
    // A duplicate path means this attempt was already uploaded — a retry after
    // a dropped connection. That is success, not a failure to report.
    if (upload.error && !/exists/i.test(upload.error.message)) {
      throw new Error(upload.error.message)
    }

    const position = await currentPosition()

    const data = unwrap(
      await this.db.rpc('record_scan_attempt', {
        p_attempt_id: input.attemptId,
        p_assignment_id: input.assignmentId,
        p_kind: input.kind,
        p_scanned_value: input.scannedValue,
        p_image_path: path,
        p_image_sha256: sha256,
        p_ocr_text_raw: input.ocrTextRaw ?? null,
        p_ocr_confidence: input.ocrConfidence ?? null,
        p_ocr_engine: input.ocrEngine ?? null,
        p_value_source: input.source,
        p_gps_lat: position?.lat ?? null,
        p_gps_lng: position?.lng ?? null,
        p_gps_accuracy_m: position?.accuracy ?? null,
        p_gps_denied: position === null,
      }),
    ) as { attempt_id: string; result: string }

    return { attemptId: data.attempt_id, result: data.result }
  }

  async verifyMovement(input: ScanSubmission): Promise<VerificationResult> {
    // The authoritative decision. Note what is NOT sent: no expected values, no
    // outcome, no status. The server reads those from the manifest itself.
    const data = unwrap(
      await this.db.rpc('verify_movement', {
        p_movement_id: input.movementId,
        p_assignment_id: input.assignmentId,
        p_scanned_container_no: input.scannedContainerNo,
        p_scanned_chassis_no: input.scannedChassisNo,
        p_container_attempt_id: input.containerAttemptId ?? null,
        p_chassis_attempt_id: input.chassisAttemptId ?? null,
        p_commit: input.commit ?? true,
      }),
    )
    return toVerificationResult(data as Record<string, unknown>)
  }

  async nextAssignment(): Promise<Assignment | null> {
    const all = await this.listMyAssignments()
    return pickNextAssignment(all)
  }

  async raiseException(input: ExceptionSubmission): Promise<ExceptionRecord> {
    const data = unwrap(
      await this.db.rpc('raise_exception', {
        p_assignment_id: input.assignmentId ?? null,
        p_type: input.type,
        p_description: input.description,
      }),
    )
    return data as ExceptionRecord
  }

  async listMyMovements(): Promise<MovementEvent[]> {
    const rows = unwrap(
      await this.db
        .from('movement_events')
        .select('id, assignment_id, yard_id, expected_container_no, expected_chassis_no, driver_id, verified_at, status')
        .order('verified_at', { ascending: false }),
    )
    return (rows as MovementRow[]).map((r) => ({
      id: r.id,
      assignmentId: r.assignment_id,
      yardId: r.yard_id,
      containerNo: r.expected_container_no,
      chassisNo: r.expected_chassis_no,
      driverId: r.driver_id,
      driverName: '',
      verifiedAt: r.verified_at,
      status: r.status,
    }))
  }

  // -------------------------------------------------------------- manager
  async getDashboard(yardId: string): Promise<DashboardCounters> {
    const { data, error } = await this.db
      .from('v_yard_dashboard')
      .select('*')
      .eq('yard_id', yardId)
      .maybeSingle()
    if (error) throw new Error(error.message)

    const openExceptions = await this.db
      .from('exceptions')
      .select('id', { count: 'exact', head: true })
      .eq('yard_id', yardId)
      .in('status', ['OPEN', 'UNDER_REVIEW'])

    const row = (data ?? {}) as Record<string, number>
    const scheduled = row.vehicles_scheduled ?? 0
    const completed = row.vehicles_completed ?? 0
    const inProgress = row.vehicles_in_progress ?? 0
    const exception = row.vehicles_exception ?? 0
    return {
      vehiclesScheduled: scheduled,
      vehiclesCompleted: completed,
      vehiclesInProgress: inProgress,
      vehiclesException: exception,
      vehiclesPending: Math.max(0, scheduled - completed - inProgress - exception),
      containersScheduled: row.containers_scheduled ?? 0,
      containersCompleted: row.containers_completed ?? 0,
      activeDrivers: row.active_drivers ?? 0,
      openExceptions: openExceptions.count ?? 0,
    }
  }

  async listActivity(yardId: string): Promise<ActivityItem[]> {
    const rows = unwrap(
      await this.db
        .from('v_activity_feed')
        .select('*')
        .eq('yard_id', yardId)
        .order('occurred_at', { ascending: false })
        .limit(50),
    )
    return (rows as ActivityRow[]).map((r) => ({
      id: r.event_id,
      kind: r.event_kind,
      occurredAt: r.occurred_at,
      actorName: r.driver_id ?? '',
      containerNo: r.container_no ?? undefined,
      chassisNo: r.chassis_no ?? undefined,
      detail: r.detail ?? undefined,
      exceptionType: r.exception_type ?? undefined,
    }))
  }

  async listManifests(): Promise<Manifest[]> {
    const rows = unwrap(
      await this.db
        .from('manifests')
        .select('*, yards(name)')
        .order('operating_date', { ascending: false })
        .order('version', { ascending: false }),
    )
    return (rows as ManifestRow[]).map((r) => ({
      id: r.id,
      yardId: r.yard_id,
      yardName: r.yards?.name ?? '',
      operatingDate: r.operating_date,
      version: r.version,
      status: r.status,
      referenceNo: r.reference_no ?? undefined,
      totalContainers: r.total_containers,
      totalVehicles: r.total_vehicles,
      publishedAt: r.published_at ?? undefined,
    }))
  }

  async getManifestImport(id: string): Promise<ManifestImport | null> {
    const { data, error } = await this.db
      .from('manifest_imports')
      .select('*')
      .eq('id', id)
      .maybeSingle()
    if (error) throw new Error(error.message)
    return data ? toManifestImport(data as ImportRow) : null
  }

  /**
   * Upload, then ask the server to parse.
   *
   * The client hashes the file, asks for a path (it never chooses one), uploads
   * it, records the import, and invokes parse-manifest. It cannot write
   * `parsed_rows` — that column is not in its grant — so what becomes live is
   * always the server's reading of the file the manager uploaded.
   */
  async parseManifestFile(
    file: File, yardId: string, operatingDate: string,
  ): Promise<ManifestImport> {
    const bytes = new Uint8Array(await file.arrayBuffer())
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    const sha256 = [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, '0')).join('')

    const extension = file.name.slice(file.name.lastIndexOf('.') + 1).toLowerCase()
    const path = unwrap(
      await this.db.rpc('create_manifest_upload_path', {
        p_yard_id: yardId,
        p_operating_date: operatingDate,
        p_file_sha256: sha256,
        p_extension: extension,
      }),
    ) as unknown as string

    const upload = await this.db.storage
      .from('manifests')
      .upload(path, file, { upsert: true, contentType: file.type || 'text/csv' })
    if (upload.error) throw new Error(upload.error.message)

    const inserted = unwrap(
      await this.db.from('manifest_imports').insert({
        org_id: (await this.requireProfile()).orgId,
        yard_id: yardId,
        operating_date: operatingDate,
        file_name: file.name,
        file_path: path,
        file_sha256: sha256,
        file_bytes: file.size,
        uploaded_by: (await this.requireProfile()).id,
      }).select('id').single(),
    ) as { id: string }

    const { data, error } = await this.db.functions.invoke('parse-manifest', {
      body: { importId: inserted.id },
    })
    if (error) throw new Error(await readFunctionError(error))

    const parsed = data as {
      rowCount: number; validCount: number; rejectedCount: number
      rows: Array<{
        row_no: number; container_no: string; chassis_no: string
        sequence_no: number | null; errors: string[]; warnings: string[]
      }>
    }

    return {
      id: inserted.id,
      yardId,
      operatingDate,
      fileName: file.name,
      rowCount: parsed.rowCount,
      validCount: parsed.validCount,
      rejectedCount: parsed.rejectedCount,
      rows: parsed.rows.map((r) => ({
        rowNo: r.row_no,
        containerNo: r.container_no,
        chassisNo: r.chassis_no,
        sequenceNo: r.sequence_no,
        errors: r.errors,
        warnings: r.warnings,
      })),
    }
  }

  private cachedProfile: Profile | null = null

  private async requireProfile(): Promise<Profile> {
    this.cachedProfile ??= await this.currentProfile()
    if (!this.cachedProfile) throw new Error('not signed in')
    return this.cachedProfile
  }

  async publishManifestImport(importId: string): Promise<Manifest> {
    const data = unwrap(
      await this.db.rpc('publish_manifest_from_import', { p_import_id: importId }),
    )
    const result = data as { manifest_id: string }
    const manifests = await this.listManifests()
    return manifests.find((m) => m.id === result.manifest_id)!
  }

  async listAssignments(yardId: string): Promise<Assignment[]> {
    const rows = unwrap(
      await this.db.from('v_driver_tasks').select('*').eq('yard_id', yardId),
    )
    return (rows as TaskRow[]).map(toAssignment)
  }

  async listExceptions(yardId: string): Promise<ExceptionRecord[]> {
    const rows = unwrap(
      await this.db
        .from('exceptions')
        .select('*')
        .eq('yard_id', yardId)
        .order('raised_at', { ascending: false }),
    )
    return (rows as ExceptionRow[]).map(toException)
  }

  async resolveException(): Promise<ExceptionRecord> {
    throw new Error('Exception resolution arrives in phase 9')
  }

  async listUsers(): Promise<Profile[]> {
    const rows = unwrap(
      await this.db.from('profiles').select('id, org_id, role, full_name, employee_no'),
    )
    return (rows as ProfileRow[]).map((r) => ({
      id: r.id,
      orgId: r.org_id,
      role: r.role,
      fullName: r.full_name,
      employeeNo: r.employee_no ?? undefined,
      yardIds: [],
    }))
  }

  async listAuditEntries(): Promise<AuditEntry[]> {
    const rows = unwrap(
      await this.db
        .from('audit_logs')
        .select('*')
        .order('occurred_at', { ascending: false })
        .limit(200),
    )
    return (rows as AuditRow[]).map((r) => ({
      id: String(r.id),
      occurredAt: r.occurred_at,
      actorName: r.actor_id ?? 'system',
      actorRole: r.actor_role ?? 'ADMIN',
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id ?? undefined,
      detail: (r.after_value ?? undefined) as Record<string, unknown> | undefined,
    }))
  }
}

// ------------------------------ row mappings --------------------------------
// Postgres speaks snake_case and the UI speaks camelCase. Keeping the
// translation in one place means a schema rename shows up as a type error here
// rather than as an undefined somewhere in a component.

interface TaskRow {
  assignment_id: string; assignment_status: Assignment['status']
  chassis_no: string; sequence_no: number; vehicle_reg_no: string | null
  make_model: string | null; colour: string | null; claimed_by: string | null
  container_id: string; container_no: string; bay_position: string | null
  expected_vehicle_count: number; manifest_id: string; yard_id: string
  container_filled: number; is_completed: boolean
}

function toAssignment(r: TaskRow): Assignment {
  return {
    id: r.assignment_id,
    manifestId: r.manifest_id,
    yardId: r.yard_id,
    containerId: r.container_id,
    containerNo: r.container_no,
    bayPosition: r.bay_position ?? undefined,
    expectedVehicleCount: r.expected_vehicle_count,
    containerFilled: r.container_filled,
    chassisNo: r.chassis_no,
    sequenceNo: r.sequence_no,
    vehicleRegNo: r.vehicle_reg_no ?? undefined,
    makeModel: r.make_model ?? undefined,
    colour: r.colour ?? undefined,
    status: r.is_completed ? 'COMPLETED' : r.assignment_status,
    claimedBy: r.claimed_by ?? undefined,
  }
}

interface MovementRow {
  id: string; assignment_id: string; yard_id: string
  expected_container_no: string; expected_chassis_no: string
  driver_id: string; verified_at: string; status: MovementEvent['status']
}

interface ActivityRow {
  event_id: string; event_kind: ActivityItem['kind']; occurred_at: string
  driver_id: string | null; container_no: string | null; chassis_no: string | null
  detail: string | null; exception_type: ExceptionRecord['type'] | null
}

interface ManifestRow {
  id: string; yard_id: string; operating_date: string; version: number
  status: Manifest['status']; reference_no: string | null
  total_containers: number; total_vehicles: number; published_at: string | null
  yards: { name: string } | null
}

interface ImportRow {
  id: string; yard_id: string; operating_date: string; file_name: string
  row_count: number | null; valid_count: number | null; rejected_count: number | null
  parsed_rows: unknown
}

function toManifestImport(r: ImportRow): ManifestImport {
  const rows = Array.isArray(r.parsed_rows) ? r.parsed_rows : []
  return {
    id: r.id,
    yardId: r.yard_id,
    operatingDate: r.operating_date,
    fileName: r.file_name,
    rowCount: r.row_count ?? rows.length,
    validCount: r.valid_count ?? 0,
    rejectedCount: r.rejected_count ?? 0,
    rows: rows.map((raw) => {
      const row = raw as Record<string, unknown>
      return {
        rowNo: Number(row.row_no ?? 0),
        containerNo: String(row.container_no ?? ''),
        chassisNo: String(row.chassis_no ?? ''),
        sequenceNo: row.sequence_no == null ? null : Number(row.sequence_no),
        errors: (row.errors as string[]) ?? [],
        warnings: (row.warnings as string[]) ?? [],
      }
    }),
  }
}

interface ExceptionRow {
  id: string; yard_id: string; assignment_id: string | null
  type: ExceptionRecord['type']; status: ExceptionRecord['status']
  severity: 1 | 2 | 3; expected_value: string | null; actual_value: string | null
  description: string | null; raised_by: string | null; raised_at: string
  resolved_at: string | null; resolution: string | null; resolution_note: string | null
}

function toException(r: ExceptionRow): ExceptionRecord {
  return {
    id: r.id,
    yardId: r.yard_id,
    assignmentId: r.assignment_id ?? undefined,
    type: r.type,
    status: r.status,
    severity: r.severity,
    expectedValue: r.expected_value ?? undefined,
    actualValue: r.actual_value ?? undefined,
    description: r.description ?? undefined,
    raisedBy: r.raised_by ?? '',
    raisedByName: '',
    raisedAt: r.raised_at,
    resolvedAt: r.resolved_at ?? undefined,
    resolution: r.resolution ?? undefined,
    resolutionNote: r.resolution_note ?? undefined,
  }
}

interface ProfileRow {
  id: string; org_id: string; role: Profile['role']
  full_name: string; employee_no: string | null
}

interface AuditRow {
  id: number; occurred_at: string; actor_id: string | null
  actor_role: Profile['role'] | null; action: string
  entity_type: string; entity_id: string | null; after_value: unknown
}

export function toVerificationResult(raw: Record<string, unknown>): VerificationResult {
  const detail = (raw.detail ?? {}) as Record<string, unknown>
  return {
    outcome: raw.outcome as VerificationResult['outcome'],
    status: raw.status === 'COMPLETED' ? 'COMPLETED' : 'BLOCKED',
    movementId: (raw.movement_id as string) ?? undefined,
    exceptionId: (raw.exception_id as string) ?? undefined,
    expectedContainerNo: (raw.expected_container_no as string) ?? (raw.container_no as string) ?? '',
    expectedChassisNo: (raw.expected_chassis_no as string) ?? (raw.chassis_no as string) ?? '',
    scannedContainerNo: (raw.scanned_container_no as string) ?? undefined,
    scannedChassisNo: (raw.scanned_chassis_no as string) ?? undefined,
    containerFilled: raw.container_filled == null ? undefined : Number(raw.container_filled),
    containerCapacity:
      raw.container_capacity == null ? undefined : Number(raw.container_capacity),
    scannedVehicleBelongsToContainer:
      (detail.scanned_vehicle_belongs_to_container as string) ?? undefined,
    bayPosition: (detail.bay_position as string) ?? undefined,
  }
}

/**
 * Edge Function errors arrive as an opaque FunctionsHttpError whose useful
 * detail is in the response body. Without reading it the manager sees
 * "Edge Function returned a non-2xx status code", which tells them nothing
 * about which row of their file is wrong.
 */
async function readFunctionError(error: unknown): Promise<string> {
  const withContext = error as { context?: Response; message?: string }
  try {
    if (withContext.context && typeof withContext.context.json === 'function') {
      const body = await withContext.context.json()
      if (body?.error) return String(body.error)
    }
  } catch {
    // Fall through to the generic message.
  }
  return withContext.message ?? 'The manifest could not be parsed.'
}

/**
 * Location, if the driver has granted it.
 *
 * Event-based only: read at the moment of a scan, never watched. This is
 * evidence about a movement, not a way to follow an employee around a yard,
 * and the difference has to be visible in the code as well as the policy.
 *
 * A refusal is recorded as a refusal and never blocks the scan. GPS is
 * corroborating evidence; the photograph is the evidence.
 */
async function currentPosition(): Promise<
  { lat: number; lng: number; accuracy: number } | null
> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) return null
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({
        lat: p.coords.latitude,
        lng: p.coords.longitude,
        accuracy: p.coords.accuracy,
      }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 5000, maximumAge: 30_000 },
    )
  })
}
