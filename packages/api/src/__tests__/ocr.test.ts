/**
 * OCR pipeline: queue → recognise → store text → auto-link.
 *
 * Uses FixtureOcrProvider, so this covers everything except the Textract API
 * calls themselves: queueing rules, the async poll path, cost guards, hash-based
 * reuse, retry limits, and — the point of the whole feature — a scanned document
 * with no text layer ending up linked to the right container and VINs.
 */

import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { openDb, type Db } from '../lib/db.ts';
import { seed, SEED_PASSWORD, type SeedResult } from '../lib/seed.ts';
import { createServer } from '../server.ts';
import { LocalStorageDriver, setStorage } from '../lib/storage.ts';
import { FixtureOcrProvider, setOcrProvider, enqueueOcr, isRecognisable } from '../modules/ocr.ts';
import {
  runOcrWorker,
  MAX_OCR_ATTEMPTS,
  MAX_OCR_POLLS,
  latestOcrJob,
} from '../modules/ocrWorker.ts';

let db: Db;
let server: Server;
let baseUrl: string;
let fixture: SeedResult;
let storageRoot: string;
let ocr: FixtureOcrProvider;
let adminToken: string;
let lines: any[];

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Stands in for a scanned page: no text layer, so OCR is the only way in. */
const scanBytes = (marker: string): Buffer =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(marker.repeat(40))]);

before(async () => {
  db = openDb(':memory:');
  fixture = seed(db);
  storageRoot = mkdtempSync(join(tmpdir(), 'dp-ocr-'));

  await new Promise<void>((resolve) => {
    server = createServer(db).listen(0, () => resolve());
  });
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;
  setStorage(new LocalStorageDriver(storageRoot, baseUrl, 'ocr-test-secret'));

  adminToken = (await api('POST', '/v1/auth/login', {
    email: 'admin@dp-logistics.example', password: SEED_PASSWORD,
  })).json.accessToken;

  const officer = (await api('POST', '/v1/auth/login', {
    email: 'officer@dp-logistics.example', password: SEED_PASSWORD,
  })).json.accessToken;

  lines = (await api('GET', `/v1/sync/reports?locationId=${fixture.locationId}`,
    undefined, officer)).json.lines;
});

beforeEach(() => {
  ocr = new FixtureOcrProvider();
  setOcrProvider(ocr);
});

after(() => {
  server?.close();
  db?.close();
  setStorage(null);
  setOcrProvider(null);
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

/**
 * Uploads a document with NO extracted text — the scanned-paper case that this
 * whole feature exists for.
 */
/** Runs the worker until nothing is left to pick up. */
async function drainQueue(provider: FixtureOcrProvider) {
  for (let pass = 0; pass < 12; pass++) {
    const result = await runOcrWorker(db, { provider, limit: 25 });
    if (result.processed === 0) return;
  }
}

async function uploadScan(
  docType: string,
  bytes: Buffer,
  contentType = 'image/jpeg',
): Promise<{ documentId: string; key: string; verified: any }> {
  const declared = await api('POST', '/v1/documents', {
    docType, contentType, sha256: sha256(bytes), bytes: bytes.length,
    fileName: `${docType.toLowerCase()}-scan.jpg`,
  }, adminToken);

  await fetch(declared.json.upload.url, {
    method: 'PUT', headers: { 'content-type': contentType }, body: new Uint8Array(bytes),
  });

  const verified = await api('POST', `/v1/documents/${declared.json.documentId}/uploaded`,
    {}, adminToken);

  const key = (db.prepare('SELECT file_key FROM documents WHERE id = ?')
    .get(declared.json.documentId) as { file_key: string }).file_key;

  return { documentId: declared.json.documentId, key, verified };
}

describe('queueing rules', () => {
  test('a verified scan with no text is queued for recognition', async () => {
    const { verified } = await uploadScan('SHIPPING_BILL', scanBytes('A'));

    assert.equal(verified.json.status, 'verified');
    assert.equal(verified.json.ocrQueued, true);
  });

  test('a document that already has text is not queued', async () => {
    const bytes = Buffer.from('%PDF-1.4\nContainer: TGHU7391218\n%%EOF');
    const declared = await api('POST', '/v1/documents', {
      docType: 'PACKING_LIST', contentType: 'application/pdf',
      sha256: sha256(bytes), bytes: bytes.length,
      extractedText: 'Container: TGHU7391218',
    }, adminToken);

    await fetch(declared.json.upload.url, {
      method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array(bytes),
    });
    const verified = await api('POST', `/v1/documents/${declared.json.documentId}/uploaded`,
      {}, adminToken);

    // Recognition bills per page; producing text we already have is pure waste.
    assert.equal(verified.json.ocrQueued, false);
    assert.equal(verified.json.ocrSkipReason, 'TEXT_ALREADY_PRESENT');
  });

  test('a spreadsheet is not queued — it is already text', async () => {
    const bytes = Buffer.from('Container No,Chassis No\nTGHU7391218,MA3EJKD1S00100001\n');
    const declared = await api('POST', '/v1/documents', {
      docType: 'PICKUP_LIST', contentType: 'text/csv',
      sha256: sha256(bytes), bytes: bytes.length,
    }, adminToken);

    await fetch(declared.json.upload.url, {
      method: 'PUT', headers: { 'content-type': 'text/csv' }, body: new Uint8Array(bytes),
    });
    const verified = await api('POST', `/v1/documents/${declared.json.documentId}/uploaded`,
      {}, adminToken);

    assert.equal(verified.json.ocrQueued, false);
    assert.equal(verified.json.ocrSkipReason, 'NOT_RECOGNISABLE');
  });

  test('an unverified document is never queued', () => {
    // Extracting identifiers from a file that failed verification, then linking
    // on them, would be linking on something that may not be the document.
    const bytes = scanBytes('U');
    const documentId = randomUUID();

    db.prepare(
      `INSERT INTO documents (id, org_id, doc_type, file_key, file_sha256,
                              file_content_type, file_bytes, uploaded_by, created_at)
       VALUES (?,?,'OTHER','doc/org/x/2026/08/16/y.jpg',?, 'image/jpeg', ?, ?, ?)`,
    ).run(documentId, fixture.orgId, sha256(bytes), bytes.length,
          (db.prepare("SELECT id FROM users WHERE role = 'admin'").get() as { id: string }).id,
          new Date().toISOString());

    const result = enqueueOcr(db, fixture.orgId, documentId);
    assert.equal(result.queued, false);
    assert.equal(result.reason, 'NOT_VERIFIED');
  });

  test('a second queue request while one is pending is a no-op', async () => {
    const { documentId } = await uploadScan('LEO', scanBytes('D'));

    const again = enqueueOcr(db, fixture.orgId, documentId);
    assert.equal(again.queued, false);
    assert.equal(again.reason, 'ALREADY_QUEUED');
  });

  test('recognisable types are images and PDF, not spreadsheets', () => {
    assert.equal(isRecognisable('application/pdf'), true);
    assert.equal(isRecognisable('image/jpeg'), true);
    assert.equal(isRecognisable('image/tiff'), true);
    assert.equal(isRecognisable('text/csv'), false);
  });
});

describe('recognition and auto-linking — the point of the feature', () => {
  test('a scanned shipping bill links itself to the right container and VINs', async () => {
    const containerNo = lines[0].container_no;
    const forContainer = lines.filter((l: any) => l.container_no === containerNo);

    const { documentId, key } = await uploadScan('SHIPPING_BILL', scanBytes('S'));

    // What Textract would return: LINE blocks joined by newlines, table cells
    // adjacent on a line, container number split by spaces as printed.
    ocr.set(key, [
      'SHIPPING BILL',
      'PORT OF LOADING INMUN',
      `CONTAINER ${containerNo.slice(0, 4)} ${containerNo.slice(4, 10)} ${containerNo.slice(10)}`,
      'SR CHASSIS NO MAKE',
      ...forContainer.map((l: any, i: number) => `${i + 1} ${l.vin} MARUTI`),
    ].join('\n'));

    const worked = await runOcrWorker(db, { provider: ocr });
    assert.equal(worked.completed, 1);

    const job = latestOcrJob(db, fixture.orgId, documentId)!;
    assert.equal(job.state, 'done');
    assert.deepEqual(job.linkedContainers, [containerNo]);
    assert.equal(job.linkedVins.length, forContainer.length);

    // And the document is now reachable from the container it never named in
    // machine-readable form.
    const attached = await api('GET', `/v1/documents/for/container/${containerNo}`,
      undefined, adminToken);
    assert.ok(attached.json.documents.some((d: any) => d.id === documentId));
  });

  test('the recognised document satisfies a dossier requirement', async () => {
    const containerNo = lines[4].container_no;
    const { key } = await uploadScan('LEO', scanBytes('L'));

    ocr.set(key, `LET EXPORT ORDER\nCONTAINER ${containerNo}\nCLEARED`);
    await runOcrWorker(db, { provider: ocr });

    const dossier = await api('GET', `/v1/containers/${containerNo}/dossier`,
      undefined, adminToken);

    const leo = dossier.json.requirements.find((r: any) => r.docType === 'LEO');
    assert.equal(leo.present, true, 'a scanned LEO must satisfy the requirement after OCR');
  });

  test('identifiers not on any report are reported, not linked', async () => {
    const containerNo = lines[8].container_no;
    const { documentId, key } = await uploadScan('SHIPPING_BILL_SUMMARY', scanBytes('F'));

    ocr.set(key, [
      'SHIPPING BILL SUMMARY',
      `CONTAINER ${containerNo}`,
      'CONTAINER MSKU1000016',           // valid ISO 6346, another consignment
      'CHASSIS MA3ERLF1S00999999',       // well-formed VIN, not ours
    ].join('\n'));

    await runOcrWorker(db, { provider: ocr });

    const job = latestOcrJob(db, fixture.orgId, documentId)!;
    assert.deepEqual(job.linkedContainers, [containerNo]);
    assert.ok(job.unmatched.includes('MSKU1000016'));
    assert.ok(job.unmatched.includes('MA3ERLF1S00999999'));
  });

  test('a blank recognition result is done, not failed', async () => {
    // The operational response differs: this document needs manual linking, it
    // does not need the pipeline debugged.
    const { documentId, key } = await uploadScan('CUSTOMS_EXAM_REPORT', scanBytes('B'));
    ocr.set(key, '   \n  \n');

    const worked = await runOcrWorker(db, { provider: ocr });
    assert.equal(worked.completed, 1);
    assert.equal(worked.failed, 0);

    const job = latestOcrJob(db, fixture.orgId, documentId)!;
    assert.equal(job.state, 'done');
    assert.equal(job.error, 'NO_TEXT_FOUND');
  });
});

describe('the async provider path', () => {
  test('a multi-page PDF is polled to completion, not abandoned', async () => {
    const containerNo = lines[12].container_no;
    const bytes = Buffer.from('%PDF-1.4 scanned multipage %%EOF');

    const declared = await api('POST', '/v1/documents', {
      docType: 'COMMERCIAL_INVOICE', contentType: 'application/pdf',
      sha256: sha256(bytes), bytes: bytes.length,
    }, adminToken);
    await fetch(declared.json.upload.url, {
      method: 'PUT', headers: { 'content-type': 'application/pdf' }, body: new Uint8Array(bytes),
    });
    await api('POST', `/v1/documents/${declared.json.documentId}/uploaded`, {}, adminToken);

    const key = (db.prepare('SELECT file_key FROM documents WHERE id = ?')
      .get(declared.json.documentId) as { file_key: string }).file_key;

    ocr.setAsync(key, `COMMERCIAL INVOICE\nCONTAINER ${containerNo}`);

    // First pass: the provider hands back a job handle. Limit to this document
    // so stale jobs from earlier tests cannot absorb the pass.
    const first = await runOcrWorker(db, { provider: ocr, limit: 50 });
    assert.equal(first.pendingProvider, 1);

    let job = latestOcrJob(db, fixture.orgId, declared.json.documentId)!;
    assert.equal(job.state, 'pending_provider');
    // Polling is not a failed attempt; counting it as one would abandon every
    // multi-page document after three passes.
    assert.equal(job.attempts, 1);

    // Second pass: polls and finishes.
    const second = await runOcrWorker(db, { provider: ocr, limit: 50 });
    assert.ok(second.completed >= 1);

    job = latestOcrJob(db, fixture.orgId, declared.json.documentId)!;
    assert.equal(job.state, 'done');
    assert.equal(job.pages, 2);
    assert.deepEqual(job.linkedContainers, [containerNo]);
  });
});

describe('the poll budget', () => {
  test('a provider job that never finishes is eventually abandoned', async () => {
    const { documentId } = await uploadScan('EGM', scanBytes('N'));

    // A provider that accepts the job and then never completes it.
    const stuck = new FixtureOcrProvider();
    stuck.recognize = async () => ({ status: 'pending', jobRef: 'forever' });
    stuck.poll = async () => ({ status: 'pending', jobRef: 'forever' });

    // Polls are cheap but not free; without a ceiling this costs an API call
    // every pass, forever.
    for (let pass = 0; pass <= MAX_OCR_POLLS + 1; pass++) {
      await runOcrWorker(db, { provider: stuck, limit: 50 });
    }

    const job = latestOcrJob(db, fixture.orgId, documentId)!;
    assert.equal(job.state, 'pending_provider');
    assert.equal(job.attempts, MAX_OCR_POLLS);

    // Past the budget it is no longer picked up.
    const after = await runOcrWorker(db, { provider: stuck, limit: 50 });
    assert.equal(after.pendingProvider, 0);
  });

  test('the poll budget is far larger than the retry budget', () => {
    // A multi-page Textract job legitimately takes minutes; three passes would
    // abandon most real documents.
    assert.ok(MAX_OCR_POLLS > MAX_OCR_ATTEMPTS * 5);
  });
});

describe('cost control', () => {
  test('text is reused for a byte-identical file instead of recognised again', async () => {
    const containerNo = lines[16].container_no;
    const bytes = scanBytes('R');

    const first = await uploadScan('PACKING_LIST', bytes);
    ocr.set(first.key, `PACKING LIST\nCONTAINER ${containerNo}`);
    await drainQueue(ocr);

    const firstText = db.prepare('SELECT extracted_text FROM documents WHERE id = ?')
      .get(first.documentId) as { extracted_text: string | null };
    assert.ok(firstText.extracted_text, 'the first copy must be recognised before reuse is tested');

    // The same file uploaded again — a different document row, identical bytes.
    const second = await uploadScan('PACKING_LIST', bytes);
    // Deliberately no fixture text for the second key: if the worker calls the
    // provider it will fail, which is how we know it did not.
    const worked = await runOcrWorker(db, { provider: ocr, limit: 50 });

    assert.equal(worked.reused, 1);

    const job = latestOcrJob(db, fixture.orgId, second.documentId)!;
    assert.equal(job.state, 'done');
    assert.equal(job.reusedFromId, first.documentId);
    assert.deepEqual(job.linkedContainers, [containerNo]);
  });

  test('a document with too many pages is refused rather than billed', async () => {
    const { documentId, key } = await uploadScan('EGM', scanBytes('P'));

    // A provider that reports an absurd page count.
    const huge = new FixtureOcrProvider();
    huge.set(key, 'EGM');
    const original = huge.recognize.bind(huge);
    huge.recognize = async (input) => {
      const outcome = await original(input);
      return outcome.status === 'done' ? { ...outcome, pages: 500 } : outcome;
    };

    const worked = await runOcrWorker(db, { provider: huge });
    assert.equal(worked.failed, 1);

    const job = latestOcrJob(db, fixture.orgId, documentId)!;
    assert.equal(job.state, 'failed');
    assert.match(job.error!, /TOO_MANY_PAGES:500/);
  });
});

describe('failure handling', () => {
  test('an unsupported input fails once, without retrying forever', async () => {
    const { documentId, key } = await uploadScan('OTHER', scanBytes('X'));
    ocr.setFailing(key);

    await runOcrWorker(db, { provider: ocr });

    const job = latestOcrJob(db, fixture.orgId, documentId)!;
    assert.equal(job.state, 'failed');
    assert.equal(job.error, 'FIXTURE_FAILURE');

    // A failed job is terminal for this pass — it is not picked up again.
    const again = await runOcrWorker(db, { provider: ocr });
    assert.equal(again.processed, 0);
  });

  test('a throwing provider is retried up to the attempt limit, then abandoned', async () => {
    const { documentId } = await uploadScan('SEAL_CERTIFICATE', scanBytes('T'));

    const broken = new FixtureOcrProvider();
    broken.recognize = async () => { throw new Error('network exploded'); };

    for (let pass = 0; pass < MAX_OCR_ATTEMPTS + 1; pass++) {
      await runOcrWorker(db, { provider: broken });
    }

    const job = latestOcrJob(db, fixture.orgId, documentId)!;
    assert.equal(job.state, 'failed');
    assert.equal(job.attempts, MAX_OCR_ATTEMPTS);
    assert.match(job.error!, /network exploded/);
  });

  test('recognition failure does not affect the document itself', async () => {
    const { documentId } = await uploadScan('INSURANCE_CERTIFICATE', scanBytes('V'));

    const broken = new FixtureOcrProvider();
    broken.recognize = async () => { throw new Error('boom'); };
    await runOcrWorker(db, { provider: broken });

    // The file is still verified and still viewable; only the text is missing.
    const row = db.prepare('SELECT verified, ocr_state FROM documents WHERE id = ?')
      .get(documentId) as { verified: number; ocr_state: string };

    assert.equal(row.verified, 1);
    const view = await api('GET', `/v1/documents/${documentId}/view`, undefined, adminToken);
    assert.equal(view.status, 200);
  });
});

describe('API surface', () => {
  test('recognition state is readable per document', async () => {
    const containerNo = lines[20].container_no;
    const { documentId, key } = await uploadScan('DELIVERY_ORDER', scanBytes('Q'));
    ocr.set(key, `DELIVERY ORDER\nCONTAINER ${containerNo}`);
    await runOcrWorker(db, { provider: ocr });

    const status = await api('GET', `/v1/documents/${documentId}/ocr`, undefined, adminToken);
    assert.equal(status.status, 200);
    assert.equal(status.json.state, 'done');
    assert.deepEqual(status.json.linkedContainers, [containerNo]);
  });

  test('a document never sent to recognition reports 404', async () => {
    const status = await api('GET', `/v1/documents/${randomUUID()}/ocr`, undefined, adminToken);
    assert.equal(status.status, 404);
  });

  test('recognition can be forced to re-run', async () => {
    const { documentId } = await uploadScan('BILL_OF_LADING', scanBytes('W'));

    const requeued = await api('POST', `/v1/documents/${documentId}/ocr`, {}, adminToken);
    assert.equal(requeued.status, 202);

    const jobs = db.prepare('SELECT COUNT(*) AS n FROM ocr_jobs WHERE document_id = ?')
      .get(documentId) as { n: number };
    assert.ok(jobs.n >= 2, 'a forced run adds a job rather than mutating the old one');
  });

  test('the queue can be drained on demand', async () => {
    const containerNo = lines[21].container_no;
    const { key } = await uploadScan('VGM_CERTIFICATE', scanBytes('Z'));
    ocr.set(key, `VGM\nCONTAINER ${containerNo}`);

    const run = await api('POST', '/v1/admin/ocr/run', { limit: 10 }, adminToken);
    assert.equal(run.status, 200);
    assert.ok(run.json.processed >= 1);
  });

  test('a field officer cannot force recognition or drain the queue', async () => {
    const officer = (await api('POST', '/v1/auth/login', {
      email: 'officer@dp-logistics.example', password: SEED_PASSWORD,
    })).json.accessToken;

    assert.equal((await api('POST', '/v1/admin/ocr/run', {}, officer)).status, 403);
    assert.equal((await api('GET', '/v1/admin/ocr-jobs', undefined, officer)).status, 403);
  });
});
