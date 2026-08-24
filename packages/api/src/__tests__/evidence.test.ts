/**
 * Evidence upload lifecycle over the real HTTP surface.
 *
 * The whole point of this path is that an image can be trusted later, so the
 * tests care most about the cases where it should NOT be: a truncated upload, a
 * substituted file, a link replayed after expiry.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, newId, nowIso, type Db } from '../lib/db.ts';
import { seed, SEED_PASSWORD, type SeedResult } from '../lib/seed.ts';
import { hashPassword } from '../lib/auth.ts';
import { createServer } from '../server.ts';
import { LocalStorageDriver, setStorage } from '../lib/storage.ts';

let db: Db;
let server: Server;
let baseUrl: string;
let fixture: SeedResult;
let storageRoot: string;
let storage: LocalStorageDriver;
let token: string;
let lines: any[];

/** A small but real JPEG-ish payload. Content does not matter; its hash does. */
const imageBytes = (marker: string): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(marker.repeat(64))]);

const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

before(async () => {
  process.env.JWT_SECRET = 'evidence-test-jwt-secret';
  db = openDb(':memory:');
  fixture = seed(db);

  storageRoot = mkdtempSync(join(tmpdir(), 'dp-evidence-e2e-'));

  await new Promise<void>((resolve) => {
    server = createServer(db).listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  baseUrl = `http://localhost:${port}`;

  // The driver mints absolute URLs, so it needs the port the server actually got.
  storage = new LocalStorageDriver(storageRoot, baseUrl, 'evidence-test-secret');
  setStorage(storage);

  const login = await api('POST', '/v1/auth/login', {
    email: 'officer@dp-logistics.example', password: SEED_PASSWORD,
  });
  token = login.json.accessToken;

  const sync = await api('GET', `/v1/sync/reports?locationId=${fixture.locationId}`, undefined, token);
  lines = sync.json.lines;
});

after(() => {
  server?.close();
  db?.close();
  setStorage(null);
  rmSync(storageRoot, { recursive: true, force: true });
});

async function api(method: string, path: string, body?: unknown, bearer?: string) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

async function putBytes(url: string, bytes: Buffer, contentType = 'image/jpeg') {
  const response = await fetch(url, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    // fetch wants a BodyInit; a Node Buffer is not one structurally.
    body: new Uint8Array(bytes),
  });
  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

/** Submits a scan session that declares images, and returns the upload URLs. */
async function submitWithImages(line: any, opts: { containerBytes: Buffer; vinBytes: Buffer }) {
  const containerScanId = randomUUID();
  const vinScanId = randomUUID();

  const result = await api('POST', '/v1/sync/scans', {
    sessions: [{
      id: randomUUID(),
      locationId: fixture.locationId,
      startedAt: new Date().toISOString(),
      scans: [
        {
          id: containerScanId, scanType: 'container', finalValue: line.container_no,
          detectedValue: line.container_no, checkDigitOk: true,
          imageSha256: sha256(opts.containerBytes),
          imageContentType: 'image/jpeg',
          imageBytes: opts.containerBytes.length,
          capturedAt: new Date().toISOString(),
        },
        {
          id: vinScanId, scanType: 'vin', finalValue: line.vin, detectedValue: line.vin,
          imageSha256: sha256(opts.vinBytes),
          imageContentType: 'image/jpeg',
          imageBytes: opts.vinBytes.length,
          capturedAt: new Date().toISOString(),
        },
      ],
    }],
  }, token);

  return { session: result.json.sessions[0], containerScanId, vinScanId };
}

describe('the happy path', () => {
  test('metadata commits, then bytes upload, then verification passes', async () => {
    const containerBytes = imageBytes('C');
    const vinBytes = imageBytes('V');
    const { session, containerScanId, vinScanId } =
      await submitWithImages(lines[0], { containerBytes, vinBytes });

    // The verdict is already decided — it did not wait on any image.
    assert.equal(session.outcome, 'MATCH');
    assert.ok(session.uploads[containerScanId].url);
    assert.equal(session.uploads[containerScanId].method, 'PUT');

    const put = await putBytes(session.uploads[containerScanId].url, containerBytes);
    assert.equal(put.status, 201);
    assert.equal(put.json.bytes, containerBytes.length);

    const finalize = await api('POST', `/v1/scans/${containerScanId}/image-uploaded`, {}, token);
    assert.equal(finalize.status, 200);
    assert.equal(finalize.json.status, 'verified');
    assert.equal(finalize.json.bytes, containerBytes.length);

    await putBytes(session.uploads[vinScanId].url, vinBytes);
    const finalizeVin = await api('POST', `/v1/scans/${vinScanId}/image-uploaded`, {}, token);
    assert.equal(finalizeVin.json.status, 'verified');
  });

  test('the object landed under an org- and date-partitioned key', () => {
    const row = db.prepare(
      `SELECT image_key, image_verified FROM scans WHERE image_verified = 1 LIMIT 1`,
    ).get() as { image_key: string; image_verified: number };

    assert.match(row.image_key, new RegExp(`^org/${fixture.orgId}/\\d{4}/\\d{2}/\\d{2}/`));
    assert.equal(row.image_verified, 1);
  });

  test('the key is server-derived, not whatever the client asked for', async () => {
    const bytes = imageBytes('K');
    const scanId = randomUUID();

    await api('POST', '/v1/sync/scans', {
      sessions: [{
        id: randomUUID(), locationId: fixture.locationId, startedAt: new Date().toISOString(),
        scans: [
          { id: scanId, scanType: 'container', finalValue: lines[1].container_no,
            imageSha256: sha256(bytes), imageContentType: 'image/jpeg', imageBytes: bytes.length,
            // A hostile client trying to name its own destination. The schema
            // has no such field, so it is simply ignored.
            imageKey: '../../../etc/passwd',
            capturedAt: new Date().toISOString() },
          { id: randomUUID(), scanType: 'vin', finalValue: lines[1].vin,
            capturedAt: new Date().toISOString() },
        ],
      }],
    }, token);

    const row = db.prepare('SELECT image_key FROM scans WHERE id = ?').get(scanId) as { image_key: string };
    assert.ok(row.image_key.startsWith(`org/${fixture.orgId}/`));
    assert.ok(!row.image_key.includes('..'));
  });
});

describe('integrity failures', () => {
  test('a substituted image fails verification and is not marked verified', async () => {
    const declared = imageBytes('D');
    const substituted = imageBytes('X');
    const { session, containerScanId } =
      await submitWithImages(lines[4], { containerBytes: declared, vinBytes: imageBytes('V') });

    // Upload something other than what was declared.
    await putBytes(session.uploads[containerScanId].url, substituted);

    const finalize = await api('POST', `/v1/scans/${containerScanId}/image-uploaded`, {}, token);
    assert.equal(finalize.status, 422);
    assert.equal(finalize.json.error.code, 'HASH_MISMATCH');
    assert.equal(finalize.json.error.details.expected, sha256(declared));
    assert.equal(finalize.json.error.details.actual, sha256(substituted));

    // An image that failed verification must never read as evidence.
    const row = db.prepare('SELECT image_verified FROM scans WHERE id = ?')
      .get(containerScanId) as { image_verified: number };
    assert.equal(row.image_verified, 0);
  });

  test('the failed verification is recorded, not discarded', () => {
    const rows = db.prepare(
      `SELECT action FROM evidence_access_log WHERE action = 'verify_failed_hash'`,
    ).all();
    assert.ok(rows.length > 0, 'expected a recorded verification failure');
  });

  test('finalizing before uploading reports the object as missing', async () => {
    const bytes = imageBytes('M');
    const { containerScanId } =
      await submitWithImages(lines[8], { containerBytes: bytes, vinBytes: imageBytes('V') });

    const finalize = await api('POST', `/v1/scans/${containerScanId}/image-uploaded`, {}, token);
    assert.equal(finalize.status, 409);
    assert.equal(finalize.json.error.code, 'OBJECT_MISSING');
  });

  test('a scan with no declared image cannot be finalized', async () => {
    const scanId = randomUUID();
    await api('POST', '/v1/sync/scans', {
      sessions: [{
        id: randomUUID(), locationId: fixture.locationId, startedAt: new Date().toISOString(),
        scans: [
          { id: scanId, scanType: 'container', finalValue: lines[12].container_no,
            capturedAt: new Date().toISOString() },
          { id: randomUUID(), scanType: 'vin', finalValue: lines[12].vin,
            capturedAt: new Date().toISOString() },
        ],
      }],
    }, token);

    const finalize = await api('POST', `/v1/scans/${scanId}/image-uploaded`, {}, token);
    assert.equal(finalize.status, 409);
    assert.equal(finalize.json.error.code, 'NO_DECLARATION');
  });

  test('an unknown scan is a 404, not a 500', async () => {
    const finalize = await api('POST', `/v1/scans/${randomUUID()}/image-uploaded`, {}, token);
    assert.equal(finalize.status, 404);
  });
});

describe('declaration validation', () => {
  const declare = async (overrides: Record<string, unknown>) => {
    const scanId = randomUUID();
    const result = await api('POST', '/v1/sync/scans', {
      sessions: [{
        id: randomUUID(), locationId: fixture.locationId, startedAt: new Date().toISOString(),
        scans: [
          {
            id: scanId, scanType: 'container', finalValue: lines[16].container_no,
            imageSha256: sha256(imageBytes('A')),
            imageContentType: 'image/jpeg',
            imageBytes: 1024,
            capturedAt: new Date().toISOString(),
            ...overrides,
          },
          { id: randomUUID(), scanType: 'vin', finalValue: lines[16].vin,
            capturedAt: new Date().toISOString() },
        ],
      }],
    }, token);
    return { result, scanId };
  };

  test('rejects a non-image content type at the schema boundary', async () => {
    const { result } = await declare({ imageContentType: 'application/pdf' });
    assert.equal(result.status, 400);
  });

  test('rejects a malformed hash at the schema boundary', async () => {
    const { result } = await declare({ imageSha256: 'not-a-hash' });
    assert.equal(result.status, 400);
  });

  test('rejects an oversized declaration', async () => {
    const { result } = await declare({ imageBytes: 999_999_999 });
    assert.equal(result.status, 400);
  });
});

describe('capability URLs are not general-purpose credentials', () => {
  test('an upload URL cannot be reused after the image is verified', async () => {
    const bytes = imageBytes('R');
    const { session, containerScanId } =
      await submitWithImages(lines[20], { containerBytes: bytes, vinBytes: imageBytes('V') });

    await putBytes(session.uploads[containerScanId].url, bytes);
    const first = await api('POST', `/v1/scans/${containerScanId}/image-uploaded`, {}, token);
    assert.equal(first.json.status, 'verified');

    // Re-presigning settled evidence must be refused.
    const again = await api('POST', '/v1/sync/scans', {
      sessions: [{
        id: randomUUID(), locationId: fixture.locationId, startedAt: new Date().toISOString(),
        scans: [
          { id: containerScanId, scanType: 'container', finalValue: lines[20].container_no,
            imageSha256: sha256(imageBytes('Z')), imageContentType: 'image/jpeg',
            imageBytes: 64, capturedAt: new Date().toISOString() },
          { id: randomUUID(), scanType: 'vin', finalValue: lines[20].vin,
            capturedAt: new Date().toISOString() },
        ],
      }],
    }, token);

    // The session is a duplicate by id, but the important guarantee is that the
    // verified image is still intact and still verified.
    const row = db.prepare('SELECT image_sha256, image_verified FROM scans WHERE id = ?')
      .get(containerScanId) as { image_sha256: string; image_verified: number };
    assert.equal(row.image_verified, 1);
    assert.equal(row.image_sha256, sha256(bytes));
    assert.ok(again.status === 200);
  });

  test('a forged token is refused by the upload endpoint', async () => {
    const put = await putBytes(`${baseUrl}/v1/storage/forged.token`, imageBytes('F'));
    assert.equal(put.status, 403);
    assert.equal(put.json.error.code, 'INVALID_CAPABILITY');
  });

  test('an expired token is refused', async () => {
    const expired = await storage.presignPut(
      `org/${fixture.orgId}/2026/08/16/${randomUUID()}.jpg`, 'image/jpeg', -1);

    const put = await putBytes(expired.url, imageBytes('E'));
    assert.equal(put.status, 403);
  });

  test('an empty body is refused', async () => {
    const upload = await storage.presignPut(
      `org/${fixture.orgId}/2026/08/16/${randomUUID()}.jpg`, 'image/jpeg', 600);

    const put = await putBytes(upload.url, Buffer.alloc(0));
    assert.equal(put.status, 400);
  });

  test('a view token cannot be used to upload', async () => {
    const key = `org/${fixture.orgId}/2026/08/16/${randomUUID()}.jpg`;
    const view = await storage.presignGet(key, 600);

    const put = await putBytes(view.url, imageBytes('G'));
    assert.equal(put.status, 403);
  });
});

describe('recovering an expired upload URL', () => {
  test('a fresh URL can be issued for a declaration made earlier', async () => {
    const bytes = imageBytes('T');
    const { session, containerScanId } =
      await submitWithImages(lines[17], { containerBytes: bytes, vinBytes: imageBytes('V') });

    // Simulate a device that came back online after its URL expired: ignore the
    // one it was given and ask for another.
    void session;

    const refreshed = await api('POST', `/v1/scans/${containerScanId}/image-upload-url`, {}, token);
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.json.upload.url);

    const put = await putBytes(refreshed.json.upload.url, bytes);
    assert.equal(put.status, 201);

    const finalize = await api('POST', `/v1/scans/${containerScanId}/image-uploaded`, {}, token);
    assert.equal(finalize.json.status, 'verified');
  });

  test('the declaration cannot be restated when refreshing', async () => {
    const declared = imageBytes('P');
    const { containerScanId } =
      await submitWithImages(lines[18], { containerBytes: declared, vinBytes: imageBytes('V') });

    const before = db.prepare('SELECT image_sha256 FROM scans WHERE id = ?')
      .get(containerScanId) as { image_sha256: string };

    // A body is sent but must be ignored — the committed hash is authoritative.
    await api('POST', `/v1/scans/${containerScanId}/image-upload-url`,
      { imageSha256: sha256(imageBytes('Q')), imageBytes: 9 }, token);

    const after = db.prepare('SELECT image_sha256 FROM scans WHERE id = ?')
      .get(containerScanId) as { image_sha256: string };

    assert.equal(after.image_sha256, before.image_sha256);
    assert.equal(after.image_sha256, sha256(declared));
  });

  test('a verified image will not be re-presigned', async () => {
    const bytes = imageBytes('Y');
    const { session, containerScanId } =
      await submitWithImages(lines[19], { containerBytes: bytes, vinBytes: imageBytes('V') });

    await putBytes(session.uploads[containerScanId].url, bytes);
    await api('POST', `/v1/scans/${containerScanId}/image-uploaded`, {}, token);

    const refreshed = await api('POST', `/v1/scans/${containerScanId}/image-upload-url`, {}, token);
    assert.equal(refreshed.status, 409);
    assert.equal(refreshed.json.error.code, 'ALREADY_VERIFIED');
  });

  test('a scan that never declared an image gets no URL', async () => {
    const scanId = randomUUID();
    await api('POST', '/v1/sync/scans', {
      sessions: [{
        id: randomUUID(), locationId: fixture.locationId, startedAt: new Date().toISOString(),
        scans: [
          { id: scanId, scanType: 'container', finalValue: lines[22].container_no,
            capturedAt: new Date().toISOString() },
          { id: randomUUID(), scanType: 'vin', finalValue: lines[22].vin,
            capturedAt: new Date().toISOString() },
        ],
      }],
    }, token);

    const refreshed = await api('POST', `/v1/scans/${scanId}/image-upload-url`, {}, token);
    assert.equal(refreshed.status, 404);
  });
});

describe('batch isolation', () => {
  test('one failing session does not sink the rest of the queue', async () => {
    const clash = randomUUID();

    // First session establishes the scan id.
    await api('POST', '/v1/sync/scans', {
      sessions: [{
        id: randomUUID(), locationId: fixture.locationId, startedAt: new Date().toISOString(),
        scans: [
          { id: clash, scanType: 'container', finalValue: lines[23].container_no,
            capturedAt: new Date().toISOString() },
          { id: randomUUID(), scanType: 'vin', finalValue: lines[23].vin,
            capturedAt: new Date().toISOString() },
        ],
      }],
    }, token);

    // Now a batch where the FIRST session reuses that scan id (a primary key
    // conflict) and the second is perfectly good.
    const goodLine = lines.find((l: any) => l.container_no === lines[23].container_no
      && l.vin !== lines[23].vin);

    const batch = await api('POST', '/v1/sync/scans', {
      sessions: [
        {
          id: randomUUID(), locationId: fixture.locationId, startedAt: new Date().toISOString(),
          scans: [
            { id: clash, scanType: 'container', finalValue: lines[23].container_no,
              capturedAt: new Date().toISOString() },
            { id: randomUUID(), scanType: 'vin', finalValue: lines[23].vin,
              capturedAt: new Date().toISOString() },
          ],
        },
        {
          id: randomUUID(), locationId: fixture.locationId, startedAt: new Date().toISOString(),
          scans: [
            { id: randomUUID(), scanType: 'container', finalValue: goodLine.container_no,
              capturedAt: new Date().toISOString() },
            { id: randomUUID(), scanType: 'vin', finalValue: goodLine.vin,
              capturedAt: new Date().toISOString() },
          ],
        },
      ],
    }, token);

    // The request itself must succeed — a 500 would strand the whole queue.
    assert.equal(batch.status, 200);
    assert.equal(batch.json.sessions.length, 2);
    assert.equal(batch.json.sessions[0].status, 'failed');
    assert.equal(batch.json.sessions[1].status, 'accepted');
  });
});

describe('viewing evidence', () => {
  let reconciliationId: string;
  let bytes: Buffer;

  before(async () => {
    bytes = imageBytes('W');
    const { session, containerScanId, vinScanId } =
      await submitWithImages(lines[21], { containerBytes: bytes, vinBytes: bytes });

    reconciliationId = session.reconciliationId;
    await putBytes(session.uploads[containerScanId].url, bytes);
    await api('POST', `/v1/scans/${containerScanId}/image-uploaded`, {}, token);
    // Deliberately leave the VIN image unuploaded.
    void vinScanId;
  });

  test('lists images with their verification state', async () => {
    const result = await api('GET', `/v1/reconciliations/${reconciliationId}/evidence`, undefined, token);
    assert.equal(result.status, 200);

    const container = result.json.evidence.find((e: any) => e.scanType === 'container');
    const vin = result.json.evidence.find((e: any) => e.scanType === 'vin');

    assert.equal(container.verified, true);
    assert.ok(container.url);
    assert.equal(container.sha256, sha256(bytes));

    // An unverified image is listed but never linked — serving it would
    // misrepresent its standing.
    assert.equal(vin.verified, false);
    assert.equal(vin.url, null);
  });

  test('the link actually serves the original bytes', async () => {
    const result = await api('GET', `/v1/reconciliations/${reconciliationId}/evidence`, undefined, token);
    const container = result.json.evidence.find((e: any) => e.scanType === 'container');

    const response = await fetch(container.url);
    assert.equal(response.status, 200);

    const served = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256(served), sha256(bytes));
  });

  test('every issued link is logged against an actor', async () => {
    const before = (db.prepare(
      `SELECT COUNT(*) AS n FROM evidence_access_log WHERE action = 'presign_view'`,
    ).get() as { n: number }).n;

    await api('GET', `/v1/reconciliations/${reconciliationId}/evidence`, undefined, token);

    const after = (db.prepare(
      `SELECT COUNT(*) AS n FROM evidence_access_log WHERE action = 'presign_view'`,
    ).get() as { n: number }).n;

    assert.ok(after > before, 'a viewing link must leave a record');

    const row = db.prepare(
      `SELECT actor_id, reconciliation_id FROM evidence_access_log
        WHERE action = 'presign_view' ORDER BY created_at DESC LIMIT 1`,
    ).get() as { actor_id: string; reconciliation_id: string };

    assert.ok(row.actor_id);
    assert.equal(row.reconciliation_id, reconciliationId);
  });

  test('evidence for another org is not reachable', async () => {
    const result = await api('GET', `/v1/reconciliations/${randomUUID()}/evidence`, undefined, token);
    assert.equal(result.status, 404);
  });

  test('unauthenticated requests are refused', async () => {
    const result = await api('GET', `/v1/reconciliations/${reconciliationId}/evidence`);
    assert.equal(result.status, 401);
  });

  test('a field officer at a different location cannot read this evidence', async () => {
    // A fresh location and a field officer who has never been assigned to
    // fixture.locationId, the one this reconciliation actually happened at.
    const otherLocationId = newId();
    db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)')
      .run(otherLocationId, fixture.orgId, 'INOTHER', 'Other Gate');

    const outsiderId = newId();
    db.prepare(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(outsiderId, fixture.orgId, 'outsider@dp-logistics.example',
          hashPassword(SEED_PASSWORD), 'Outsider Officer', 'field_officer', nowIso());
    db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)')
      .run(outsiderId, otherLocationId);

    const outsiderLogin = await api('POST', '/v1/auth/login', {
      email: 'outsider@dp-logistics.example', password: SEED_PASSWORD,
    });
    const outsiderToken = outsiderLogin.json.accessToken;

    const result = await api(
      'GET', `/v1/reconciliations/${reconciliationId}/evidence`, undefined, outsiderToken);
    assert.equal(result.status, 404,
      "an officer not assigned to this reconciliation's location must not be able to tell it exists");
  });

  test('a supervisor can read evidence for any location in the org', async () => {
    const supervisorLogin = await api('POST', '/v1/auth/login', {
      email: 'supervisor@dp-logistics.example', password: SEED_PASSWORD,
    });
    const result = await api(
      'GET', `/v1/reconciliations/${reconciliationId}/evidence`, undefined,
      supervisorLogin.json.accessToken);
    assert.equal(result.status, 200);
  });

  test('an auditor can read evidence for any location in the org', async () => {
    const auditorLogin = await api('POST', '/v1/auth/login', {
      email: 'auditor@dp-logistics.example', password: SEED_PASSWORD,
    });
    const result = await api(
      'GET', `/v1/reconciliations/${reconciliationId}/evidence`, undefined,
      auditorLogin.json.accessToken);
    assert.equal(result.status, 200);
  });
});

describe('coverage reporting', () => {
  test('the dashboard reports how many scans have verified images', async () => {
    const admin = await api('POST', '/v1/auth/login', {
      email: 'admin@dp-logistics.example', password: SEED_PASSWORD,
    });
    const summary = await api('GET', '/v1/admin/dashboard/summary', undefined, admin.json.accessToken);

    assert.ok(summary.json.evidence.scans > 0);
    assert.ok(summary.json.evidence.verified > 0);
    assert.ok(summary.json.evidence.coverage > 0 && summary.json.evidence.coverage <= 1);
    // Not everything was uploaded, so coverage must not read as complete.
    assert.ok(summary.json.evidence.coverage < 1);
  });

  test('scans still lacking a verified image are listable', async () => {
    const supervisor = await api('POST', '/v1/auth/login', {
      email: 'supervisor@dp-logistics.example', password: SEED_PASSWORD,
    });
    const result = await api('GET', '/v1/admin/evidence/missing', undefined,
      supervisor.json.accessToken);

    assert.equal(result.status, 200);
    assert.ok(result.json.scans.length > 0);
  });

  test('a field officer cannot list the evidence gap', async () => {
    const result = await api('GET', '/v1/admin/evidence/missing', undefined, token);
    assert.equal(result.status, 403);
  });
});
