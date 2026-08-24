/**
 * End-to-end flow over the real HTTP surface: login, sync, scan, reconcile,
 * email, override. Uses an in-memory database and nodemailer's JSON transport,
 * so nothing external is required.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { openDb, newId, nowIso, type Db } from '../lib/db.ts';
import { hashPassword } from '../lib/auth.ts';
import { seed, SEED_PASSWORD, type SeedResult } from '../lib/seed.ts';
import { createServer } from '../server.ts';

let db: Db;
let server: Server;
let baseUrl: string;
let fixture: SeedResult;

before(async () => {
  process.env.JWT_SECRET = 'e2e-test-jwt-secret';
  db = openDb(':memory:');
  fixture = seed(db);

  await new Promise<void>((resolve) => {
    server = createServer(db).listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => {
  server?.close();
  db?.close();
});

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

async function api(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  return { status: response.status, json: text ? JSON.parse(text) : null };
}

const login = async (email: string, deviceId = 'test-device-01') => {
  const { json } = await api('POST', '/v1/auth/login', {
    email,
    password: SEED_PASSWORD,
    deviceId,
    platform: 'android',
    appVersion: '1.0.0',
  });
  return json;
};

/** Builds a scan session payload the way the mobile client would. */
const sessionFor = (containerNo: string, vin: string, deviceOutcome?: string) => ({
  id: randomUUID(),
  locationId: fixture.locationId,
  startedAt: new Date().toISOString(),
  appVersion: '1.0.0',
  deviceOutcome,
  scans: [
    {
      id: randomUUID(),
      scanType: 'container' as const,
      finalValue: containerNo,
      detectedValue: containerNo,
      ocrConfidence: 0.97,
      ocrEngine: 'mlkit-v2',
      checkDigitOk: true,
      capturedAt: new Date().toISOString(),
      gpsLat: 22.839,
      gpsLng: 69.727,
    },
    {
      id: randomUUID(),
      scanType: 'vin' as const,
      finalValue: vin,
      detectedValue: vin,
      ocrConfidence: 0.91,
      ocrEngine: 'mlkit-v2',
      capturedAt: new Date().toISOString(),
      gpsLat: 22.839,
      gpsLng: 69.727,
    },
  ],
});

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */

describe('authentication', () => {
  test('valid credentials return a token pair', async () => {
    const result = await login('officer@dp-logistics.example');
    assert.ok(result.accessToken);
    assert.ok(result.refreshToken);
    assert.equal(result.user.role, 'field_officer');
  });

  test('a brand-new, never-before-seen device id logs in successfully — no approval step exists', async () => {
    const freshDeviceId = `fresh-device-${randomUUID()}`;
    const result = await api('POST', '/v1/auth/login', {
      email: 'officer@dp-logistics.example',
      password: SEED_PASSWORD,
      deviceId: freshDeviceId,
    });
    assert.equal(result.status, 200);
    assert.ok(result.json.accessToken);
    assert.ok(result.json.refreshToken);
  });

  test('logging in with no deviceId at all works exactly the same as with one', async () => {
    const result = await api('POST', '/v1/auth/login', {
      email: 'admin@dp-logistics.example', password: SEED_PASSWORD,
    });
    assert.equal(result.status, 200);
    assert.ok(result.json.accessToken);
  });

  test('a device row is still recorded for bookkeeping, but never blocks the login that created it', async () => {
    const deviceId = `fresh-device-${randomUUID()}`;
    const result = await api('POST', '/v1/auth/login', {
      email: 'officer@dp-logistics.example', password: SEED_PASSWORD, deviceId,
    });
    assert.equal(result.status, 200);

    const row = db.prepare('SELECT approved_at, revoked_at FROM devices WHERE device_id = ?')
      .get(deviceId) as { approved_at: string | null; revoked_at: string | null } | undefined;
    assert.ok(row, 'a device row is still recorded, purely as an audit trail');
    assert.equal(row!.approved_at, null);
    assert.equal(row!.revoked_at, null);
  });

  test('a device revoked directly in the database (legacy data) no longer blocks the user', async () => {
    const deviceId = `fresh-device-${randomUUID()}`;
    const first = await api('POST', '/v1/auth/login', {
      email: 'officer@dp-logistics.example', password: SEED_PASSWORD, deviceId,
    });

    const deviceRow = db.prepare('SELECT id FROM devices WHERE device_id = ?').get(deviceId) as { id: string };
    db.prepare('UPDATE devices SET revoked_at = ? WHERE id = ?').run(nowIso(), deviceRow.id);

    // Same, still-live access token must keep working — device standing is
    // no longer consulted anywhere in the authenticated request path.
    const me = await api('GET', '/v1/auth/me', undefined, first.json.accessToken);
    assert.equal(me.status, 200);

    // A brand-new login with that same (now "revoked") device id must also succeed.
    const relogin = await api('POST', '/v1/auth/login', {
      email: 'officer@dp-logistics.example', password: SEED_PASSWORD, deviceId,
    });
    assert.equal(relogin.status, 200);
  });

  test('a legacy device-bound token (did claim pointing at a revoked device) still authenticates', async () => {
    // Simulates both a token minted before this change and one whose device
    // row was revoked under the old regime — the authenticate middleware must
    // no longer look the claim up at all.
    const officerRow = db.prepare(
      `SELECT id, org_id, role, full_name, email FROM users WHERE email = 'officer@dp-logistics.example'`,
    ).get() as any;

    const revokedDeviceRowId = newId();
    db.prepare(
      `INSERT INTO devices (id, user_id, device_id, revoked_at, created_at) VALUES (?,?,?,?,?)`,
    ).run(revokedDeviceRowId, officerRow.id, 'old-revoked-device', nowIso(), nowIso());

    const { signAccessToken } = await import('../lib/auth.ts');
    const legacyToken = signAccessToken({
      id: officerRow.id, orgId: officerRow.org_id, email: officerRow.email,
      fullName: officerRow.full_name, role: officerRow.role,
    }, revokedDeviceRowId);

    const me = await api('GET', '/v1/auth/me', undefined, legacyToken);
    assert.equal(me.status, 200);
  });

  test('refresh succeeds even when the refresh token is bound to a never-approved device', async () => {
    const deviceId = `fresh-device-${randomUUID()}`;
    const loggedIn = await api('POST', '/v1/auth/login', {
      email: 'officer@dp-logistics.example', password: SEED_PASSWORD, deviceId,
    });

    const refreshed = await api('POST', '/v1/auth/refresh', { refreshToken: loggedIn.json.refreshToken });
    assert.equal(refreshed.status, 200);
    assert.ok(refreshed.json.accessToken);
  });

  test('device-management admin endpoints are gone — approval is no longer part of the product', async () => {
    const adminToken = (await login('admin@dp-logistics.example')).accessToken;

    // These routes no longer exist at all — Express's own unmatched-route
    // handler returns a plain-HTML 404, not the app's JSON error shape, so
    // this checks status only rather than going through the api() helper.
    const rawStatus = async (method: string, path: string) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      return response.status;
    };

    assert.equal(await rawStatus('GET', '/v1/admin/devices'), 404);
    assert.equal(await rawStatus('POST', '/v1/admin/devices/whatever/approve'), 404);
    assert.equal(await rawStatus('POST', '/v1/admin/devices/whatever/revoke'), 404);
  });

  test('organization isolation still holds for authenticated requests once device approval is removed', async () => {
    const otherOrgId = newId();
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)')
      .run(otherOrgId, 'Other Org', nowIso());

    const otherOfficerId = newId();
    db.prepare(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(otherOfficerId, otherOrgId, 'officer@other-org.example',
      hashPassword(SEED_PASSWORD), 'Other Officer', 'field_officer', nowIso());

    // A user in a brand-new org, with zero device history, must still be able
    // to log in — there is no approval step to have skipped.
    const otherToken = (await api('POST', '/v1/auth/login', {
      email: 'officer@other-org.example', password: SEED_PASSWORD,
    })).json.accessToken;
    assert.ok(otherToken);

    // But that user has no assignment to the seeded org's location — org/role
    // scoping must still independently reject the request.
    const attempt = await api(
      'GET', `/v1/sync/reports?locationId=${fixture.locationId}`, undefined, otherToken,
    );
    assert.equal(attempt.status, 403);
  });

  test('wrong password is rejected without revealing the account exists', async () => {
    const wrong = await api('POST', '/v1/auth/login', {
      email: 'officer@dp-logistics.example',
      password: 'not-the-password',
    });
    const unknown = await api('POST', '/v1/auth/login', {
      email: 'nobody@dp-logistics.example',
      password: 'not-the-password',
    });

    assert.equal(wrong.status, 401);
    assert.equal(unknown.status, 401);
    assert.deepEqual(wrong.json.error.code, unknown.json.error.code);
  });

  test('protected routes reject a missing or bad token', async () => {
    assert.equal((await api('GET', '/v1/auth/me')).status, 401);
    assert.equal((await api('GET', '/v1/auth/me', undefined, 'garbage')).status, 401);
  });

  test('refresh tokens rotate and the old one stops working', async () => {
    const { refreshToken } = await login('officer@dp-logistics.example');

    const first = await api('POST', '/v1/auth/refresh', { refreshToken });
    assert.equal(first.status, 200);
    assert.notEqual(first.json.refreshToken, refreshToken);

    // Replay of a consumed token is evidence of theft, not a benign retry.
    const replay = await api('POST', '/v1/auth/refresh', { refreshToken });
    assert.equal(replay.status, 401);
  });
});

describe('role enforcement', () => {
  test('a field officer cannot commit reports or override', async () => {
    const { accessToken } = await login('officer@dp-logistics.example');

    const commit = await api('POST', '/v1/admin/reports/commit', {
      csv: 'x', locationId: fixture.locationId, referenceNo: 'R', deliveryOrder: 'D',
      validFrom: '2026-08-14', validTo: '2026-08-20',
    }, accessToken);
    assert.equal(commit.status, 403);

    const override = await api('POST', '/v1/reconciliations/abc/override',
      { reasonCode: 'REPORT_ERROR' }, accessToken);
    assert.equal(override.status, 403);
  });

  test('an admin can reach admin routes', async () => {
    const { accessToken } = await login('admin@dp-logistics.example');
    const result = await api('GET', '/v1/admin/dashboard/summary', undefined, accessToken);
    assert.equal(result.status, 200);
  });
});

describe('sync and reconciliation', () => {
  let token: string;
  let lines: any[];

  before(async () => {
    token = (await login('officer@dp-logistics.example')).accessToken;
    const sync = await api(
      'GET', `/v1/sync/reports?locationId=${fixture.locationId}`, undefined, token,
    );
    lines = sync.json.lines;
  });

  test('sync returns the active report for offline caching', () => {
    assert.equal(lines.length, 24);
    assert.ok(lines[0].container_no);
    assert.ok(lines[0].vin);
  });

  test('a correct pairing reconciles to MATCH', async () => {
    const line = lines[0];
    const result = await api('POST', '/v1/sync/scans', {
      sessions: [sessionFor(line.container_no, line.vin, 'MATCH')],
    }, token);

    assert.equal(result.status, 200);
    const session = result.json.sessions[0];
    assert.equal(session.status, 'accepted');
    assert.equal(session.outcome, 'MATCH');
    assert.equal(session.outcomeDiffers, false);
    assert.equal(session.progress.loaded, 1);
    assert.equal(session.progress.expected, 4);
  });

  test('a vehicle presented at the wrong container is blocked', async () => {
    const target = lines[0];
    const stray = lines.find((line) => line.container_no !== target.container_no);

    const result = await api('POST', '/v1/sync/scans', {
      sessions: [sessionFor(target.container_no, stray.vin)],
    }, token);

    const session = result.json.sessions[0];
    assert.equal(session.outcome, 'WRONG_CONTAINER');
    assert.equal(session.severity, 'block');
  });

  test('a duplicate session id is idempotent, not a second reconciliation', async () => {
    const line = lines[4];
    const payload = { sessions: [sessionFor(line.container_no, line.vin)] };

    const first = await api('POST', '/v1/sync/scans', payload, token);
    assert.equal(first.json.sessions[0].status, 'accepted');

    // The device retries on a flaky connection; this must not load the car twice.
    const retry = await api('POST', '/v1/sync/scans', payload, token);
    assert.equal(retry.json.sessions[0].status, 'duplicate');

    const count = db
      .prepare('SELECT COUNT(*) AS n FROM reconciliations WHERE session_id = ?')
      .get(payload.sessions[0]!.id) as { n: number };
    assert.equal(count.n, 1);
  });

  test('the same vehicle cannot be loaded twice across sessions', async () => {
    const line = lines[0]; // already MATCHed above
    const result = await api('POST', '/v1/sync/scans', {
      sessions: [sessionFor(line.container_no, line.vin)],
    }, token);

    assert.equal(result.json.sessions[0].outcome, 'DUPLICATE_VIN');
  });

  test('a device/server verdict disagreement is flagged', async () => {
    const target = lines[0];
    const stray = lines.find((line) => line.container_no !== target.container_no);

    // The device was working from a stale cache and said MATCH.
    const result = await api('POST', '/v1/sync/scans', {
      sessions: [sessionFor(target.container_no, stray.vin, 'MATCH')],
    }, token);

    assert.equal(result.json.sessions[0].outcomeDiffers, true);
  });

  test('an officer cannot submit for an unassigned location', async () => {
    const session = sessionFor(lines[8].container_no, lines[8].vin);
    session.locationId = 'some-other-location';

    const result = await api('POST', '/v1/sync/scans', { sessions: [session] }, token);
    assert.equal(result.json.sessions[0].status, 'rejected');
  });

  test('completing a container reports it complete', async () => {
    const containerNo = lines[12].container_no;
    const forContainer = lines.filter((line) => line.container_no === containerNo);

    let last: any;
    for (const line of forContainer) {
      const result = await api('POST', '/v1/sync/scans', {
        sessions: [sessionFor(containerNo, line.vin)],
      }, token);
      last = result.json.sessions[0];
    }

    assert.equal(last.outcome, 'MATCH');
    assert.equal(last.containerComplete, true);
    assert.equal(last.progress.remainingVins.length, 0);
  });
});

describe('notifications', () => {
  test('every reconciliation produced an email record', async () => {
    const token = (await login('supervisor@dp-logistics.example')).accessToken;
    const result = await api('GET', '/v1/admin/notifications?limit=200', undefined, token);

    const sent = result.json.notifications.filter((n: any) => n.status === 'sent');
    assert.ok(sent.length > 0, 'expected sent notifications');

    const mismatch = sent.find((n: any) => n.event_type === 'WRONG_CONTAINER');
    assert.ok(mismatch, 'expected a WRONG_CONTAINER email');
    assert.match(mismatch.subject, /ACTION REQUIRED/);
    assert.match(mismatch.recipients, /supervisor@/);
  });

  test('container completion notifies documentation', async () => {
    const token = (await login('supervisor@dp-logistics.example')).accessToken;
    const result = await api('GET', '/v1/admin/notifications?limit=200', undefined, token);

    const complete = result.json.notifications.find(
      (n: any) => n.event_type === 'CONTAINER_COMPLETE' && n.status === 'sent',
    );
    assert.ok(complete, 'expected a CONTAINER_COMPLETE email');
    assert.match(complete.recipients, /documentation@/);
  });
});

describe('supervisor override', () => {
  test('creates a superseding record without mutating the original', async () => {
    const officerToken = (await login('officer@dp-logistics.example')).accessToken;
    const sync = await api(
      'GET', `/v1/sync/reports?locationId=${fixture.locationId}`, undefined, officerToken,
    );
    const lines = sync.json.lines;
    const loaded = new Set<string>(sync.json.loadedVins);

    // Both vehicles must be unloaded, or the duplicate rule fires first and
    // this never reaches the wrong-container case.
    const target = lines.find((line: any) => !loaded.has(line.vin));
    const stray = lines.find(
      (line: any) => !loaded.has(line.vin) && line.container_no !== target.container_no,
    );
    assert.ok(target && stray, 'fixture exhausted — no unloaded vehicles left');

    const blocked = await api('POST', '/v1/sync/scans', {
      sessions: [sessionFor(target.container_no, stray.vin)],
    }, officerToken);
    const reconciliationId = blocked.json.sessions[0].reconciliationId;
    assert.equal(blocked.json.sessions[0].outcome, 'WRONG_CONTAINER');

    const supervisorToken = (await login('supervisor@dp-logistics.example')).accessToken;
    const override = await api('POST', `/v1/reconciliations/${reconciliationId}/override`, {
      reasonCode: 'LAST_MINUTE_SUBSTITUTION',
      notes: 'Confirmed with DO by phone; substitution authorised.',
    }, supervisorToken);

    assert.equal(override.status, 201);

    // The original is untouched — that is what makes the trail defensible.
    const original = await api(
      'GET', `/v1/reconciliations/${reconciliationId}`, undefined, supervisorToken,
    );
    assert.equal(original.json.outcome, 'WRONG_CONTAINER');
    assert.equal(original.json.overridden, 0);

    const replacement = await api(
      'GET', `/v1/reconciliations/${override.json.id}`, undefined, supervisorToken,
    );
    assert.equal(replacement.json.supersedes_id, reconciliationId);
    assert.equal(replacement.json.overridden, 1);
  });

  test('OTHER requires notes', async () => {
    const token = (await login('supervisor@dp-logistics.example')).accessToken;
    const result = await api('POST', '/v1/reconciliations/whatever/override',
      { reasonCode: 'OTHER' }, token);
    assert.equal(result.status, 400);
  });
});

describe('audit trail', () => {
  test('records report commit, scans and overrides', () => {
    const actions = (
      db.prepare('SELECT DISTINCT action FROM audit_log').all() as { action: string }[]
    ).map((row) => row.action);

    assert.ok(actions.includes('report.commit'));
    assert.ok(actions.includes('recon.submit'));
    assert.ok(actions.includes('recon.override'));
  });
});
