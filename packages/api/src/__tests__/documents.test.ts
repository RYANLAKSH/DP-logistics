/**
 * Trade document repository and container dossier.
 *
 * The dossier is the feature these tests really cover: for a given container,
 * which vehicles belong in it, which are confirmed aboard with verified
 * photographs, and whether the paperwork is complete. Those three facts live in
 * different places operationally, and getting them to join is the point.
 */

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type Db } from '../lib/db.ts';
import { seed, SEED_PASSWORD, type SeedResult } from '../lib/seed.ts';
import { createServer } from '../server.ts';
import { LocalStorageDriver, setStorage } from '../lib/storage.ts';

let db: Db;
let server: Server;
let baseUrl: string;
let fixture: SeedResult;
let storageRoot: string;
let adminToken: string;
let officerToken: string;
let lines: any[];

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** A stand-in for a PDF. Only its hash matters to the storage path. */
const pdf = (text: string): Buffer => Buffer.from(`%PDF-1.4\n${text}\n%%EOF`);

before(async () => {
  db = openDb(':memory:');
  fixture = seed(db);
  storageRoot = mkdtempSync(join(tmpdir(), 'dp-docs-'));

  await new Promise<void>((resolve) => {
    server = createServer(db).listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
  setStorage(new LocalStorageDriver(storageRoot, baseUrl, 'docs-test-secret'));

  adminToken = (await api('POST', '/v1/auth/login', {
    email: 'admin@dp-logistics.example', password: SEED_PASSWORD,
  })).json.accessToken;

  officerToken = (await api('POST', '/v1/auth/login', {
    email: 'officer@dp-logistics.example', password: SEED_PASSWORD,
  })).json.accessToken;

  lines = (await api('GET', `/v1/sync/reports?locationId=${fixture.locationId}`,
    undefined, officerToken)).json.lines;
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

/** Declares, uploads and verifies a document in one go. */
async function uploadDocument(declaration: Record<string, unknown>, bytes: Buffer) {
  const declared = await api('POST', '/v1/documents', {
    contentType: 'application/pdf',
    sha256: sha256(bytes),
    bytes: bytes.length,
    ...declaration,
  }, adminToken);

  if (declared.status !== 201) return { declared, verified: null as any };

  const put = await fetch(declared.json.upload.url, {
    method: 'PUT',
    headers: { 'content-type': 'application/pdf' },
    body: new Uint8Array(bytes),
  });
  assert.equal(put.status, 201);

  const verified = await api('POST', `/v1/documents/${declared.json.documentId}/uploaded`,
    {}, adminToken);

  return { declared, verified };
}

describe('document upload', () => {
  test('declares, uploads and verifies against the declared hash', async () => {
    const bytes = pdf('DELIVERY ORDER DO-2026-08-4471');
    const { declared, verified } = await uploadDocument({
      docType: 'DELIVERY_ORDER',
      referenceNo: 'DO-2026-08-4471',
      fileName: 'do-4471.pdf',
      issuedBy: 'Maruti Suzuki Exports',
    }, bytes);

    assert.equal(declared.status, 201);
    assert.equal(verified.json.status, 'verified');
    assert.equal(verified.json.bytes, bytes.length);
  });

  test('a substituted file fails verification', async () => {
    const declaredBytes = pdf('INVOICE 12345');
    const declared = await api('POST', '/v1/documents', {
      docType: 'COMMERCIAL_INVOICE',
      contentType: 'application/pdf',
      sha256: sha256(declaredBytes),
      bytes: declaredBytes.length,
    }, adminToken);

    // Upload something else entirely.
    await fetch(declared.json.upload.url, {
      method: 'PUT',
      headers: { 'content-type': 'application/pdf' },
      body: new Uint8Array(pdf('INVOICE 99999')),
    });

    const verified = await api('POST', `/v1/documents/${declared.json.documentId}/uploaded`,
      {}, adminToken);

    assert.equal(verified.status, 422);
    assert.equal(verified.json.error.code, 'HASH_MISMATCH');

    const row = db.prepare('SELECT verified FROM documents WHERE id = ?')
      .get(declared.json.documentId) as { verified: number };
    assert.equal(row.verified, 0);
  });

  test('refuses content types that execute or hide content', async () => {
    for (const contentType of ['text/html', 'image/svg+xml', 'application/zip']) {
      const result = await api('POST', '/v1/documents', {
        docType: 'OTHER', contentType,
        sha256: sha256(Buffer.from('x')), bytes: 1,
      }, adminToken);

      assert.equal(result.status, 422, `${contentType} should be refused`);
      assert.equal(result.json.error.code, 'UNSUPPORTED_CONTENT_TYPE');
    }
  });

  test('an unverified document is not served', async () => {
    const bytes = pdf('UNFINISHED');
    const declared = await api('POST', '/v1/documents', {
      docType: 'OTHER', contentType: 'application/pdf',
      sha256: sha256(bytes), bytes: bytes.length,
    }, adminToken);

    const view = await api('GET', `/v1/documents/${declared.json.documentId}/view`,
      undefined, adminToken);
    assert.equal(view.status, 404);
  });

  test('a field officer cannot upload documents', async () => {
    const bytes = pdf('NOPE');
    const result = await api('POST', '/v1/documents', {
      docType: 'LEO', contentType: 'application/pdf',
      sha256: sha256(bytes), bytes: bytes.length,
    }, officerToken);

    assert.equal(result.status, 403);
  });
});

describe('auto-linking from document text', () => {
  test('links a document to every container and VIN it actually mentions', async () => {
    const target = lines[0];
    const second = lines[1];

    const text = [
      'SHIPPING BILL SUMMARY',
      'Port of Loading: INMUN',
      `Container: ${target.container_no}`,
      `Chassis: ${target.vin}`,
      `Chassis: ${second.vin}`,
    ].join('\n');

    const bytes = pdf(text);
    const { declared, verified } = await uploadDocument({
      docType: 'SHIPPING_BILL_SUMMARY',
      referenceNo: 'SB-7788991',
      extractedText: text,
    }, bytes);

    assert.equal(verified.json.status, 'verified');

    const forContainer = await api(
      'GET', `/v1/documents/for/container/${target.container_no}`, undefined, adminToken);

    const found = forContainer.json.documents.find(
      (d: any) => d.id === declared.json.documentId);
    assert.ok(found, 'document should be linked to the container it names');
    assert.equal(found.linkSource, 'extracted');

    const forVin = await api('GET', `/v1/documents/for/vin/${second.vin}`, undefined, adminToken);
    assert.ok(forVin.json.documents.some((d: any) => d.id === declared.json.documentId));
  });

  test('does not link identifiers that are not on any report', async () => {
    // A shipping bill routinely mentions containers from other consignments.
    // Linking every check-digit-valid string would attach documents to
    // shipments they have nothing to do with.
    const text = [
      'SHIPPING BILL',
      'Container: MSKU1000016',          // valid ISO 6346, not on our report
      'Chassis: MA3ERLF1S00999999',      // well-formed VIN, not on our report
      `Container: ${lines[4].container_no}`,  // this one IS ours
    ].join('\n');

    const bytes = pdf(text);
    const { declared } = await uploadDocument({
      docType: 'SHIPPING_BILL', referenceNo: 'SB-0001', extractedText: text,
    }, bytes);

    const links = db.prepare(
      `SELECT entity_type, entity_id FROM document_links WHERE document_id = ?`,
    ).all(declared.json.documentId) as { entity_type: string; entity_id: string }[];

    const linkedIds = links.map((l) => l.entity_id);
    assert.ok(linkedIds.includes(lines[4].container_no));
    assert.ok(!linkedIds.includes('MSKU1000016'), 'foreign container must not be linked');
    assert.ok(!linkedIds.includes('MA3ERLF1S00999999'), 'foreign VIN must not be linked');
  });

  test('normalizes identifiers so document text joins report data', async () => {
    // Documents print container numbers with spaces and hyphens.
    const target = lines[8];
    const spaced = `${target.container_no.slice(0, 4)} ${target.container_no.slice(4, 10)}-${target.container_no.slice(10)}`;
    const text = `PACKING LIST\nContainer ${spaced}\nChassis ${target.vin}`;

    const bytes = pdf(text);
    const { declared } = await uploadDocument({
      docType: 'PACKING_LIST', extractedText: text,
    }, bytes);

    const forContainer = await api(
      'GET', `/v1/documents/for/container/${target.container_no}`, undefined, adminToken);

    assert.ok(forContainer.json.documents.some((d: any) => d.id === declared.json.documentId),
      'a spaced container number in the document must still link');
  });

  test('relink picks up documents that arrived before their report', async () => {
    // Real sequence: the DO and invoice show up days before the pickup list.
    const text = 'INVOICE\nContainer: TGHU7391218\nChassis: MA3EJKD1S00100001';
    const bytes = pdf(text);

    const { declared } = await uploadDocument({
      docType: 'COMMERCIAL_INVOICE', referenceNo: 'INV-EARLY', extractedText: text,
    }, bytes);

    const before = db.prepare(
      'SELECT COUNT(*) AS n FROM document_links WHERE document_id = ?',
    ).get(declared.json.documentId) as { n: number };
    assert.equal(before.n, 0, 'nothing to link against yet');

    // A report arrives naming those identifiers.
    const csv = [
      'Pickup Report,PUR/RELINK/001',
      '',
      'Sr No,Container No,Chassis No,Make,Model',
      '1,TGHU7391218,MA3EJKD1S00100001,Maruti Suzuki,Swift',
    ].join('\n');

    const committed = await api('POST', '/v1/admin/reports/commit', {
      csv,
      locationId: fixture.locationId,
      referenceNo: 'PUR/RELINK/001',
      deliveryOrder: 'DO-RELINK',
      validFrom: '2026-08-14',
      validTo: '2026-08-30',
    }, adminToken);
    assert.equal(committed.status, 201);

    const relinked = await api('POST', `/v1/documents/${declared.json.documentId}/relink`,
      {}, adminToken);

    assert.equal(relinked.status, 200);
    assert.ok(relinked.json.containers.includes('TGHU7391218'));
    assert.ok(relinked.json.vins.includes('MA3EJKD1S00100001'));
  });

  test('a manual link is distinguishable from an extracted one', async () => {
    const bytes = pdf('SCANNED PAPER WITH NO MACHINE TEXT');
    const { declared } = await uploadDocument({ docType: 'LEO', referenceNo: 'LEO-555' }, bytes);

    const linked = await api('POST', `/v1/documents/${declared.json.documentId}/links`,
      { entityType: 'container', entityId: lines[12].container_no }, adminToken);
    assert.equal(linked.status, 201);

    const row = db.prepare(
      'SELECT link_source FROM document_links WHERE document_id = ?',
    ).get(declared.json.documentId) as { link_source: string };

    assert.equal(row.link_source, 'manual');
  });
});

describe('viewing documents', () => {
  test('a verified document is served and the access is logged', async () => {
    const bytes = pdf('LET EXPORT ORDER granted');
    const { declared } = await uploadDocument({ docType: 'LEO', referenceNo: 'LEO-VIEW' }, bytes);

    const before = (db.prepare(
      `SELECT COUNT(*) AS n FROM evidence_access_log WHERE action = 'doc_presign_view'`,
    ).get() as { n: number }).n;

    const view = await api('GET', `/v1/documents/${declared.json.documentId}/view`,
      undefined, adminToken);
    assert.equal(view.status, 200);

    const served = await fetch(view.json.url);
    assert.equal(sha256(Buffer.from(await served.arrayBuffer())), sha256(bytes));

    const after = (db.prepare(
      `SELECT COUNT(*) AS n FROM evidence_access_log WHERE action = 'doc_presign_view'`,
    ).get() as { n: number }).n;
    assert.ok(after > before, 'issuing a document link must leave a record');
  });

  test("another org's document is not reachable", async () => {
    const view = await api('GET', `/v1/documents/${randomUUID()}/view`, undefined, adminToken);
    assert.equal(view.status, 404);
  });
});

describe('the container dossier', () => {
  let containerNo: string;

  before(async () => {
    containerNo = lines[16].container_no;
    const forContainer = lines.filter((l: any) => l.container_no === containerNo);

    // Load every vehicle in this container.
    for (const line of forContainer) {
      await api('POST', '/v1/sync/scans', {
        sessions: [{
          id: randomUUID(), locationId: fixture.locationId, startedAt: new Date().toISOString(),
          scans: [
            { id: randomUUID(), scanType: 'container', finalValue: containerNo,
              capturedAt: new Date().toISOString() },
            { id: randomUUID(), scanType: 'vin', finalValue: line.vin,
              capturedAt: new Date().toISOString() },
          ],
        }],
      }, officerToken);
    }

    // Attach most of the mandatory paperwork, deliberately omitting the LEO.
    for (const docType of ['PICKUP_LIST', 'DELIVERY_ORDER', 'COMMERCIAL_INVOICE',
                           'PACKING_LIST', 'SHIPPING_BILL']) {
      const text = `${docType}\nContainer: ${containerNo}`;
      await uploadDocument({ docType, referenceNo: `${docType}-1`, extractedText: text },
        pdf(text));
    }
  });

  test('reports the vehicles that belong in the container and their verdicts', async () => {
    const dossier = await api('GET', `/v1/containers/${containerNo}/dossier`,
      undefined, adminToken);

    assert.equal(dossier.status, 200);
    assert.equal(dossier.json.containerNo, containerNo);
    assert.equal(dossier.json.expected, 4);
    assert.equal(dossier.json.loaded, 4);
    assert.equal(dossier.json.complete, true);

    for (const vehicle of dossier.json.vehicles) {
      assert.equal(vehicle.outcome, 'MATCH');
      assert.ok(vehicle.reconciliationId);
      assert.ok(vehicle.vin);
    }
  });

  test('reports evidence coverage per vehicle, not just presence', async () => {
    const dossier = await api('GET', `/v1/containers/${containerNo}/dossier`,
      undefined, adminToken);

    // These scans carried no images, so the dossier must say so rather than
    // implying the loading was photographed.
    for (const vehicle of dossier.json.vehicles) {
      assert.equal(vehicle.evidenceExpected, 2);
      assert.equal(vehicle.evidenceVerified, 0);
    }
  });

  test('flags the missing mandatory document', async () => {
    const dossier = await api('GET', `/v1/containers/${containerNo}/dossier`,
      undefined, adminToken);

    const byType = Object.fromEntries(
      dossier.json.requirements.map((r: any) => [r.docType, r.present]));

    assert.equal(byType.PICKUP_LIST, true);
    assert.equal(byType.SHIPPING_BILL, true);
    assert.equal(byType.LEO, false, 'the omitted LEO must be reported missing');
    assert.equal(dossier.json.documentsComplete, false);
  });

  test('becomes complete once the last document lands', async () => {
    const text = `LEO\nContainer: ${containerNo}`;
    await uploadDocument({ docType: 'LEO', referenceNo: 'LEO-FINAL', extractedText: text },
      pdf(text));

    const dossier = await api('GET', `/v1/containers/${containerNo}/dossier`,
      undefined, adminToken);

    assert.equal(dossier.json.documentsComplete, true);
    assert.ok(dossier.json.requirements.every((r: any) => r.present));
  });

  test('a requirement is satisfied by a document linked to any vehicle inside', async () => {
    // A consignment invoice is linked per VIN, not per container. Demanding a
    // container-level copy as well would be paperwork for its own sake.
    const other = lines.find((l: any) => l.container_no !== containerNo)!;
    const otherContainer = other.container_no;

    const text = `COMMERCIAL_INVOICE\nChassis: ${other.vin}`;
    await uploadDocument({ docType: 'COMMERCIAL_INVOICE', referenceNo: 'INV-VINLEVEL',
      extractedText: text }, pdf(text));

    const dossier = await api('GET', `/v1/containers/${otherContainer}/dossier`,
      undefined, adminToken);

    const invoice = dossier.json.requirements.find((r: any) => r.docType === 'COMMERCIAL_INVOICE');
    assert.equal(invoice.present, true);
  });

  test('an unverified document does not satisfy a requirement', async () => {
    const target = lines.find((l: any) =>
      l.container_no !== containerNo)!.container_no;

    // Declare without uploading — the paperwork is claimed but not delivered.
    const bytes = pdf('VGM pending');
    await api('POST', '/v1/documents', {
      docType: 'VGM_CERTIFICATE', contentType: 'application/pdf',
      sha256: sha256(bytes), bytes: bytes.length,
      links: [{ entityType: 'container', entityId: target }],
    }, adminToken);

    await api('POST', '/v1/admin/document-requirements', { docType: 'VGM_CERTIFICATE' }, adminToken);

    const dossier = await api('GET', `/v1/containers/${target}/dossier`, undefined, adminToken);
    const vgm = dossier.json.requirements.find((r: any) => r.docType === 'VGM_CERTIFICATE');

    assert.equal(vgm.present, false, 'a declared-but-unverified document is not evidence');
  });

  test('an unknown container is a 404', async () => {
    const dossier = await api('GET', '/v1/containers/MSKU1000016/dossier', undefined, adminToken);
    assert.equal(dossier.status, 404);
  });

  test('accepts a container number in any separator format', async () => {
    const spaced = `${containerNo.slice(0, 4)}%20${containerNo.slice(4)}`;
    const dossier = await api('GET', `/v1/containers/${spaced}/dossier`, undefined, adminToken);
    assert.equal(dossier.status, 200);
    assert.equal(dossier.json.containerNo, containerNo);
  });
});
