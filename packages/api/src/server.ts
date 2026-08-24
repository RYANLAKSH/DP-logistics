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
import { createLoginRateLimiter } from './lib/rateLimit.ts';
import {
  getStorage,
  LocalStorageDriver,
  MAX_IMAGE_BYTES,
  isAllowedContentType,
} from './lib/storage.ts';
import {
  presignScanImage,
  refreshScanUploadUrl,
  finalizeScanImage,
  evidenceForReconciliation,
  missingEvidence,
} from './modules/evidence.ts';
import {
  declareDocument,
  finalizeDocument,
  listDocuments,
  documentsFor,
  documentViewUrl,
  buildDossier,
  linkDocument,
  relinkDocument,
  DOC_TYPES,
  MAX_DOCUMENT_BYTES,
} from './modules/documents.ts';
import { isRecognisable } from './modules/ocr.ts';
import {
  runOcrWorker,
  requeueOcr,
  latestOcrJob,
  listOcrJobs,
} from './modules/ocrWorker.ts';
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

/**
 * Forwards async handler rejections to the error middleware.
 *
 * Express 4 does not await route handlers, so an unhandled rejection leaves the
 * request open until the client times out. At a gate that reads as the app
 * hanging, which is worse than an error.
 */
const wrap =
  (handler: (req: Request, res: Response) => Promise<unknown>) =>
    (req: Request, res: Response, next: NextFunction) => {
      handler(req, res).catch(next);
    };

export function createServer(db: Db) {
  const app = express();

  // One limiter per server instance — see lib/rateLimit.ts for the policy.
  const loginRateLimiter = createLoginRateLimiter();

  /* ---------------------------------------------------------------- *
   * Local object store
   *
   * Registered BEFORE the global body parsers, deliberately. Express applies
   * middleware in order, and the global text parser for text/csv would
   * otherwise consume a CSV document upload as a string — leaving the raw
   * parser nothing to read and failing every spreadsheet upload.
   * ---------------------------------------------------------------- */

  /*
   * These two routes exist only for the local storage driver — with S3 the
   * device talks to the bucket directly and these are never hit.
   *
   * Deliberately unauthenticated: the signed token IS the authorisation, which
   * is the same trust model as an S3 presigned URL. It names one key, permits
   * one operation, and expires.
   */
  app.put('/v1/storage/:token',
    // Serves both evidence photos and trade documents, so the transport limit is
    // the larger of the two. The per-declaration ceilings are enforced when the
    // capability is issued, which is where the two differ.
    express.raw({ type: '*/*', limit: MAX_DOCUMENT_BYTES }),
    (req, res) => {
      const storage = getStorage();
      if (!(storage instanceof LocalStorageDriver)) {
        return fail(res, 404, 'NOT_FOUND', 'Local storage is not in use');
      }

      const capability = storage.verify(String(req.params.token));
      if (!capability || capability.o !== 'put') {
        return fail(res, 403, 'INVALID_CAPABILITY', 'Upload URL is invalid or expired');
      }

      const body = req.body as Buffer;
      if (!Buffer.isBuffer(body) || body.length === 0) {
        return fail(res, 400, 'EMPTY_BODY', 'No bytes received');
      }
      if (capability.c && !isAllowedContentType(capability.c)) {
        return fail(res, 400, 'UNSUPPORTED_CONTENT_TYPE', 'Content type not allowed');
      }

      storage.write(capability.k, body);
      res.status(201).json({ bytes: body.length });
    });

  app.get('/v1/storage/:token', (req, res) => {
    const storage = getStorage();
    if (!(storage instanceof LocalStorageDriver)) {
      return fail(res, 404, 'NOT_FOUND', 'Local storage is not in use');
    }

    const capability = storage.verify(String(req.params.token));
    if (!capability || capability.o !== 'get') {
      return fail(res, 403, 'INVALID_CAPABILITY', 'Link is invalid or expired');
    }

    const bytes = storage.read(capability.k);
    if (!bytes) return fail(res, 404, 'NOT_FOUND', 'Object not found');

    res.setHeader('content-type', capability.c ?? 'application/octet-stream');
    res.setHeader('cache-control', 'private, max-age=300');
    res.send(bytes);
  });


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
    const normalizedEmail = email.trim().toLowerCase();
    // req.ip is Express's own view of the socket's remote address — the app
    // never sets `trust proxy`, so this cannot be spoofed via X-Forwarded-For
    // or any other client-supplied header.
    const clientIp = req.ip ?? 'unknown';

    const ipLimit = loginRateLimiter.checkIp(clientIp);
    if (!ipLimit.allowed) {
      res.set('Retry-After', String(ipLimit.retryAfterSeconds));
      return fail(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many login attempts. Try again later.');
    }

    const identifierLimit = loginRateLimiter.checkIdentifier(normalizedEmail);
    if (!identifierLimit.allowed) {
      res.set('Retry-After', String(identifierLimit.retryAfterSeconds));
      return fail(res, 429, 'TOO_MANY_ATTEMPTS', 'Too many login attempts. Try again later.');
    }

    const row = db
      .prepare('SELECT * FROM users WHERE email = ? AND is_active = 1')
      .get(normalizedEmail) as Record<string, unknown> | undefined;

    // Same response for unknown user and wrong password — no account enumeration.
    if (!row || !verifyPassword(password, String(row.password_hash))) {
      return fail(res, 401, 'INVALID_CREDENTIALS', 'Email or password is incorrect');
    }

    // A real login succeeded — clear this identifier's failed-attempt budget
    // so ordinary day-to-day use (occasional typo, then the right password)
    // never accumulates toward the brute-force threshold.
    loginRateLimiter.recordSuccess(normalizedEmail);

    const user: AuthUser = {
      id: String(row.id),
      orgId: String(row.org_id),
      email: String(row.email),
      fullName: String(row.full_name),
      role: String(row.role) as Role,
    };

    // Device approval is no longer an access gate (Stage 11 — DP Logistics is
    // web-first, and a browser is not a separately-approved security
    // principal). When a client supplies a deviceId this still records/updates
    // a devices row purely as bookkeeping — it links scan_sessions and
    // refresh_tokens back to the client instance that produced them for
    // audit purposes — but nothing about that row's state can block a login.
    let deviceRowId: string | undefined;
    if (deviceId) {
      const existing = db
        .prepare('SELECT id FROM devices WHERE user_id = ? AND device_id = ?')
        .get(user.id, deviceId) as { id: string } | undefined;

      if (existing) {
        db.prepare('UPDATE devices SET last_seen_at = ?, app_version = ? WHERE id = ?')
          .run(nowIso(), appVersion ?? null, existing.id);
        deviceRowId = existing.id;
      } else {
        deviceRowId = newId();
        db.prepare(
          `INSERT INTO devices (id, user_id, device_id, platform, app_version, last_seen_at, created_at)
           VALUES (?,?,?,?,?,?,?)`,
        ).run(deviceRowId, user.id, deviceId, platform ?? null, appVersion ?? null, nowIso(), nowIso());
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
      accessToken: signAccessToken(user, deviceRowId),
      refreshToken: issueRefreshToken(db, user.id, deviceRowId),
      expiresIn: ACCESS_TTL_SECONDS,
      user,
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
      accessToken: signAccessToken(user, rotated.deviceRowId ?? undefined),
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
      .all(String(report.id));

    const loadedVins = (
      db
        .prepare(
          `SELECT vin FROM reconciliations
            WHERE report_id = ? AND outcome = 'MATCH' AND supersedes_id IS NULL AND overridden = 0`,
        )
        .all(String(report.id)) as { vin: string }[]
    ).map((row) => row.vin);

    res.json({ report, lines, loadedVins });
  });

  const scanSchema = z.object({
    id: z.string().uuid(),
    scanType: z.enum(['container', 'vin', 'other']),
    finalValue: z.string().min(1),
    detectedValue: z.string().optional(),
    // The device declares WHAT it will upload; the server derives WHERE.
    // A client-supplied key would let a compromised device overwrite another
    // officer's evidence.
    imageSha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
    imageContentType: z.enum(['image/jpeg', 'image/png', 'image/webp']).optional(),
    imageBytes: z.number().int().positive().max(MAX_IMAGE_BYTES).optional(),
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
  app.post('/v1/sync/scans', authenticate, wrap(async (req, res) => {
    const parsed = z.object({ sessions: z.array(sessionSchema).max(100) }).safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, 'INVALID_INPUT', 'Bad sync payload', parsed.error.flatten());
    }

    const results: unknown[] = [];

    for (const session of parsed.data.sessions) {
      try {
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
          scan.id, session.id, scan.scanType, null, scan.imageSha256 ?? null,
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

      // Metadata is committed and the email has fired. Only now do we hand
      // back upload URLs, so a slow transfer delays evidence rather than the
      // verdict.
      const uploads: Record<string, unknown> = {};
      for (const scan of session.scans) {
        if (!scan.imageSha256 || !scan.imageContentType || !scan.imageBytes) continue;

        const presigned = await presignScanImage(db, req.user!.orgId, {
          scanId: scan.id,
          sha256: scan.imageSha256,
          contentType: scan.imageContentType,
          bytes: scan.imageBytes,
        });
        uploads[scan.id] = presigned.ok
          ? presigned.upload
          : { error: presigned.reason };
      }

      results.push({ id: session.id, status: 'accepted', ...outcome, uploads });
      } catch (error) {
        // A device drains its whole queue in one call. One malformed or
        // conflicting session must not cost the officer the other forty-nine,
        // so failures are reported per session rather than for the batch.
        console.error(`[${req.requestId}] session ${session.id} failed`, error);
        results.push({
          id: session.id,
          status: 'failed',
          reason: error instanceof Error ? error.message : 'unknown error',
        });
      }
    }

    res.json({ sessions: results });
  }));

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
      .get(String(req.params.id), req.user!.orgId);
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

  app.post('/v1/reconciliations/:id/override', authenticate, require('supervisor'), wrap(async (req, res) => {
    const parsed = overrideSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'INVALID_INPUT', 'reasonCode is required');

    // Free text is mandatory for OTHER — an unexplained override is not an
    // audit trail, and the override rate is a metric people act on.
    if (parsed.data.reasonCode === 'OTHER' && !parsed.data.notes?.trim()) {
      return fail(res, 400, 'INVALID_INPUT', 'notes are required when reasonCode is OTHER');
    }

    const result = await overrideReconciliation(db, {
      orgId: req.user!.orgId,
      reconciliationId: String(req.params.id),
      supervisorId: req.user!.id,
      supervisorName: req.user!.fullName,
      reasonCode: parsed.data.reasonCode,
      notes: parsed.data.notes,
    });

    if (!result) return fail(res, 404, 'NOT_FOUND', 'Reconciliation not found');
    res.status(201).json(result);
  }));

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
   * Admin — users, recipients, dashboard
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

    // Evidence coverage: a verdict with no verified image behind it is a
    // decision nobody can review later.
    const evidence = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN s.image_verified = 1 THEN 1 ELSE 0 END) AS verified
           FROM scans s JOIN scan_sessions ss ON ss.id = s.session_id
          WHERE ss.org_id = ?`,
      )
      .get(req.user!.orgId) as { total: number; verified: number | null };

    res.json({
      total,
      match,
      exceptions: total - match,
      evidence: {
        scans: evidence.total,
        verified: evidence.verified ?? 0,
        coverage: evidence.total ? (evidence.verified ?? 0) / evidence.total : null,
      },
      byOutcome: Object.fromEntries(counts.map((row) => [row.outcome, row.n])),
      overrideRate: total ? overrides / total : 0,
      ocrAccuracy: Object.fromEntries(
        ocr.map((row) => [row.scan_type, row.total ? row.correct / row.total : null]),
      ),
    });
  });

  /* ---------------------------------------------------------------- *
   * Evidence images
   * ---------------------------------------------------------------- */

  /**
   * A fresh upload URL for an image declared earlier.
   *
   * The device calls this when its URL expired before it got a connection long
   * enough to deliver the bytes.
   */
  app.post('/v1/scans/:scanId/image-upload-url', authenticate, wrap(async (req, res) => {
    const result = await refreshScanUploadUrl(db, req.user!.orgId, String(req.params.scanId));

    if (!result.ok) {
      const status = result.reason === 'ALREADY_VERIFIED' ? 409 : 404;
      return fail(res, status, result.reason, 'Cannot issue an upload URL for this scan');
    }
    res.json({ upload: result.upload });
  }));

  /**
   * Confirms an upload landed intact.
   *
   * Called by the device after it PUTs the bytes. The server compares the
   * stored object against the hash the device declared beforehand.
   */
  app.post('/v1/scans/:scanId/image-uploaded', authenticate, wrap(async (req, res) => {
    const result = await finalizeScanImage(db, req.user!.orgId, String(req.params.scanId), req.user!.id);

    switch (result.status) {
      case 'verified':
        return res.json({ status: 'verified', bytes: result.bytes });
      case 'unknown_scan':
        return fail(res, 404, 'NOT_FOUND', 'Scan not found');
      case 'no_declaration':
        return fail(res, 409, 'NO_DECLARATION', 'No image was declared for this scan');
      case 'missing':
        // Expected when the device calls too early or the PUT failed silently;
        // it should retry the upload, not the finalize.
        return fail(res, 409, 'OBJECT_MISSING', 'No object found at the expected key');
      case 'hash_mismatch':
        return fail(res, 422, 'HASH_MISMATCH',
          'Uploaded bytes do not match the declared SHA-256', {
            expected: result.expected, actual: result.actual,
          });
      case 'size_mismatch':
        return fail(res, 422, 'SIZE_MISMATCH',
          'Uploaded byte count does not match the declaration', {
            expected: result.expected, actual: result.actual,
          });
    }
  }));

  /** Viewing links for a reconciliation's images. Every issue is logged. */
  app.get('/v1/reconciliations/:id/evidence', authenticate, wrap(async (req, res) => {
    const items = await evidenceForReconciliation(db, req.user!.orgId, String(req.params.id), {
      id: req.user!.id,
      ip: req.ip ?? null,
    });
    if (!items) return fail(res, 404, 'NOT_FOUND', 'Reconciliation not found');
    res.json({ evidence: items });
  }));

  /** Decisions with no verified picture behind them. */
  app.get('/v1/admin/evidence/missing', authenticate, require('supervisor'), (req, res) => {
    res.json({ scans: missingEvidence(db, req.user!.orgId, Math.min(Number(req.query.limit ?? 100), 500)) });
  });

  /* ---------------------------------------------------------------- *
   * Trade documents
   * ---------------------------------------------------------------- */

  const documentSchema = z.object({
    docType: z.enum(DOC_TYPES),
    referenceNo: z.string().max(120).optional(),
    issuedOn: z.string().max(40).optional(),
    issuedBy: z.string().max(200).optional(),
    fileName: z.string().max(300).optional(),
    contentType: z.string().min(1),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().positive().max(MAX_DOCUMENT_BYTES),
    locationId: z.string().optional(),
    links: z.array(z.object({
      entityType: z.enum(['container', 'vin', 'delivery_order', 'pickup_report', 'booking']),
      entityId: z.string().min(1),
    })).max(2000).optional(),
    extractedText: z.string().max(2_000_000).optional(),
  });

  /** Registers a document and returns an upload URL. Same flow as scan evidence. */
  app.post('/v1/documents', authenticate, require('supervisor'), wrap(async (req, res) => {
    const parsed = documentSchema.safeParse(req.body);
    if (!parsed.success) {
      return fail(res, 400, 'INVALID_INPUT', 'Bad document payload', parsed.error.flatten());
    }

    const result = await declareDocument(db, req.user!.orgId, req.user!.id, parsed.data);
    if (!result.ok) return fail(res, 422, result.reason, 'Document declaration rejected');

    res.status(201).json({ documentId: result.documentId, upload: result.upload });
  }));

  app.post('/v1/documents/:id/uploaded', authenticate, require('supervisor'), wrap(async (req, res) => {
    const result = await finalizeDocument(db, req.user!.orgId, String(req.params.id), req.user!.id);

    switch (result.status) {
      case 'verified':
        return res.json({
          status: 'verified',
          bytes: result.bytes,
          ocrQueued: result.ocrQueued ?? false,
          ocrSkipReason: result.ocrSkipReason,
        });
      case 'unknown_document':
        return fail(res, 404, 'NOT_FOUND', 'Document not found');
      case 'missing':
        return fail(res, 409, 'OBJECT_MISSING', 'No object found at the expected key');
      case 'hash_mismatch':
        return fail(res, 422, 'HASH_MISMATCH',
          'Uploaded bytes do not match the declared SHA-256', {
            expected: result.expected, actual: result.actual,
          });
    }
  }));

  app.get('/v1/documents', authenticate, (req, res) => {
    res.json({
      documents: listDocuments(db, req.user!.orgId, {
        docType: req.query.docType ? String(req.query.docType) : undefined,
        referenceNo: req.query.referenceNo ? String(req.query.referenceNo) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    });
  });

  app.get('/v1/documents/:id/view', authenticate, wrap(async (req, res) => {
    const signed = await documentViewUrl(db, req.user!.orgId, String(req.params.id), {
      id: req.user!.id,
      ip: req.ip ?? null,
    });
    if (!signed) return fail(res, 404, 'NOT_FOUND', 'Document not found or not yet verified');
    res.json(signed);
  }));

  const linkSchema = z.object({
    entityType: z.enum(['container', 'vin', 'delivery_order', 'pickup_report', 'booking']),
    entityId: z.string().min(1),
  });

  app.post('/v1/documents/:id/links', authenticate, require('supervisor'), (req, res) => {
    const parsed = linkSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'INVALID_INPUT', 'Bad link payload');

    const exists = db
      .prepare('SELECT 1 AS ok FROM documents WHERE id = ? AND org_id = ?')
      .get(String(req.params.id), req.user!.orgId);
    if (!exists) return fail(res, 404, 'NOT_FOUND', 'Document not found');

    linkDocument(db, String(req.params.id), parsed.data.entityType, parsed.data.entityId, 'manual');
    res.status(201).json({ linked: true });
  });

  /**
   * Re-runs extraction against the current reports.
   *
   * Needed because documents often arrive BEFORE the pickup report they relate
   * to, and at that point there is nothing to link them to.
   */
  app.post('/v1/documents/:id/relink', authenticate, require('supervisor'), (req, res) => {
    const result = relinkDocument(db, req.user!.orgId, String(req.params.id));
    if (!result) return fail(res, 409, 'NO_TEXT', 'Document has no extracted text to link from');
    res.json(result);
  });

  app.get('/v1/documents/for/:entityType/:entityId', authenticate, (req, res) => {
    const entityType = String(req.params.entityType);
    if (!['container', 'vin', 'delivery_order', 'pickup_report', 'booking'].includes(entityType)) {
      return fail(res, 400, 'INVALID_INPUT', 'Unknown entity type');
    }
    res.json({
      documents: documentsFor(db, req.user!.orgId, entityType as never, String(req.params.entityId)),
    });
  });

  /* ---------------------------------------------------------------- *
   * Text recognition
   * ---------------------------------------------------------------- */

  /** Recognition state for one document, including what its text linked to. */
  app.get('/v1/documents/:id/ocr', authenticate, (req, res) => {
    const job = latestOcrJob(db, req.user!.orgId, String(req.params.id));
    if (!job) return fail(res, 404, 'NOT_FOUND', 'No recognition attempted for this document');
    res.json(job);
  });

  /**
   * Forces a fresh recognition pass.
   *
   * Useful after switching provider, or when a first pass produced nothing
   * usable from a poor scan that has since been re-photographed.
   */
  app.post('/v1/documents/:id/ocr', authenticate, require('supervisor'), (req, res) => {
    const result = requeueOcr(db, req.user!.orgId, String(req.params.id));
    if (!result.queued) return fail(res, 409, result.reason ?? 'CANNOT_QUEUE', 'Cannot queue recognition');
    res.status(202).json({ queued: true });
  });

  /**
   * Runs the queue now instead of waiting for the interval.
   *
   * Exists because "upload a document and see it link" should not require a
   * 30-second wait in a demo or a test.
   */
  app.post('/v1/admin/ocr/run', authenticate, require('supervisor'), wrap(async (req, res) => {
    res.json(await runOcrWorker(db, { limit: Math.min(Number(req.body?.limit ?? 10), 50) }));
  }));

  app.get('/v1/admin/ocr-jobs', authenticate, require('supervisor'), (req, res) => {
    res.json({
      jobs: listOcrJobs(db, req.user!.orgId, Number(req.query.limit ?? 50)),
      recognisableTypes: ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/tiff']
        .filter(isRecognisable),
    });
  });

  /* ---------------------------------------------------------------- *
   * Container dossier
   * ---------------------------------------------------------------- */

  /**
   * Everything known about one container: the vehicles that belong in it, which
   * are confirmed aboard with verified photographs, and whether the paperwork is
   * complete. The answer to "can this ship?".
   */
  app.get('/v1/containers/:containerNo/dossier', authenticate, (req, res) => {
    const dossier = buildDossier(db, req.user!.orgId, String(req.params.containerNo));
    if (!dossier) return fail(res, 404, 'NOT_FOUND', 'Container not on any active report');
    res.json(dossier);
  });

  const requirementSchema = z.object({
    docType: z.enum(DOC_TYPES),
    requiredAt: z.string().max(40).optional(),
  });

  app.post('/v1/admin/document-requirements', authenticate, require('admin'), (req, res) => {
    const parsed = requirementSchema.safeParse(req.body);
    if (!parsed.success) return fail(res, 400, 'INVALID_INPUT', 'Bad requirement payload');

    const id = newId();
    db.prepare(
      `INSERT OR IGNORE INTO document_requirements (id, org_id, doc_type, required_at)
       VALUES (?,?,?,?)`,
    ).run(id, req.user!.orgId, parsed.data.docType, parsed.data.requiredAt ?? 'before_dispatch');

    res.status(201).json({ id });
  });

  app.get('/v1/admin/document-requirements', authenticate, require('supervisor'), (req, res) => {
    res.json({
      requirements: db
        .prepare('SELECT * FROM document_requirements WHERE org_id = ? ORDER BY doc_type')
        .all(req.user!.orgId),
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
