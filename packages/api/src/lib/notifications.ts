/**
 * Transactional email, fired from reconciliation events.
 *
 * Sending happens off the request path: the reconciliation is committed and
 * responded to first, then the email is queued. An SMTP outage must never turn
 * into a blocked truck.
 *
 * Dev uses nodemailer's JSON transport, so the whole flow is exercisable with
 * no credentials and nothing actually leaves the machine.
 */

import nodemailer, { type Transporter } from 'nodemailer';

import { type Db, newId, nowIso } from './db.ts';

export type EventType =
  | 'MATCH'
  | 'WRONG_CONTAINER'
  | 'VIN_NOT_IN_REPORT'
  | 'CONTAINER_NOT_IN_REPORT'
  | 'DUPLICATE_VIN'
  | 'CONTAINER_FULL'
  | 'EXPIRED_REPORT'
  | 'OVERRIDE_APPLIED'
  | 'CONTAINER_COMPLETE';

/** Events that page a human immediately rather than waiting for a digest. */
const HIGH_PRIORITY: ReadonlySet<EventType> = new Set([
  'WRONG_CONTAINER',
  'DUPLICATE_VIN',
  'CONTAINER_FULL',
  'OVERRIDE_APPLIED',
  'EXPIRED_REPORT',
]);

export interface MailPayload {
  eventType: EventType;
  reconciliationId?: string;
  subject: string;
  body: string;
}

let transport: Transporter | null = null;

export function getTransport(): Transporter {
  if (transport) return transport;

  if (process.env.SMTP_HOST) {
    transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT ?? 587),
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER
        ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
        : undefined,
    });
  } else {
    transport = nodemailer.createTransport({ jsonTransport: true });
  }
  return transport;
}

/** Test seam — lets the suite assert on what would have been sent. */
export function setTransport(custom: Transporter | null): void {
  transport = custom;
}

export function resolveRecipients(db: Db, orgId: string, eventType: EventType, locationId?: string): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT email FROM notification_recipients
        WHERE org_id = ? AND event_type = ? AND is_active = 1
          AND (location_id IS NULL OR location_id = ?)`,
    )
    .all(orgId, eventType, locationId ?? null) as { email: string }[];

  return rows.map((row) => row.email);
}

/**
 * Rejects addresses carrying CR/LF or a header separator.
 *
 * Recipient lists are configured by admins but report-derived data reaches the
 * subject and body, and nodemailer's own advisory history is largely header
 * injection. Filtering at the boundary is cheap insurance.
 */
const SAFE_EMAIL = /^[^\s<>,;:\\"]+@[^\s<>,;:\\"]+\.[a-z]{2,}$/i;

export function isSafeRecipient(email: string): boolean {
  return SAFE_EMAIL.test(email) && !/[\r\n]/.test(email);
}

/** Strips CR/LF so report-derived text cannot inject headers via the subject. */
const sanitizeSubject = (subject: string): string =>
  subject.replace(/[\r\n]+/g, ' ').slice(0, 200);

/**
 * How long a low-priority event stays suppressed after the last real send of
 * the same (org, location, event type) — the same 15-minute figure the
 * architecture doc suggests for a MATCH digest window.
 */
export const BATCH_WINDOW_MINUTES = 15;

/**
 * True if a real send already went out (or was attempted) for this
 * (org, location, event type) within the cooldown window.
 *
 * `notifications` has no org_id/location_id of its own — both are reached via
 * the reconciliation and scan session the notification was raised from,
 * which every batchable event already carries a reconciliation_id for. A
 * missing locationId (only possible for OVERRIDE_APPLIED today, which is
 * high-priority and never reaches this check) matches on org alone rather
 * than excluding every row.
 */
function withinCooldown(db: Db, orgId: string, locationId: string | undefined, eventType: EventType): boolean {
  const cutoff = new Date(Date.now() - BATCH_WINDOW_MINUTES * 60_000).toISOString();
  const row = db
    .prepare(
      `SELECT n.id FROM notifications n
         JOIN reconciliations r ON r.id = n.reconciliation_id
         JOIN scan_sessions s ON s.id = r.session_id
        WHERE r.org_id = ?
          AND (? IS NULL OR s.location_id = ?)
          AND n.event_type = ?
          AND n.status IN ('sent', 'failed')
          AND n.queued_at > ?
        ORDER BY n.queued_at DESC LIMIT 1`,
    )
    .get(orgId, locationId ?? null, locationId ?? null, eventType, cutoff);
  return Boolean(row);
}

/**
 * Queues and sends one notification, recording the attempt either way.
 *
 * "Did the email go out?" must be answerable from the database, so a failed
 * send is persisted as a failed row rather than thrown away — and so is a
 * send suppressed by the cooldown below, as its own distinct 'batched'
 * status: it is neither a delivery failure nor a successful send, and
 * conflating it with either would make "did this event actually alert
 * anyone" unanswerable from the DB.
 *
 * High-priority events (see HIGH_PRIORITY) never reach the cooldown check at
 * all — one bad import flooding MATCH/CONTAINER_COMPLETE must not delay a
 * WRONG_CONTAINER or OVERRIDE_APPLIED alert by so much as evaluating the
 * condition.
 */
export async function sendNotification(
  db: Db,
  orgId: string,
  payload: MailPayload,
  locationId?: string,
): Promise<{ id: string; status: string; recipients: string[] }> {
  const recipients = resolveRecipients(db, orgId, payload.eventType, locationId).filter(
    isSafeRecipient,
  );

  const id = newId();
  const subject = sanitizeSubject(payload.subject);

  if (recipients.length === 0) {
    db.prepare(
      `INSERT INTO notifications (id, reconciliation_id, event_type, recipients, subject,
                                  body, provider, status, attempts, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'skipped', 0, ?)`,
    ).run(id, payload.reconciliationId ?? null, payload.eventType, '', subject,
          payload.body, 'none', nowIso());
    return { id, status: 'skipped', recipients: [] };
  }

  if (!HIGH_PRIORITY.has(payload.eventType) && withinCooldown(db, orgId, locationId, payload.eventType)) {
    db.prepare(
      `INSERT INTO notifications (id, reconciliation_id, event_type, recipients, subject,
                                  body, provider, status, attempts, queued_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'batched', 0, ?)`,
    ).run(id, payload.reconciliationId ?? null, payload.eventType, recipients.join(','),
          subject, payload.body, 'none', nowIso());
    return { id, status: 'batched', recipients };
  }

  db.prepare(
    `INSERT INTO notifications (id, reconciliation_id, event_type, recipients, subject,
                                body, provider, status, attempts, queued_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?)`,
  ).run(id, payload.reconciliationId ?? null, payload.eventType, recipients.join(','),
        subject, payload.body, process.env.SMTP_HOST ? 'smtp' : 'json', nowIso());

  try {
    const info = await getTransport().sendMail({
      from: process.env.MAIL_FROM ?? 'reconciliation@dp-logistics.example',
      to: recipients,
      subject,
      text: payload.body,
      priority: HIGH_PRIORITY.has(payload.eventType) ? 'high' : 'normal',
    });

    db.prepare(
      `UPDATE notifications SET status = 'sent', provider_msg_id = ?, attempts = 1, sent_at = ?
        WHERE id = ?`,
    ).run(String(info.messageId ?? ''), nowIso(), id);

    return { id, status: 'sent', recipients };
  } catch (error) {
    db.prepare(
      `UPDATE notifications SET status = 'failed', error = ?, attempts = 1 WHERE id = ?`,
    ).run(error instanceof Error ? error.message : String(error), id);

    return { id, status: 'failed', recipients };
  }
}

/* ------------------------------------------------------------------ *
 * Templates
 * ------------------------------------------------------------------ */

export interface ReconEmailContext {
  outcome: string;
  containerNo: string;
  vin: string;
  message: string;
  detail?: string;
  officerName: string;
  locationName: string;
  reportReference: string;
  occurredAt: string;
  vehicle?: string;
  expectedContainerNo?: string;
  progress?: { loaded: number; expected: number };
}

/**
 * Human wording for each outcome.
 *
 * The enum is right for the database and the API; it is wrong for a subject
 * line. A supervisor reads this on a phone, at speed, and should not have to
 * decode WRONG_CONTAINER to know a truck needs stopping.
 */
const OUTCOME_LABEL: Readonly<Record<string, string>> = Object.freeze({
  WRONG_CONTAINER: 'Wrong vehicle',
  VIN_NOT_IN_REPORT: 'Vehicle not on the report',
  CONTAINER_NOT_IN_REPORT: 'Container not on the report',
  DUPLICATE_VIN: 'Vehicle presented twice',
  CONTAINER_FULL: 'Container already complete',
  EXPIRED_REPORT: 'Pickup report expired',
});

export function renderReconEmail(ctx: ReconEmailContext): { subject: string; body: string } {
  const isFailure = ctx.outcome !== 'MATCH';
  const label = OUTCOME_LABEL[ctx.outcome] ?? ctx.outcome;

  const subject = isFailure
    ? `[ACTION REQUIRED] ${label} — ${ctx.containerNo} at ${ctx.locationName}`
    : `Loaded: ${ctx.vin} into ${ctx.containerNo}`;

  const lines = [
    ctx.message,
    '',
    `Container      ${ctx.containerNo}`,
    `VIN            ${ctx.vin}`,
    ctx.vehicle ? `Vehicle        ${ctx.vehicle}` : null,
    ctx.expectedContainerNo ? `Belongs in     ${ctx.expectedContainerNo}` : null,
    ctx.progress ? `Progress       ${ctx.progress.loaded} of ${ctx.progress.expected} loaded` : null,
    '',
    `Outcome        ${ctx.outcome}`,
    `Report         ${ctx.reportReference}`,
    `Location       ${ctx.locationName}`,
    `Officer        ${ctx.officerName}`,
    `Time           ${ctx.occurredAt}`,
    ctx.detail ? '' : null,
    ctx.detail ?? null,
    '',
    '--',
    'DP Logistics container reconciliation',
  ].filter((line) => line !== null);

  return { subject, body: lines.join('\n') };
}
