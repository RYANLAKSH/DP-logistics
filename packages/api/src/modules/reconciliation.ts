/**
 * Authoritative reconciliation.
 *
 * The device computes a verdict offline for the officer's benefit; this is the
 * one that counts. When the two disagree — a stale cached report, a rules
 * version skew — the row is flagged and escalated rather than quietly
 * overwritten.
 */

import { reconcile, isContainerComplete, type PickupReportLine } from '@dp/shared-rules';

import { type Db, newId, nowIso, audit } from '../lib/db.ts';
import { renderReconEmail, sendNotification, type EventType } from '../lib/notifications.ts';

export interface SubmitInput {
  orgId: string;
  officerId: string;
  officerName: string;
  sessionId: string;
  locationId: string;
  containerNo: string;
  vin: string;
  containerScanId?: string | null;
  vinScanId?: string | null;
  deviceOutcome?: string | null;
}

interface ReportRow {
  id: string;
  reference_no: string;
  version: number;
  valid_to: string;
}

/** Loads the active report covering this location, with its lines. */
function loadActiveReport(
  db: Db,
  orgId: string,
  locationId: string,
): { report: ReportRow; lines: PickupReportLine[] } | null {
  const report = db
    .prepare(
      `SELECT id, reference_no, version, valid_to
         FROM pickup_reports
        WHERE org_id = ? AND location_id = ? AND status = 'active'
        ORDER BY version DESC LIMIT 1`,
    )
    .get(orgId, locationId) as ReportRow | undefined;

  if (!report) return null;

  const rows = db
    .prepare(
      `SELECT id, report_id, line_no, container_no, vin, make, model, variant,
              colour, load_position, booking_ref, destination_port
         FROM pickup_report_lines WHERE report_id = ?`,
    )
    .all(report.id) as Record<string, unknown>[];

  const lines: PickupReportLine[] = rows.map((row) => ({
    id: String(row.id),
    reportId: String(row.report_id),
    lineNo: Number(row.line_no),
    containerNo: String(row.container_no),
    vin: String(row.vin),
    make: row.make ? String(row.make) : undefined,
    model: row.model ? String(row.model) : undefined,
    variant: row.variant ? String(row.variant) : undefined,
    colour: row.colour ? String(row.colour) : undefined,
    loadPosition: row.load_position == null ? undefined : Number(row.load_position),
    bookingRef: row.booking_ref ? String(row.booking_ref) : undefined,
    destinationPort: row.destination_port ? String(row.destination_port) : undefined,
  }));

  return { report, lines };
}

/** VINs already carrying a live MATCH against this report. */
function loadedVinsFor(db: Db, reportId: string): Set<string> {
  const rows = db
    .prepare(
      `SELECT vin FROM reconciliations
        WHERE report_id = ? AND outcome = 'MATCH' AND supersedes_id IS NULL AND overridden = 0`,
    )
    .all(reportId) as { vin: string }[];

  return new Set(rows.map((row) => row.vin));
}

export interface SubmitResult {
  reconciliationId: string;
  outcome: string;
  reasonCode: string;
  severity: string;
  message: string;
  detail?: string;
  matchConfidence: number;
  outcomeDiffers: boolean;
  progress?: { loaded: number; expected: number; remainingVins: string[] };
  containerComplete: boolean;
}

export async function submitReconciliation(db: Db, input: SubmitInput): Promise<SubmitResult> {
  const loaded = loadActiveReport(db, input.orgId, input.locationId);

  const lines = loaded?.lines ?? [];
  const loadedVins = loaded ? loadedVinsFor(db, loaded.report.id) : new Set<string>();

  const result = reconcile({
    containerNo: input.containerNo,
    vin: input.vin,
    lines,
    loadedVins,
    // valid_to is a date; the report is good through the end of that day.
    reportValidTo: loaded ? new Date(`${loaded.report.valid_to}T23:59:59.999Z`) : undefined,
  });

  const id = newId();
  const outcomeDiffers = input.deviceOutcome != null && input.deviceOutcome !== result.outcome;

  db.prepare(
    `INSERT INTO reconciliations (
       id, org_id, session_id, container_scan_id, vin_scan_id, container_no, vin,
       report_id, report_version, report_line_id, outcome, reason_code, severity,
       match_confidence, device_outcome, outcome_differs, officer_id, message, detail,
       reconciled_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    input.orgId,
    input.sessionId,
    input.containerScanId ?? null,
    input.vinScanId ?? null,
    result.matchedLine?.containerNo ?? input.containerNo.toUpperCase(),
    result.matchedLine?.vin ?? input.vin.toUpperCase(),
    loaded?.report.id ?? null,
    loaded?.report.version ?? null,
    result.matchedLine?.id ?? null,
    result.outcome,
    result.reasonCode,
    result.severity,
    result.matchConfidence,
    input.deviceOutcome ?? null,
    outcomeDiffers ? 1 : 0,
    input.officerId,
    result.message,
    result.detail ?? null,
    nowIso(),
  );

  audit(db, {
    orgId: input.orgId,
    actorId: input.officerId,
    action: 'recon.submit',
    entityType: 'reconciliation',
    entityId: id,
    after: { outcome: result.outcome, containerNo: input.containerNo, vin: input.vin },
  });

  const locationName = String(
    (db.prepare('SELECT name FROM locations WHERE id = ?').get(input.locationId) as
      | { name: string }
      | undefined)?.name ?? input.locationId,
  );

  // Email is fired after the row is committed, and its failure is recorded
  // rather than propagated — a mail outage must not fail the scan.
  const email = renderReconEmail({
    outcome: result.outcome,
    containerNo: input.containerNo.toUpperCase(),
    vin: input.vin.toUpperCase(),
    message: result.message,
    detail: result.detail,
    officerName: input.officerName,
    locationName,
    reportReference: loaded ? `${loaded.report.reference_no} v${loaded.report.version}` : 'none active',
    occurredAt: nowIso(),
    vehicle: result.matchedLine
      ? [result.matchedLine.make, result.matchedLine.model, result.matchedLine.colour]
          .filter(Boolean)
          .join(' ')
      : result.expectedLine
        ? [result.expectedLine.make, result.expectedLine.model, result.expectedLine.colour]
            .filter(Boolean)
            .join(' ')
        : undefined,
    expectedContainerNo: result.expectedLine?.containerNo,
    progress: result.progress,
  });

  await sendNotification(
    db,
    input.orgId,
    {
      eventType: result.outcome as EventType,
      reconciliationId: id,
      subject: email.subject,
      body: email.body,
    },
    input.locationId,
  );

  const containerComplete =
    result.outcome === 'MATCH' &&
    isContainerComplete(input.containerNo, lines, new Set([...loadedVins, result.matchedLine!.vin]));

  if (containerComplete) {
    const done = renderReconEmail({
      ...email,
      outcome: 'MATCH',
      containerNo: input.containerNo.toUpperCase(),
      vin: input.vin.toUpperCase(),
      message: `Container ${input.containerNo.toUpperCase()} is fully loaded and ready to seal.`,
      officerName: input.officerName,
      locationName,
      reportReference: loaded ? `${loaded.report.reference_no} v${loaded.report.version}` : 'none',
      occurredAt: nowIso(),
    });

    await sendNotification(
      db,
      input.orgId,
      {
        eventType: 'CONTAINER_COMPLETE',
        reconciliationId: id,
        subject: `Container complete: ${input.containerNo.toUpperCase()}`,
        body: done.body,
      },
      input.locationId,
    );
  }

  return {
    reconciliationId: id,
    outcome: result.outcome,
    reasonCode: result.reasonCode,
    severity: result.severity,
    message: result.message,
    detail: result.detail,
    matchConfidence: result.matchConfidence,
    outcomeDiffers,
    progress: result.progress,
    containerComplete,
  };
}

/**
 * Supervisor override.
 *
 * Writes a NEW row that supersedes the original; the blocked decision is never
 * mutated. That is what makes the audit trail defensible.
 */
export async function overrideReconciliation(
  db: Db,
  args: {
    orgId: string;
    reconciliationId: string;
    supervisorId: string;
    supervisorName: string;
    reasonCode: string;
    notes?: string;
  },
): Promise<{ id: string } | null> {
  const original = db
    .prepare('SELECT * FROM reconciliations WHERE id = ? AND org_id = ?')
    .get(args.reconciliationId, args.orgId) as Record<string, unknown> | undefined;

  if (!original) return null;

  const id = newId();
  const at = nowIso();

  db.prepare(
    `INSERT INTO reconciliations (
       id, org_id, session_id, container_scan_id, vin_scan_id, container_no, vin,
       report_id, report_version, report_line_id, outcome, reason_code, severity,
       match_confidence, officer_id, message, detail, overridden, override_by,
       override_reason, override_at, supersedes_id, reconciled_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,'MATCH',?,'pass',?,?,?,?,1,?,?,?,?,?)`,
  ).run(
    id,
    args.orgId,
    String(original.session_id),
    original.container_scan_id ?? null,
    original.vin_scan_id ?? null,
    String(original.container_no),
    String(original.vin),
    original.report_id ?? null,
    original.report_version ?? null,
    original.report_line_id ?? null,
    args.reasonCode,
    Number(original.match_confidence ?? 0),
    String(original.officer_id),
    `Override applied by ${args.supervisorName}`,
    args.notes ?? null,
    args.supervisorId,
    args.reasonCode,
    at,
    args.reconciliationId,
    at,
  );

  audit(db, {
    orgId: args.orgId,
    actorId: args.supervisorId,
    action: 'recon.override',
    entityType: 'reconciliation',
    entityId: id,
    before: { id: args.reconciliationId, outcome: original.outcome },
    after: { reasonCode: args.reasonCode, notes: args.notes },
  });

  await sendNotification(db, args.orgId, {
    eventType: 'OVERRIDE_APPLIED',
    reconciliationId: id,
    subject: `Override applied — ${original.container_no} / ${original.vin}`,
    body:
      `${args.supervisorName} overrode a ${original.outcome} decision.\n\n` +
      `Container      ${original.container_no}\n` +
      `VIN            ${original.vin}\n` +
      `Original       ${original.outcome} (${original.reason_code})\n` +
      `Reason         ${args.reasonCode}\n` +
      (args.notes ? `Notes          ${args.notes}\n` : '') +
      `Time           ${at}\n`,
  });

  return { id };
}
