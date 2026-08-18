/**
 * Evidence image lifecycle.
 *
 *   1. Device submits scan metadata. The reconciliation completes and the email
 *      fires immediately — it does not wait on bytes.
 *   2. Server derives an object key and mints a short-lived upload URL.
 *   3. Device PUTs the bytes straight at the store.
 *   4. Device calls finalize. The server compares the stored bytes against the
 *      hash the device declared BEFORE uploading.
 *
 * Step 4 is the point of the whole design. A hash the device committed to in
 * advance, checked against what actually landed, is what makes the image
 * defensible later: it detects truncation and corruption, and it means a
 * substituted image cannot silently pass as the original.
 *
 * What it is not: proof against a malicious device, which could simply declare
 * the hash of whatever it intends to upload. Defending against that needs
 * signed capture attestation, which is out of scope here — the GPS, timestamp,
 * device binding and officer identity on the record are the mitigations.
 */

import { type Db, newId, nowIso } from '../lib/db.ts';
import {
  getStorage,
  evidenceKey,
  ALLOWED_CONTENT_TYPES,
  MAX_IMAGE_BYTES,
  type PresignedUpload,
} from '../lib/storage.ts';

/** Upload URLs are short-lived: the device is expected to use them at once. */
export const UPLOAD_TTL_SECONDS = 60 * 60;

/** Viewing links last long enough to survive an email sitting in an inbox. */
export const VIEW_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface ScanImageDeclaration {
  scanId: string;
  sha256: string;
  contentType: string;
  bytes: number;
}

export type PresignRejection =
  | 'UNKNOWN_SCAN'
  | 'UNSUPPORTED_CONTENT_TYPE'
  | 'IMAGE_TOO_LARGE'
  | 'MALFORMED_SHA256'
  | 'ALREADY_VERIFIED';

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * Records what the device says it is about to upload, and returns a URL for it.
 *
 * The declaration is stored first so the expected hash exists independently of
 * the upload. Recording it afterwards would let the device report whatever hash
 * matched what it happened to send.
 */
export async function presignScanImage(
  db: Db,
  orgId: string,
  declaration: ScanImageDeclaration,
): Promise<{ ok: true; upload: PresignedUpload; key: string } | { ok: false; reason: PresignRejection }> {
  const scan = db
    .prepare(
      `SELECT s.id, s.captured_at, s.image_verified
         FROM scans s
         JOIN scan_sessions ss ON ss.id = s.session_id
        WHERE s.id = ? AND ss.org_id = ?`,
    )
    .get(declaration.scanId, orgId) as
    | { id: string; captured_at: string; image_verified: number }
    | undefined;

  if (!scan) return { ok: false, reason: 'UNKNOWN_SCAN' };

  // Re-presigning a verified image would allow overwriting settled evidence.
  if (scan.image_verified) return { ok: false, reason: 'ALREADY_VERIFIED' };

  if (!ALLOWED_CONTENT_TYPES.has(declaration.contentType)) {
    return { ok: false, reason: 'UNSUPPORTED_CONTENT_TYPE' };
  }
  if (declaration.bytes <= 0 || declaration.bytes > MAX_IMAGE_BYTES) {
    return { ok: false, reason: 'IMAGE_TOO_LARGE' };
  }
  if (!SHA256_PATTERN.test(declaration.sha256)) {
    return { ok: false, reason: 'MALFORMED_SHA256' };
  }

  const key = evidenceKey({
    orgId,
    scanId: scan.id,
    capturedAt: scan.captured_at,
    contentType: declaration.contentType,
  });

  db.prepare(
    `UPDATE scans
        SET image_key = ?, image_sha256 = ?, image_content_type = ?, image_bytes = ?,
            image_uploaded_at = NULL, image_verified = 0
      WHERE id = ?`,
  ).run(key, declaration.sha256, declaration.contentType, declaration.bytes, scan.id);

  const upload = await getStorage().presignPut(key, declaration.contentType, UPLOAD_TTL_SECONDS);
  return { ok: true, upload, key };
}

/**
 * Mints a fresh upload URL for an already-declared image.
 *
 * Upload URLs expire in an hour. A device that is offline for longer — a night
 * shift at a yard with no signal is entirely normal — would otherwise hold a
 * dead URL for an image it can never deliver, and the evidence would be lost
 * with no way to recover it.
 *
 * The declaration is NOT re-accepted here: the hash, size and content type come
 * from the row committed earlier. Letting the device restate them would defeat
 * the point of declaring up front.
 */
export async function refreshScanUploadUrl(
  db: Db,
  orgId: string,
  scanId: string,
): Promise<{ ok: true; upload: PresignedUpload } | { ok: false; reason: PresignRejection }> {
  const scan = db
    .prepare(
      `SELECT s.id, s.image_key, s.image_content_type, s.image_verified
         FROM scans s
         JOIN scan_sessions ss ON ss.id = s.session_id
        WHERE s.id = ? AND ss.org_id = ?`,
    )
    .get(scanId, orgId) as
    | { id: string; image_key: string | null; image_content_type: string | null; image_verified: number }
    | undefined;

  if (!scan) return { ok: false, reason: 'UNKNOWN_SCAN' };
  if (scan.image_verified) return { ok: false, reason: 'ALREADY_VERIFIED' };
  if (!scan.image_key || !scan.image_content_type) return { ok: false, reason: 'UNKNOWN_SCAN' };

  const upload = await getStorage().presignPut(
    scan.image_key,
    scan.image_content_type,
    UPLOAD_TTL_SECONDS,
  );
  return { ok: true, upload };
}

export type FinalizeResult =
  | { status: 'verified'; bytes: number }
  | { status: 'missing' }
  | { status: 'hash_mismatch'; expected: string; actual: string }
  | { status: 'size_mismatch'; expected: number; actual: number }
  | { status: 'unknown_scan' }
  | { status: 'no_declaration' };

/**
 * Confirms an upload landed intact.
 *
 * A mismatch is recorded, never thrown away: an image that failed verification
 * is worse than no image, because it looks like evidence. The scan stays
 * unverified and the discrepancy is auditable.
 */
export async function finalizeScanImage(
  db: Db,
  orgId: string,
  scanId: string,
  actorId: string,
): Promise<FinalizeResult> {
  const scan = db
    .prepare(
      `SELECT s.id, s.image_key, s.image_sha256, s.image_bytes
         FROM scans s
         JOIN scan_sessions ss ON ss.id = s.session_id
        WHERE s.id = ? AND ss.org_id = ?`,
    )
    .get(scanId, orgId) as
    | { id: string; image_key: string | null; image_sha256: string | null; image_bytes: number | null }
    | undefined;

  if (!scan) return { status: 'unknown_scan' };
  if (!scan.image_key || !scan.image_sha256) return { status: 'no_declaration' };

  const stored = await getStorage().stat(scan.image_key);
  if (!stored) return { status: 'missing' };

  const record = (action: string) =>
    db.prepare(
      `INSERT INTO evidence_access_log (id, org_id, actor_id, scan_id, action, created_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(newId(), orgId, actorId, scanId, action, nowIso());

  if (stored.sha256 !== scan.image_sha256) {
    record('verify_failed_hash');
    return { status: 'hash_mismatch', expected: scan.image_sha256, actual: stored.sha256 };
  }

  if (scan.image_bytes != null && stored.bytes !== scan.image_bytes) {
    record('verify_failed_size');
    return { status: 'size_mismatch', expected: scan.image_bytes, actual: stored.bytes };
  }

  db.prepare('UPDATE scans SET image_uploaded_at = ?, image_verified = 1 WHERE id = ?')
    .run(nowIso(), scanId);
  record('verified');

  return { status: 'verified', bytes: stored.bytes };
}

export interface EvidenceItem {
  scanId: string;
  scanType: string;
  finalValue: string;
  capturedAt: string;
  verified: boolean;
  bytes: number | null;
  sha256: string | null;
  gps: { lat: number; lng: number; accuracyM: number | null } | null;
  url: string | null;
  expiresAt: string | null;
}

/**
 * Viewing links for a reconciliation's images.
 *
 * Every issue is logged. "Who has seen this evidence" is a question that gets
 * asked in a dispute, and it cannot be answered retroactively.
 */
export async function evidenceForReconciliation(
  db: Db,
  orgId: string,
  reconciliationId: string,
  actor: { id: string; ip?: string | null },
): Promise<EvidenceItem[] | null> {
  const reconciliation = db
    .prepare('SELECT id, session_id FROM reconciliations WHERE id = ? AND org_id = ?')
    .get(reconciliationId, orgId) as { id: string; session_id: string } | undefined;

  if (!reconciliation) return null;

  const scans = db
    .prepare(
      `SELECT id, scan_type, final_value, captured_at, image_key, image_sha256,
              image_bytes, image_verified, gps_lat, gps_lng, gps_accuracy_m
         FROM scans WHERE session_id = ? ORDER BY scan_type`,
    )
    .all(reconciliation.session_id) as Record<string, unknown>[];

  const storage = getStorage();
  const items: EvidenceItem[] = [];

  for (const scan of scans) {
    const key = scan.image_key as string | null;

    // Unverified images are listed but not linked. Serving one as evidence
    // would misrepresent its standing.
    const verified = Boolean(scan.image_verified);
    let url: string | null = null;
    let expiresAt: string | null = null;

    if (key && verified) {
      const signed = await storage.presignGet(key, VIEW_TTL_SECONDS);
      url = signed.url;
      expiresAt = signed.expiresAt;

      db.prepare(
        `INSERT INTO evidence_access_log (id, org_id, actor_id, scan_id, reconciliation_id,
                                          action, ip, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      ).run(newId(), orgId, actor.id, String(scan.id), reconciliationId, 'presign_view',
            actor.ip ?? null, nowIso());
    }

    items.push({
      scanId: String(scan.id),
      scanType: String(scan.scan_type),
      finalValue: String(scan.final_value),
      capturedAt: String(scan.captured_at),
      verified,
      bytes: scan.image_bytes == null ? null : Number(scan.image_bytes),
      sha256: (scan.image_sha256 as string) ?? null,
      gps: scan.gps_lat == null || scan.gps_lng == null
        ? null
        : {
            lat: Number(scan.gps_lat),
            lng: Number(scan.gps_lng),
            accuracyM: scan.gps_accuracy_m == null ? null : Number(scan.gps_accuracy_m),
          },
      url,
      expiresAt,
    });
  }

  return items;
}

/**
 * Scans whose images were declared but never verified.
 *
 * An operational metric, not a curiosity: a reconciliation without a verified
 * image is a decision with no picture behind it, and a rising count usually
 * means devices are out of storage or the upload path is broken.
 */
export function missingEvidence(db: Db, orgId: string, limit = 100) {
  return db
    .prepare(
      `SELECT s.id AS scan_id, s.scan_type, s.final_value, s.captured_at,
              s.image_key IS NOT NULL AS declared, ss.officer_id
         FROM scans s
         JOIN scan_sessions ss ON ss.id = s.session_id
        WHERE ss.org_id = ? AND s.image_verified = 0
        ORDER BY s.captured_at DESC
        LIMIT ?`,
    )
    .all(orgId, limit);
}
