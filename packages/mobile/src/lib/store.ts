/**
 * On-device store.
 *
 * Holds the cached pickup report so reconciliation works with no network, and
 * the outbound queue so nothing is lost when sync fails. Both matter: a gate
 * with no signal is the normal case, not the exception.
 */

import * as SQLite from 'expo-sqlite';
import type { PickupReportLine } from '@dp/shared-rules';

const DB_NAME = 'dp-reconcile.db';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

export function getDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = SQLite.openDatabaseAsync(DB_NAME).then(async (db) => {
      await db.execAsync(`
        PRAGMA journal_mode = WAL;

        CREATE TABLE IF NOT EXISTS cached_report (
          id            TEXT PRIMARY KEY,
          location_id   TEXT NOT NULL,
          reference_no  TEXT NOT NULL,
          version       INTEGER NOT NULL,
          valid_from    TEXT NOT NULL,
          valid_to      TEXT NOT NULL,
          synced_at     TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS cached_lines (
          id            TEXT PRIMARY KEY,
          report_id     TEXT NOT NULL,
          line_no       INTEGER NOT NULL,
          container_no  TEXT NOT NULL,
          vin           TEXT NOT NULL,
          make          TEXT,
          model         TEXT,
          variant       TEXT,
          colour        TEXT,
          load_position INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_cached_container ON cached_lines (container_no);
        CREATE INDEX IF NOT EXISTS idx_cached_vin ON cached_lines (vin);

        /* VINs known to be loaded — from the server, plus our own local MATCHes
           so the duplicate check works before the queue has drained. */
        CREATE TABLE IF NOT EXISTS loaded_vins (
          vin       TEXT PRIMARY KEY,
          source    TEXT NOT NULL,
          added_at  TEXT NOT NULL
        );

        /* The outbound queue. A row survives app restarts and bad connections
           until the server acknowledges it. */
        CREATE TABLE IF NOT EXISTS queued_sessions (
          id              TEXT PRIMARY KEY,
          location_id     TEXT NOT NULL,
          started_at      TEXT NOT NULL,
          payload_json    TEXT NOT NULL,
          device_outcome  TEXT,
          attempts        INTEGER NOT NULL DEFAULT 0,
          last_error      TEXT,
          last_attempt_at TEXT,
          synced_at       TEXT,
          created_at      TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_queue_pending
          ON queued_sessions (synced_at) WHERE synced_at IS NULL;

        /* Evidence images, queued separately from the session that described
           them. Metadata must reach the server first — it carries the verdict
           and triggers the email — so bytes follow on their own schedule and a
           stalled image never holds up a reconciliation. */
        CREATE TABLE IF NOT EXISTS queued_images (
          scan_id        TEXT PRIMARY KEY,
          session_id     TEXT NOT NULL,
          local_uri      TEXT NOT NULL,
          sha256         TEXT NOT NULL,
          bytes          INTEGER NOT NULL,
          content_type   TEXT NOT NULL,
          upload_url     TEXT,
          url_expires_at TEXT,
          state          TEXT NOT NULL DEFAULT 'awaiting_url',
          attempts       INTEGER NOT NULL DEFAULT 0,
          last_error     TEXT,
          created_at     TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_images_state ON queued_images (state);
      `);
      return db;
    });
  }
  return dbPromise;
}

/* ------------------------------------------------------------------ *
 * Cached report
 * ------------------------------------------------------------------ */

export interface CachedReport {
  id: string;
  referenceNo: string;
  version: number;
  validFrom: string;
  validTo: string;
  syncedAt: string;
}

export async function saveReport(
  locationId: string,
  report: {
    id: string;
    reference_no: string;
    version: number;
    valid_from: string;
    valid_to: string;
  },
  lines: Record<string, unknown>[],
  loadedVins: string[],
): Promise<void> {
  const db = await getDb();

  await db.withTransactionAsync(async () => {
    // Replace wholesale. A partial cache is worse than none — it would produce
    // confident VIN_NOT_IN_REPORT verdicts for vehicles that are on the report.
    await db.runAsync('DELETE FROM cached_lines');
    await db.runAsync('DELETE FROM cached_report');
    await db.runAsync(`DELETE FROM loaded_vins WHERE source = 'server'`);

    await db.runAsync(
      `INSERT INTO cached_report (id, location_id, reference_no, version, valid_from, valid_to, synced_at)
       VALUES (?,?,?,?,?,?,?)`,
      [report.id, locationId, report.reference_no, report.version,
       report.valid_from, report.valid_to, new Date().toISOString()],
    );

    for (const line of lines) {
      await db.runAsync(
        `INSERT INTO cached_lines (id, report_id, line_no, container_no, vin, make, model,
                                   variant, colour, load_position)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [String(line.id), report.id, Number(line.line_no), String(line.container_no),
         String(line.vin), (line.make as string) ?? null, (line.model as string) ?? null,
         (line.variant as string) ?? null, (line.colour as string) ?? null,
         line.load_position == null ? null : Number(line.load_position)],
      );
    }

    for (const vin of loadedVins) {
      await db.runAsync(
        `INSERT OR REPLACE INTO loaded_vins (vin, source, added_at) VALUES (?, 'server', ?)`,
        [vin, new Date().toISOString()],
      );
    }
  });
}

export async function getCachedReport(): Promise<CachedReport | null> {
  const db = await getDb();
  const row = await db.getFirstAsync<Record<string, unknown>>('SELECT * FROM cached_report LIMIT 1');
  if (!row) return null;

  return {
    id: String(row.id),
    referenceNo: String(row.reference_no),
    version: Number(row.version),
    validFrom: String(row.valid_from),
    validTo: String(row.valid_to),
    syncedAt: String(row.synced_at),
  };
}

export async function getCachedLines(): Promise<PickupReportLine[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>('SELECT * FROM cached_lines ORDER BY line_no');

  return rows.map((row) => ({
    id: String(row.id),
    reportId: String(row.report_id),
    lineNo: Number(row.line_no),
    containerNo: String(row.container_no),
    vin: String(row.vin),
    make: (row.make as string) ?? undefined,
    model: (row.model as string) ?? undefined,
    variant: (row.variant as string) ?? undefined,
    colour: (row.colour as string) ?? undefined,
    loadPosition: row.load_position == null ? undefined : Number(row.load_position),
  }));
}

export async function getLoadedVins(): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.getAllAsync<{ vin: string }>('SELECT vin FROM loaded_vins');
  return new Set(rows.map((row) => row.vin));
}

/** Records a local MATCH so the duplicate check holds before the queue drains. */
export async function markLoadedLocally(vin: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO loaded_vins (vin, source, added_at) VALUES (?, 'local', ?)`,
    [vin, new Date().toISOString()],
  );
}

/* ------------------------------------------------------------------ *
 * Outbound queue
 * ------------------------------------------------------------------ */

export interface QueuedSession {
  id: string;
  locationId: string;
  startedAt: string;
  payload: unknown;
  deviceOutcome: string | null;
  attempts: number;
  lastError: string | null;
}

export async function enqueueSession(session: {
  id: string;
  locationId: string;
  startedAt: string;
  payload: unknown;
  deviceOutcome: string | null;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO queued_sessions
       (id, location_id, started_at, payload_json, device_outcome, created_at)
     VALUES (?,?,?,?,?,?)`,
    [session.id, session.locationId, session.startedAt, JSON.stringify(session.payload),
     session.deviceOutcome, new Date().toISOString()],
  );
}

export async function getPendingSessions(limit = 50): Promise<QueuedSession[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM queued_sessions WHERE synced_at IS NULL ORDER BY created_at LIMIT ?`,
    [limit],
  );

  return rows.map((row) => ({
    id: String(row.id),
    locationId: String(row.location_id),
    startedAt: String(row.started_at),
    payload: JSON.parse(String(row.payload_json)),
    deviceOutcome: (row.device_outcome as string) ?? null,
    attempts: Number(row.attempts),
    lastError: (row.last_error as string) ?? null,
  }));
}

export async function markSynced(id: string): Promise<void> {
  const db = await getDb();
  await db.runAsync('UPDATE queued_sessions SET synced_at = ? WHERE id = ?',
    [new Date().toISOString(), id]);
}

export async function markFailed(id: string, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE queued_sessions
        SET attempts = attempts + 1, last_error = ?, last_attempt_at = ?
      WHERE id = ?`,
    [error.slice(0, 500), new Date().toISOString(), id],
  );
}

export async function pendingCount(): Promise<number> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ n: number }>(
    'SELECT COUNT(*) AS n FROM queued_sessions WHERE synced_at IS NULL',
  );
  return row?.n ?? 0;
}

/* ------------------------------------------------------------------ *
 * Evidence image queue
 * ------------------------------------------------------------------ */

/**
 * awaiting_url — declared locally, no upload URL yet (session not synced)
 * ready       — has a URL, bytes not delivered
 * verified    — the server confirmed the hash; local file can go
 * failed      — retries exhausted; needs a human to look
 */
export type ImageState = 'awaiting_url' | 'ready' | 'verified' | 'failed';

/** Retries before giving up. Beyond this it is not a transient fault. */
export const MAX_IMAGE_ATTEMPTS = 6;

export interface QueuedImage {
  scanId: string;
  sessionId: string;
  localUri: string;
  sha256: string;
  bytes: number;
  contentType: string;
  uploadUrl: string | null;
  urlExpiresAt: string | null;
  state: ImageState;
  attempts: number;
}

export async function enqueueImage(image: {
  scanId: string;
  sessionId: string;
  localUri: string;
  sha256: string;
  bytes: number;
  contentType: string;
}): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `INSERT OR REPLACE INTO queued_images
       (scan_id, session_id, local_uri, sha256, bytes, content_type, state, created_at)
     VALUES (?,?,?,?,?,?,'awaiting_url',?)`,
    [image.scanId, image.sessionId, image.localUri, image.sha256, image.bytes,
     image.contentType, new Date().toISOString()],
  );
}

/** Records the URL the server handed back with the session response. */
export async function attachUploadUrl(
  scanId: string,
  upload: { url: string; expiresAt: string },
): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE queued_images
        SET upload_url = ?, url_expires_at = ?, state = 'ready'
      WHERE scan_id = ? AND state <> 'verified'`,
    [upload.url, upload.expiresAt, scanId],
  );
}

const toQueuedImage = (row: Record<string, unknown>): QueuedImage => ({
  scanId: String(row.scan_id),
  sessionId: String(row.session_id),
  localUri: String(row.local_uri),
  sha256: String(row.sha256),
  bytes: Number(row.bytes),
  contentType: String(row.content_type),
  uploadUrl: (row.upload_url as string) ?? null,
  urlExpiresAt: (row.url_expires_at as string) ?? null,
  state: String(row.state) as ImageState,
  attempts: Number(row.attempts),
});

/** Images still owed to the server, oldest first. */
export async function getPendingImages(limit = 20): Promise<QueuedImage[]> {
  const db = await getDb();
  const rows = await db.getAllAsync<Record<string, unknown>>(
    `SELECT * FROM queued_images
      WHERE state IN ('awaiting_url','ready') AND attempts < ?
      ORDER BY created_at LIMIT ?`,
    [MAX_IMAGE_ATTEMPTS, limit],
  );
  return rows.map(toQueuedImage);
}

export async function markImageVerified(scanId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(`UPDATE queued_images SET state = 'verified' WHERE scan_id = ?`, [scanId]);
}

export async function markImageAttemptFailed(scanId: string, error: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE queued_images
        SET attempts = attempts + 1,
            last_error = ?,
            state = CASE WHEN attempts + 1 >= ? THEN 'failed' ELSE state END
      WHERE scan_id = ?`,
    [error.slice(0, 500), MAX_IMAGE_ATTEMPTS, scanId],
  );
}

/** Forces a fresh URL to be requested on the next drain. */
export async function invalidateUploadUrl(scanId: string): Promise<void> {
  const db = await getDb();
  await db.runAsync(
    `UPDATE queued_images SET upload_url = NULL, url_expires_at = NULL, state = 'awaiting_url'
      WHERE scan_id = ? AND state <> 'verified'`,
    [scanId],
  );
}

export interface ImageQueueStats {
  pending: number;
  failed: number;
}

export async function imageQueueStats(): Promise<ImageQueueStats> {
  const db = await getDb();
  const row = await db.getFirstAsync<{ pending: number; failed: number }>(
    `SELECT
       SUM(CASE WHEN state IN ('awaiting_url','ready') THEN 1 ELSE 0 END) AS pending,
       SUM(CASE WHEN state = 'failed' THEN 1 ELSE 0 END) AS failed
     FROM queued_images`,
  );
  return { pending: row?.pending ?? 0, failed: row?.failed ?? 0 };
}
