/**
 * P1 fix: a field officer must not have organization-wide read access to
 * trade documents and reconciliation history. Mobile app (packages/mobile)
 * never calls any of these routes — an officer's whole legitimate surface is
 * scan sync, evidence upload, and (per evidence.test.ts) their own submitted
 * evidence. supervisor/admin/auditor keep full read access, matching
 * docs/security.md's "auditors read everything and change nothing".
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';

import { openDb, newId, nowIso, type Db } from '../lib/db.ts';
import { seed, SEED_PASSWORD, type SeedResult } from '../lib/seed.ts';
import { hashPassword } from '../lib/auth.ts';
import { createServer } from '../server.ts';

let db: Db;
let server: Server;
let baseUrl: string;
let fixture: SeedResult;
let officerToken: string;
let supervisorToken: string;
let adminToken: string;
let auditorToken: string;
let containerNo: string;

before(async () => {
  process.env.JWT_SECRET = 'read-authz-test-secret';
  db = openDb(':memory:');
  fixture = seed(db);

  await new Promise<void>((resolve) => {
    server = createServer(db).listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;

  const login = async (email: string) =>
    (await api('POST', '/v1/auth/login', { email, password: SEED_PASSWORD })).json.accessToken;

  officerToken = await login('officer@dp-logistics.example');
  supervisorToken = await login('supervisor@dp-logistics.example');
  adminToken = await login('admin@dp-logistics.example');
  auditorToken = await login('auditor@dp-logistics.example');

  const lines = (await api('GET', `/v1/sync/reports?locationId=${fixture.locationId}`,
    undefined, officerToken)).json.lines;
  containerNo = lines[0].container_no;
});

after(() => {
  server?.close();
  db?.close();
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

const READ_ROUTES: { name: string; path: () => string }[] = [
  { name: 'document list', path: () => '/v1/documents' },
  { name: 'documents for entity', path: () => `/v1/documents/for/container/${containerNo}` },
  { name: 'container dossier', path: () => `/v1/containers/${containerNo}/dossier` },
  { name: 'reconciliation list', path: () => '/v1/reconciliations' },
];

describe('organization-wide document/reconciliation reads', () => {
  for (const route of READ_ROUTES) {
    test(`field officer cannot access ${route.name}`, async () => {
      const result = await api('GET', route.path(), undefined, officerToken);
      assert.equal(result.status, 403, `${route.name} must be forbidden to a field officer`);
    });

    test(`supervisor can access ${route.name}`, async () => {
      const result = await api('GET', route.path(), undefined, supervisorToken);
      assert.equal(result.status, 200, `${route.name} must remain reachable to a supervisor`);
    });

    test(`admin can access ${route.name}`, async () => {
      const result = await api('GET', route.path(), undefined, adminToken);
      assert.equal(result.status, 200, `${route.name} must remain reachable to an admin`);
    });

    test(`auditor can access ${route.name}`, async () => {
      const result = await api('GET', route.path(), undefined, auditorToken);
      assert.equal(result.status, 200,
        `${route.name} must remain reachable to an auditor — auditor is documented as read-only across everything`);
    });

    test(`unauthenticated requests to ${route.name} are rejected`, async () => {
      const result = await api('GET', route.path());
      assert.equal(result.status, 401);
    });
  }

  test('field officer cannot view a document by id', async () => {
    // No document exists yet for this fresh id — a 403 must still come back
    // before a 404 would, so the officer learns nothing about what exists.
    const result = await api('GET', `/v1/documents/${randomUUID()}/view`, undefined, officerToken);
    assert.equal(result.status, 403);
  });

  test("field officer cannot read a document's OCR state", async () => {
    const result = await api('GET', `/v1/documents/${randomUUID()}/ocr`, undefined, officerToken);
    assert.equal(result.status, 403);
  });

  test('field officer cannot read an individual reconciliation record', async () => {
    const result = await api('GET', `/v1/reconciliations/${randomUUID()}`, undefined, officerToken);
    assert.equal(result.status, 403);
  });

  test('supervisor can read an individual reconciliation record after it exists', async () => {
    const lines = (await api(
      'GET', `/v1/sync/reports?locationId=${fixture.locationId}`, undefined, officerToken,
    )).json.lines;
    const line = lines.find((l: any) => l.container_no === containerNo);

    const sessionId = randomUUID();
    await api('POST', '/v1/sync/scans', {
      sessions: [{
        id: sessionId, locationId: fixture.locationId, startedAt: new Date().toISOString(),
        scans: [
          { id: randomUUID(), scanType: 'container', finalValue: containerNo,
            capturedAt: new Date().toISOString() },
          { id: randomUUID(), scanType: 'vin', finalValue: line.vin,
            capturedAt: new Date().toISOString() },
        ],
      }],
    }, officerToken);

    const recon = db.prepare(
      'SELECT id FROM reconciliations WHERE session_id = ?',
    ).get(sessionId) as { id: string } | undefined;
    assert.ok(recon, 'setup: a reconciliation must have been created');

    const result = await api('GET', `/v1/reconciliations/${recon!.id}`, undefined, supervisorToken);
    assert.equal(result.status, 200);
  });

  test("cross-organization isolation: a second org's admin cannot see this org's documents", async () => {
    const otherOrgId = newId();
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)')
      .run(otherOrgId, 'Other Org', nowIso());

    const otherAdminId = newId();
    db.prepare(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(otherAdminId, otherOrgId, 'admin@other-org.example',
          hashPassword(SEED_PASSWORD), 'Other Org Admin', 'admin', nowIso());

    const otherAdminToken = (await api('POST', '/v1/auth/login', {
      email: 'admin@other-org.example', password: SEED_PASSWORD,
    })).json.accessToken;

    const list = await api('GET', '/v1/documents', undefined, otherAdminToken);
    assert.equal(list.status, 200);
    assert.equal(list.json.documents.length, 0, "a fresh org must see none of this org's documents");

    const reconList = await api('GET', '/v1/reconciliations', undefined, otherAdminToken);
    assert.equal(reconList.status, 200);
    assert.equal(reconList.json.reconciliations.length, 0,
      "a fresh org must see none of this org's reconciliations");
  });
});
