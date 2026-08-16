/**
 * HTTP surface. See docs/api.md for the full contract.
 *
 * Route handlers stay thin: validate, authorize, delegate to a module. The
 * reconciliation rules live in @dp/shared-rules and nowhere else.
 */

import { fileURLToPath } from 'node:url';

import express, { type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';

import { type Db, newId, nowIso, audit } from './lib/db.ts';
import {
  type AuthUser,
  type Role,
  atLeast,
  hashPassword,
  verifyPassword,
  signAccessToken,
  verifyAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  ACCESS_TTL_SECONDS,
} from './lib/auth.ts';
import { previewCsv, commitReport } from './modules/ingest.ts';
import { submitReconciliation, overrideReconciliation } from './modules/reconciliation.ts';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      requestId?: string;
    }
  }
}

const fail = (res: Response, status: number, code: string, message: string, details?: unknown) =>
  res.status(status).json({ error: { code, message, details } });

export function createServer(db: Db) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.text({ type: 'text/csv', limit: '10mb' }));

  app.use((req, _res, next) => {
    req.requestId = newId();
    next();
  });

  /* ---------------------------------------------------------------- *
   * Middleware
   * ---------------------------------------------------------------- */

  const authenticate = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return fail(res, 401, 'UNAUTHENTICATED', 'Missing bearer token');

    const claims = verifyAccessToken(token);
    if (!claims) return fail(res, 401, 'UNAUTHENTICATED', 'Invalid or expired token');

    const row = db
      .prepare('SELECT id, org_id, email, full_name, role, is_active FROM users WHERE id = ?')
      .get(claims.sub) as Record<string, unknown> | undefined;

    // Re-read the user rather than trusting the token's role claim: a
    // deactivation or role change must take effect before the token expires.
    if (!row || !row.is_active) return fail(res, 401, 'UNAUTHENTICATED', 'User is not active');

    req.user = {
      id: String(row.id),
      orgId: String(row.org_id),
      email: String(row.email),
      fullName: String(row.full_name),
      role: String(row.role) as Role,
    };
    next();
  };

  const require = (role: Role) => (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) return fail(res, 401, 'UNAUTHENTICATED', 'Authentication required');
    if (!atLeast(req.user.role, role)) {
      return fail(res, 403, 'FORBIDDEN', `Requires ${role} or above`);
    }
    next();
  };

  /** Officers may only act at locations they are assigned to. */
  const assertLocationAccess = (user: AuthUser, locationId: string): boolean => {
    if (atLeast(user.role, 'admin')) return true;
    const row = db
      .prepare('SELECT 1 AS ok FROM user_locations WHERE user_id = ? AND location_id = ?')
      .get(user.id, locationId);
    return Boolean(row);
  };

  /* ---------------------------------------------------------------- *
   * Auth
   * ---------------------------------------------------------------- */

  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    deviceId: z.string().optional(),
    platform: z.string().optional(),
    appVersion: z.string().optional(),
  });

  app.post('/v1/auth/login', (req, res) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'INVALID_INPUT', 'Bad login payload');

    const { email, password, deviceId, platform, appVersion } = parsed.data;
    const row = db
      .prepare('SELECT * FROM users WHERE email = ? AND is_active = 1')
      .get(email.toLowerCase()) as Record<string, unknown> | undefined;

    // Same response for unknown user and wrong password — no account enumeration.
    if (!row || !verifyPassword(password, String(row.password_hash))) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    const user: AuthUser = {
      id: String(row.id),
      orgId: String(row.org_id),
      email: String(row.email),
      fullName: String(row.full_name),
      role: String(row.role) as Role,
    };

    let deviceStatus: 'approved' | 'pending_approval' | 'not_registered' = 'not_registered';
    if (deviceId) {
      const existing = db
        .prepare('SELECT id, approved_at FROM devices WHERE user_id = ? AND device_id = ?')
        .get(user.id, deviceId) as { id: string; approved_at: string | null } | undefined;

      if (existing) {
        db.prepare('UPDATE devices SET last_seen_at = ?, app_version = ? WHERE id = ?')
          .run(nowIso(), appVersion ?? null, existing.id);
        deviceStatus = existing.approved_at ? 'approved' : 'pending_approval';
      } else {
        // A new device registers itself but starts unapproved. Cheap control
        // that closes the shared-credentials hole.
        db.prepare(
          `INSERT INTO devices (id, user_id, device_id, platform, app_version, last_seen_at, created_at)
           VALUES (?,?,?,?,?,?,?)`,
        ).run(newId(), user.id, deviceId, platform ?? null, appVersion ?? null, nowIso(), nowIso());
        deviceStatus = 'pending_approval';
      }
    }

    db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(nowIso(), user.id);

    const locations = db
      .prepare(
        `SELECT l.id, l.code, l.name FROM locations l
           JOIN user_locations ul ON ul.location_id = l.id
          WHERE ul.user_id = ?`,
      )
      .all(user.id);

    res.json({
      accessToken: signAccessToken(user),
      refreshToken: issueRefreshToken(db, user.id),
      expiresIn: ACCESS_TTL_SECONDS,
      user,
      deviceStatus,
      locations,
    });
  });

  app.post('/v1/auth/refresh', (req, res) => {
    const token = String(req.body?.refreshToken ?? '');
    const rotated = rotateRefreshToken(db, token);
    if (!rotated) return fail(res, 401, 'INVALID_REFRESH_TOKEN', 'Refresh token is not usable');

    const row = db
      .prepare('SELECT * FROM users WHERE id = ? AND is_active = 1')
      .get(rotated.userId) as Record<string, unknown> | undefined;
    if (!row) return fail(res, 401, 'UNAUTHENTICATED', 'User is not active');

    const user: AuthUser = {
      id: String(row.id),
      orgId: String(row.org_id),
      email: String(row.email),
      fullName: String(row.full_name),
      role: String(row.role) as Role,
    };

    res.json({
      accessToken: signAccessToken(user),
      refreshToken: rotated.refreshToken,
      expiresIn: ACCESS_TTL_SECONDS,
    });
  });

  app.post('/v1/auth/logout', (req, res) => {
    revokeRefreshToken(db, String(req.body?.refreshToken ?? ''));
    res.status(204).end();
  });

  app.get('/v1/auth/me', authenticate, (req, res) => {
    const locations = db
      .prepare(
        `SELECT l.id, l.code, l.name FROM locations l
           JOIN user_locations ul ON ul.location_id = l.id
          WHERE ul.user_id = ?`,
      )
      .all(req.user!.id);
    res.json({ user: req.user, locations });
  });

  /* ---------------------------------------------------------------- *
   * Mobile sync
   * ---------------------------------------------------------------- */

  /** Report lines the device caches for offline reconciliation. */
  app.get('/v1/sync/reports', authenticate, (req, res) => {
    const locationId = String(req.query.locationId ?? '');
    if (!locationId) return fail(res, 400, 'INVALID_INPUT', 'locationId is required');
    if (!assertLocationAccess(req.user!, locationId)) {
      return fail(res, 403, 'FORBIDDEN', 'Not assigned to this location');
    }

    const report = db
      .prepare(
        `SELECT id, reference_no, version, delivery_order, valid_from, valid_to
           FROM pickup_reports
          WHERE org_id = ? AND location_id = ? AND status = 'active'
          ORDER BY version DESC LIMIT 1`,
      )
      .get(req.user!.orgId, locationId) as Record<string, unknown> | undefined;

    if (!report) return res.json({ report: null, lines: [], loadedVins: [] });

    const lines = db
      .prepare(
        `SELECT id, line_no, container_no, vin, make, model, variant, colour,
                load_position, booking_ref, destination_port
           FROM pickup_report_lines WHERE report_id = ? ORDER BY line_no`,
      )
      .all(report.id);

    const loadedVins = (
      db
        .prepare(
          `SELECT vin FROM reconciliations
            WHERE report_id = ? AND outcome = 'MATCH' AND supersedes_id IS NULL AND overridden = 0`,
        )
        .all(report.id) as { vin: string }[]
    ).map((row) => row.vin);

    res.json({ report, lines, loadedVins });
  });

  const scanSchema = z.object({
    id: z.string().uuid(),
    scanType: z.enum(['container', 'vin', 'other']),
    finalValue: z.string().min(1),
    detectedValue: z.string().optional(),
    imageKey: z.string().optional(),
    imageSha256: z.string().optional(),
    ocrRawText: z.string().optional(),
    ocrConfidence: z.number().min(0).max(1).optional(),
    ocrEngine: z.string().optional(),
    wasManualEntry: z.boolean().optional(),
    checkDigitOk: z.boolean().optional(),
    gpsLat: z.number().optional(),
    gpsLng: z.number().optional(),
    gpsAccuracyM: z.number().optional(),
    capturedAt: z.string(),
  });

  const sessionSchema = z.object({
    id: z.string().uuid(),
    locationId: z.string(),
    startedAt: z.string(),
    appVersion: z.string().optional(),
    deviceOutcome: z.string().optional(),
    scans: z.array(scanSchema).min(1),
  });

  /**
   * Batch upload of queued sessions.
   *
   * Idempotent on the client-generated session id — the device retries, and a
   * retry must not create a second reconciliation.
   */
  app.post('/v1/sync/scans', authenticate, async (req, res) => {
    const parsed = z.object({ sessions: z.array(sessionSchema).max(100) }).safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, 'INVALID_INPUT', 'Bad sync payload', parsed.error.flatten());
    }

    const results: unknown[] = [];

    for (const session of parsed.data.sessions) {
      if (!assertLocationAccess(req.user!, session.locationId)) {
        results.push({ id: session.id, status: 'rejected', reason: 'FORBIDDEN_LOCATION' });
        continue;
      }

      const existing = db
        .prepare('SELECT id FROM scan_sessions WHERE id = ?')
        .get(session.id) as { id: string } | undefined;

      if (existing) {
        const prior = db
          .prepare('SELECT * FROM reconciliations WHERE session_id = ? ORDER BY reconciled_at LIMIT 1')
          .get(session.id) as Record<string, unknown> | undefined;
        results.push({ id: session.id, status: 'duplicate', reconciliation: prior ?? null });
        continue;
      }

      db.prepare(
        `INSERT INTO scan_sessions (id, org_id, officer_id, location_id, started_at, received_at, app_version)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(session.id, req.user!.orgId, req.user!.id, session.locationId,
            session.startedAt, nowIso(), session.appVersion ?? null);

      for (const scan of session.scans) {
        db.prepare(
          `INSERT INTO scans (id, session_id, scan_type, image_key, image_sha256, ocr_raw_text,
                              ocr_confidence, ocr_engine, detected_value, final_value,
                              was_manual_entry, check_digit_ok, gps_lat, gps_lng, gps_accuracy_m,
                              captured_at, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        ).run(
          scan.id, session.id, scan.scanType, scan.imageKey ?? null, scan.imageSha256 ?? null,
          scan.ocrRawText ?? null, scan.ocrConfidence ?? null, scan.ocrEngine ?? null,
          scan.detectedValue ?? null, scan.finalValue, scan.wasManualEntry ? 1 : 0,
          scan.checkDigitOk == null ? null : scan.checkDigitOk ? 1 : 0,
          scan.gpsLat ?? null, scan.gpsLng ?? null, scan.gpsAccuracyM ?? null,
          scan.capturedAt, nowIso(),
        );
      }

      const containerScan = session.scans.find((scan) => scan.scanType === 'container');
      const vinScan = session.scans.find((scan) => scan.scanType === 'vin');

      if (!containerScan || !vinScan) {
        results.push({ id: session.id, status: 'incomplete', reason: 'AWAITING_SCAN' });
        continue;
      }

      const outcome = await submitReconciliation(db, {
        orgId: req.user!.orgId,
        officerId: req.user!.id,
        officerName: req.user!.fullName,
        sessionId: session.id,
        locationId: session.locationId,
        containerNo: containerScan.finalValue,
        vin: vinScan.finalValue,
        containerScanId: containerScan.id,
        vinScanId: vinScan.id,
        deviceOutcome: session.deviceOutcome ?? null,
      });

      results.push({ id: session.id, status: 'accepted', ...outcome });
    }

    res.json({ sessions: results });
  });

  /* ---------------------------------------------------------------- *
   * Reconciliations
   * ---------------------------------------------------------------- */

  app.get('/v1/reconciliations', authenticate, (req, res) => {
    const outcome = req.query.outcome ? String(req.query.outcome) : null;
    const limit = Math.min(Number(req.query.limit ?? 50), 200);

    const rows = db
      .prepare(
        `SELECT * FROM reconciliations
          WHERE org_id = ? AND (? IS NULL OR outcome = ?)
          ORDER BY reconciled_at DESC LIMIT ?`,
      )
      .all(req.user!.orgId, outcome, outcome, limit);

    res.json({ reconciliations: rows });
  });

  app.get('/v1/reconciliations/:id', authenticate, (req, res) => {
    const row = db
      .prepare('SELECT * FROM reconciliations WHERE id = ? AND org_id = ?')
      .get(req.params.id, req.user!.orgId);
    if (!row) return fail(res, 404, 'NOT_FOUND', 'Reconciliation not found');
    res.json(row);
  });

  const overrideSchema = z.object({
    reasonCode: z.enum([
      'REPORT_ERROR',
      'LAST_MINUTE_SUBSTITUTION',
      'DAMAGED_PLATE',
      'OPERATIONAL_EXCEPTION',
      'OTHER',
    ]),
    notes: z.string().max(1000).optional(),
  });

  app.post('/v1/reconciliations/:id/override', authenticate, require('supervisor'), async (req, res) => {
    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'INVALID_INPUT', 'reasonCode is required');

    // Free text is mandatory for OTHER — an unexplained override is not an
    // audit trail, and the override rate is a metric people act on.
    if (parsed.data.reasonCode === 'OTHER' && !parsed.data.notes?.trim()) {
      return fail(res, 400, 'INVALID_INPUT', 'notes are required when reasonCode is OTHER');
    }

    const result = await overrideReconciliation(db, {
      orgId: req.user!.orgId,
      reconciliationId: req.params.id!,
      supervisorId: req.user!.id,
      supervisorName: req.user!.fullName,
      reasonCode: parsed.data.reasonCode,
      notes: parsed.data.notes,
    });

    if (!result) return fail(res, 404, 'NOT_FOUND', 'Reconciliation not found');
    res.status(201).json(result);
  });

  /* ---------------------------------------------------------------- *
   * Admin — report ingest
   * ---------------------------------------------------------------- */

  app.post('/v1/admin/reports/preview', authenticate, require('admin'), (req, res) => {
    const csv = typeof req.body === 'string' ? req.body : String(req.body?.csv ?? '');
    if (!csv.trim()) return fail(res, 400, 'INVALID_INPUT', 'CSV body is empty');

    const preview = previewCsv(csv, req.body?.mapping);
    if (preview.headerRow < 0) {
      return fail(res, 422, 'NO_HEADER_FOUND',
        'Could not locate a header row containing both a container and a chassis column');
    }
    res.json(preview);
  });

  const commitSchema = z.object({
    csv: z.string().min(1),
    locationId: z.string(),
    referenceNo: z.string().min(1),
    deliveryOrder: z.string().min(1),
    validFrom: z.string(),
    validTo: z.string(),
    mapping: z.record(z.string().nullable()).optional(),
    sourceFileName: z.string().optional(),
  });

  app.post('/v1/admin/reports/commit', authenticate, require('admin'), (req, res) => {
    const parsed = commitSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, 'INVALID_INPUT', 'Bad commit payload', parsed.error.flatten());
    }

    const preview = previewCsv(parsed.data.csv, parsed.data.mapping);
    if (preview.validCount === 0) {
      return fail(res, 422, 'NO_VALID_ROWS', 'Nothing to commit — every row was rejected', {
        rejectedCount: preview.rejectedCount,
      });
    }

    try {
      const result = commitReport(db, preview, {
        orgId: req.user!.orgId,
        locationId: parsed.data.locationId,
        uploadedBy: req.user!.id,
        referenceNo: parsed.data.referenceNo,
        deliveryOrder: parsed.data.deliveryOrder,
        validFrom: parsed.data.validFrom,
        validTo: parsed.data.validTo,
        sourceFileName: parsed.data.sourceFileName,
      });
      res.status(201).json({ ...result, rejectedCount: preview.rejectedCount });
    } catch (error) {
      return fail(res, 500, 'COMMIT_FAILED', error instanceof Error ? error.message : 'unknown');
    }
  });

  /* ---------------------------------------------------------------- *
   * Admin — users, devices, recipients, dashboard
   * ---------------------------------------------------------------- */

  const userSchema = z.object({
    email: z.string().email(),
    password: z.string().min(8),
    fullName: z.string().min(1),
    role: z.enum(['field_officer', 'supervisor', 'admin', 'auditor']),
    locationIds: z.array(z.string()).optional(),
  });

  app.post('/v1/admin/users', authenticate, require('admin'), (req, res) => {
    const parsed = userSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, 'INVALID_INPUT', 'Bad user payload', parsed.error.flatten());
    }

    const id = newId();
    try {
      db.prepare(
        `INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      ).run(id, req.user!.orgId, parsed.data.email.toLowerCase(),
            hashPassword(parsed.data.password), parsed.data.fullName, parsed.data.role, nowIso());
    } catch {
      return fail(res, 409, 'EMAIL_TAKEN', 'A user with that email already exists');
    }

    for (const locationId of parsed.data.locationIds ?? []) {
      db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)').run(id, locationId);
    }

    audit(db, {
      orgId: req.user!.orgId, actorId: req.user!.id, action: 'user.create',
      entityType: 'user', entityId: id,
      after: { email: parsed.data.email, role: parsed.data.role },
    });

    res.status(201).json({ id });
  });

  app.get('/v1/admin/devices', authenticate, require('supervisor'), (req, res) => {
    const rows = db
      .prepare(
        `SELECT d.*, u.full_name, u.email FROM devices d
           JOIN users u ON u.id = d.user_id
          WHERE u.org_id = ? AND (? = 'all' OR (? = 'pending' AND d.approved_at IS NULL))`,
      )
      .all(req.user!.orgId, String(req.query.status ?? 'all'), String(req.query.status ?? 'all'));
    res.json({ devices: rows });
  });

  app.post('/v1/admin/devices/:id/approve', authenticate, require('supervisor'), (req, res) => {
    const changed = db
      .prepare('UPDATE devices SET approved_at = ?, approved_by = ? WHERE id = ?')
      .run(nowIso(), req.user!.id, req.params.id);

    if (changed.changes === 0) return fail(res, 404, 'NOT_FOUND', 'Device not found');
    audit(db, {
      orgId: req.user!.orgId, actorId: req.user!.id, action: 'device.approve',
      entityType: 'device', entityId: req.params.id,
    });
    res.status(204).end();
  });

  const recipientSchema = z.object({
    eventType: z.string().min(1),
    email: z.string().email(),
    locationId: z.string().nullable().optional(),
  });

  app.post('/v1/admin/notification-recipients', authenticate, require('admin'), (req, res) => {
    const parsed = recipientSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'INVALID_INPUT', 'Bad recipient payload');

    const id = newId();
    db.prepare(
      `INSERT INTO notification_recipients (id, org_id, event_type, location_id, email)
       VALUES (?,?,?,?,?)`,
    ).run(id, req.user!.orgId, parsed.data.eventType, parsed.data.locationId ?? null,
          parsed.data.email);

    res.status(201).json({ id });
  });

  app.get('/v1/admin/notifications', authenticate, require('supervisor'), (req, res) => {
    const rows = db
      .prepare('SELECT * FROM notifications ORDER BY queued_at DESC LIMIT ?')
      .all(Math.min(Number(req.query.limit ?? 50), 200));
    res.json({ notifications: rows });
  });

  app.get('/v1/admin/dashboard/summary', authenticate, require('supervisor'), (req, res) => {
    const counts = db
      .prepare(
        `SELECT outcome, COUNT(*) AS n FROM reconciliations
          WHERE org_id = ? AND supersedes_id IS NULL GROUP BY outcome`,
      )
      .all(req.user!.orgId) as { outcome: string; n: number }[];

    const total = counts.reduce((sum, row) => sum + row.n, 0);
    const match = counts.find((row) => row.outcome === 'MATCH')?.n ?? 0;

    const overrides = (
      db
        .prepare('SELECT COUNT(*) AS n FROM reconciliations WHERE org_id = ? AND overridden = 1')
        .get(req.user!.orgId) as { n: number }
    ).n;

    // OCR accuracy comes free from storing both the proposed and confirmed
    // value — it is the metric that tells you whether the ML is earning its keep.
    const ocr = db
      .prepare(
        `SELECT scan_type,
                SUM(CASE WHEN detected_value = final_value THEN 1 ELSE 0 END) AS correct,
                COUNT(*) AS total
           FROM scans WHERE detected_value IS NOT NULL GROUP BY scan_type`,
      )
      .all() as { scan_type: string; correct: number; total: number }[];

    res.json({
      total,
      match,
      exceptions: total - match,
      byOutcome: Object.fromEntries(counts.map((row) => [row.outcome, row.n])),
      overrideRate: total ? overrides / total : 0,
      ocrAccuracy: Object.fromEntries(
        ocr.map((row) => [row.scan_type, row.total ? row.correct / row.total : null]),
      ),
    });
  });

  app.get('/v1/health', (_req, res) => res.json({ status: 'ok', time: nowIso() }));

  // The admin panel is a single no-build page served from the API, so there is
  // one process to run in development and no separate origin to configure.
  // Splitting it into its own Next.js app is a deployment concern, not an
  // architectural one — the API surface it consumes is unchanged either way.
  const adminDir = fileURLToPath(new URL('../../admin/', import.meta.url));
  app.use('/admin', express.static(adminDir));

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
    console.error(`[${req.requestId}]`, err);
    fail(res, 500, 'INTERNAL', 'Unexpected error');
  });

  return app;
}
