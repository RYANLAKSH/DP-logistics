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
  YardBoard, MovementEvidence, EvidenceAttempt, AuditFilter, ManifestCorrection,
  ShiftReport,
} from '../types'
import type { ConnectionState } from '@/lib/realtime'
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
    if (profile) {
      // Best effort: a failure to log the sign-in must not block the sign-in.
      void this.recordSignIn().catch(() => {})
    }
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
    const gps = input.gps === undefined ? await currentPosition() : input.gps
    const data = unwrap(
      await this.db.rpc('verify_movement', {
        p_movement_id: input.movementId,
        p_assignment_id: input.assignmentId,
        p_scanned_container_no: input.scannedContainerNo,
        p_scanned_chassis_no: input.scannedChassisNo,
        p_container_attempt_id: input.containerAttemptId ?? null,
        p_chassis_attempt_id: input.chassisAttemptId ?? null,
        p_gps_lat: gps?.lat ?? null,
        p_gps_lng: gps?.lng ?? null,
        p_gps_accuracy_m: gps?.accuracy ?? null,
        p_gps_denied: gps === null,
        p_completed_at_device: new Date().toISOString(),
        p_app_version: __APP_VERSION__,
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
    // raise_exception returns public.exceptions — a row type, snake_case on
    // the wire — same as acknowledge/resolve/cancel below. This one skipped
    // the mapper and cast the raw row straight to ExceptionRecord, so a
    // caller reading .raisedByName or .yardId got undefined at runtime with
    // no type error, because the cast suppressed the check that would have
    // caught it.
    const data = unwrap(
      await this.db.rpc('raise_exception', {
        p_assignment_id: input.assignmentId ?? null,
        p_type: input.type,
        p_description: input.description,
      }),
    )
    return toException(data as ExceptionRow)
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
    // v_yard_dashboard has one row per (yard_id, operating_date) — a yard
    // accumulates one of those every day it operates, and past days are never
    // archived (only same-day republishing archives the prior version). Filter
    // by yard alone, and this returns more than one row the day after the
    // first: exactly one call site, but a real "second day breaks the query"
    // trap for anyone who wires this method up later. .maybeSingle() then
    // throws PGRST116 instead of failing quietly, so it would have been loud
    // when it happened — this fixes the cause rather than waiting for that.
    const today = new Date().toISOString().slice(0, 10)
    const { data, error } = await this.db
      .from('v_yard_dashboard')
      .select('*')
      .eq('yard_id', yardId)
      .eq('operating_date', today)
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

  async getBoard(yardId: string, date?: string): Promise<YardBoard> {
    const data = unwrap(
      await this.db.rpc('yard_board', { p_yard_id: yardId, p_date: date ?? null }),
    ) as RawBoard
    return {
      yardId: data.yardId,
      operatingDate: data.operatingDate,
      counters: data.counters,
      containers: data.containers,
      openExceptions: data.openExceptions,
      activity: (data.activity ?? []).map(toActivity),
      exceptionFeed: (data.exceptionFeed ?? []).map(toActivity),
    }
  }

  /**
   * One channel per yard, filtered SERVER-side.
   *
   * An unfiltered subscription sends every organisation's changes to every
   * listening client for RLS to reject — a performance problem, and one
   * misconfigured policy away from a data leak.
   */
  subscribeToYard(
    yardId: string,
    onChange: () => void,
    onState: (state: ConnectionState) => void,
  ): () => void {
    onState('connecting')
    const channel = this.db
      .channel(`yard:${yardId}`)
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'movement_events',
            filter: `yard_id=eq.${yardId}` },
          () => onChange())
      .on('postgres_changes',
          { event: '*', schema: 'public', table: 'exceptions',
            filter: `yard_id=eq.${yardId}` },
          () => onChange())
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') onState('live')
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') onState('reconnecting')
        else if (status === 'CLOSED') onState('offline')
      })

    return () => { void this.db.removeChannel(channel) }
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
        sequence_no: number | null; container_inherited?: boolean
        invoice_no?: string; seal_no?: string
        errors: string[]; warnings: string[]
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
        containerInherited: r.container_inherited,
        invoiceNo: r.invoice_no,
        sealNo: r.seal_no,
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

  async acknowledgeException(id: string): Promise<ExceptionRecord> {
    return toException(
      unwrap(await this.db.rpc('acknowledge_exception', { p_exception_id: id })) as never,
    )
  }

  async resolveException(
    id: string, resolution: string, note: string,
  ): Promise<ExceptionRecord> {
    return toException(
      unwrap(await this.db.rpc('resolve_exception', {
        p_exception_id: id, p_resolution: resolution, p_note: note,
      })) as never,
    )
  }

  async cancelException(id: string, note: string): Promise<ExceptionRecord> {
    return toException(
      unwrap(await this.db.rpc('cancel_exception', {
        p_exception_id: id, p_note: note,
      })) as never,
    )
  }

  async requestOverride(exceptionId: string, note: string): Promise<ExceptionRecord> {
    return toException(
      unwrap(await this.db.rpc('request_override', {
        p_exception_id: exceptionId, p_note: note,
      })) as never,
    )
  }

  async approveOverride(
    exceptionId: string, reason: string, note: string,
  ): Promise<{ movementId: string }> {
    const data = unwrap(await this.db.rpc('approve_override', {
      p_exception_id: exceptionId, p_reason: reason, p_note: note,
    })) as { movement_id: string }
    return { movementId: data.movement_id }
  }

  async getMovementEvidence(movementId: string): Promise<MovementEvidence> {
    return unwrap(
      await this.db.rpc('movement_evidence', { p_movement_id: movementId }),
    ) as unknown as MovementEvidence
  }

  async getExceptionEvidence(
    exceptionId: string,
  ): Promise<{ attempts: EvidenceAttempt[] }> {
    return unwrap(
      await this.db.rpc('exception_evidence', { p_exception_id: exceptionId }),
    ) as unknown as { attempts: EvidenceAttempt[] }
  }

  /**
   * Five minutes, and no longer.
   *
   * Long-lived links leak: they end up in chat messages, browser history and
   * screenshots, and a bucket URL that works for a week is effectively public
   * to anyone who has ever been sent one.
   */
  async getEvidenceUrl(path: string): Promise<string | null> {
    const { data, error } = await this.db.storage
      .from('evidence')
      .createSignedUrl(path, 300)
    if (error) return null
    return data?.signedUrl ?? null
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

  async listAuditEntries(filter: AuditFilter = {}): Promise<AuditEntry[]> {
    let query = this.db
      .from('audit_logs')
      .select('*')
      .order('occurred_at', { ascending: false })
      .limit(filter.limit ?? 200)

    // Filtering server-side matters here: the audit log is the table that grows
    // without bound, and fetching a year of it to filter in the browser is how
    // the screen becomes unusable exactly when someone needs it.
    if (filter.action) query = query.eq('action', filter.action)
    if (filter.from) query = query.gte('occurred_at', filter.from)
    if (filter.to) query = query.lte('occurred_at', `${filter.to}T23:59:59.999Z`)

    const rows = unwrap(await query)
    const needle = filter.search?.trim().toLowerCase()
    return (rows as AuditRow[])
      .filter((r) => !needle
        || r.action.toLowerCase().includes(needle)
        || r.entity_type.toLowerCase().includes(needle)
        || JSON.stringify(r.after_value ?? {}).toLowerCase().includes(needle))
      .map((r) => ({
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

  async getShiftReport(yardId: string, date?: string): Promise<ShiftReport> {
    return unwrap(await this.db.rpc('shift_report', {
      p_yard_id: yardId, p_date: date ?? null,
    })) as unknown as ShiftReport
  }

  async listCorrections(): Promise<ManifestCorrection[]> {
    const rows = unwrap(
      await this.db
        .from('manifest_corrections')
        .select('*')
        .order('corrected_at', { ascending: false })
        .limit(100),
    ) as CorrectionRow[]
    return rows.map((r) => ({
      id: r.id,
      fieldName: r.field_name,
      beforeValue: r.before_value ?? undefined,
      afterValue: r.after_value ?? undefined,
      reason: r.reason,
      containerNo: r.container_no ?? undefined,
      chassisNo: r.chassis_no ?? undefined,
      correctedAt: r.corrected_at,
      affectedMovementCount: Array.isArray(r.affected_movements)
        ? r.affected_movements.length : 0,
    }))
  }

  async correctAssignment(input: {
    assignmentId: string
    field: 'chassis_no' | 'container_no' | 'sequence_no'
    newValue: string
    reason: string
  }): Promise<{ correctionId: string; version: number; affectedMovements: unknown[] }> {
    const data = unwrap(await this.db.rpc('correct_manifest_assignment', {
      p_assignment_id: input.assignmentId,
      p_field: input.field,
      p_new_value: input.newValue,
      p_reason: input.reason,
    })) as { correction_id: string; version: number; affected_movements: unknown[] }
    return {
      correctionId: data.correction_id,
      version: data.version,
      affectedMovements: data.affected_movements ?? [],
    }
  }

  /** Sign-in is issued by GoTrue, so the client reports it for the audit log. */
  async recordSignIn(): Promise<void> {
    await this.db.rpc('record_sign_in', {
      p_context: { userAgent: navigator.userAgent, appVersion: __APP_VERSION__ },
    })
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
  container_sequence: number | null
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
    containerSequenceNo: r.container_sequence ?? undefined,
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

interface RawBoard {
  yardId: string
  operatingDate: string
  counters: YardBoard['counters']
  containers: YardBoard['containers']
  openExceptions: number
  activity: RawFeedItem[]
  exceptionFeed: RawFeedItem[]
}

interface RawFeedItem {
  id: string
  kind: ActivityItem['kind']
  occurred_at: string
  actor_name: string | null
  container_no: string | null
  chassis_no: string | null
  detail: string | null
  exception_type: ExceptionRecord['type'] | null
}

function toActivity(r: RawFeedItem): ActivityItem {
  return {
    id: r.id,
    kind: r.kind,
    occurredAt: r.occurred_at,
    actorName: r.actor_name ?? 'unknown',
    containerNo: r.container_no ?? undefined,
    chassisNo: r.chassis_no ?? undefined,
    detail: r.detail ?? undefined,
    exceptionType: r.exception_type ?? undefined,
  }
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
        containerInherited: row.container_inherited === true,
        invoiceNo: row.invoice_no == null ? undefined : String(row.invoice_no),
        sealNo: row.seal_no == null ? undefined : String(row.seal_no),
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
    overrideRequested: (r as ExceptionRow & { override_requested?: boolean })
      .override_requested ?? false,
    acknowledgedAt: (r as ExceptionRow & { acknowledged_at?: string | null })
      .acknowledged_at ?? undefined,
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

interface CorrectionRow {
  id: string
  field_name: string
  before_value: string | null
  after_value: string | null
  reason: string
  container_no: string | null
  chassis_no: string | null
  corrected_at: string
  affected_movements: unknown
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
