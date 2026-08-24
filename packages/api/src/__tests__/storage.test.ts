/**
 * Storage driver and capability-URL tests.
 *
 * The local driver is what runs in development and self-hosted deployments, and
 * it mints its own capability URLs — so the signing, expiry and containment
 * behaviour is ours to get right, not a cloud provider's.
 */

import { test, describe, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import {
  LocalStorageDriver,
  evidenceKey,
  isValidKey,
  MAX_IMAGE_BYTES,
  ALLOWED_CONTENT_TYPES,
  getStorage,
  setStorage,
} from '../lib/storage.ts';

let root: string;
let storage: LocalStorageDriver;

const ORG = randomUUID();
const SCAN = randomUUID();

before(() => {
  root = mkdtempSync(join(tmpdir(), 'dp-evidence-'));
  storage = new LocalStorageDriver(root, 'http://localhost:9999', 'test-secret');
});

after(() => rmSync(root, { recursive: true, force: true }));

describe('evidenceKey', () => {
  test('derives a date-partitioned key from server-held facts', () => {
    const key = evidenceKey({
      orgId: ORG,
      scanId: SCAN,
      capturedAt: '2026-08-16T09:15:00Z',
      contentType: 'image/jpeg',
    });

    assert.equal(key, `org/${ORG}/2026/08/16/${SCAN}.jpg`);
    assert.equal(isValidKey(key), true);
  });

  test('maps each allowed content type to its extension', () => {
    const extensions = [...ALLOWED_CONTENT_TYPES].map((contentType) =>
      evidenceKey({ orgId: ORG, scanId: SCAN, capturedAt: '2026-08-16T09:00:00Z', contentType })
        .split('.').pop());

    assert.deepEqual(extensions, ['jpg', 'png', 'webp']);
  });

  test('falls back to the current date rather than producing NaN segments', () => {
    const key = evidenceKey({
      orgId: ORG, scanId: SCAN, capturedAt: 'not-a-date', contentType: 'image/jpeg',
    });
    assert.equal(isValidKey(key), true);
    assert.ok(!key.includes('NaN'));
  });

  test('rejects keys that are not our own shape', () => {
    for (const bad of [
      '',
      'org/../etc/passwd',
      `org/${ORG}/2026/08/16/../../../secret.jpg`,
      'evidence/whatever.jpg',
      `org/not-a-uuid/2026/08/16/${SCAN}.jpg`,
      `org/${ORG}/2026/08/16/${SCAN}.exe`,
    ]) {
      assert.equal(isValidKey(bad), false, `${bad} should be rejected`);
    }
  });
});

describe('capability URLs', () => {
  const key = evidenceKey({
    orgId: ORG, scanId: SCAN, capturedAt: '2026-08-16T09:00:00Z', contentType: 'image/jpeg',
  });

  test('a put token verifies and names exactly one key and operation', async () => {
    const upload = await storage.presignPut(key, 'image/jpeg', 600);
    const token = upload.url.split('/').pop()!;

    const capability = storage.verify(token);
    assert.ok(capability);
    assert.equal(capability.k, key);
    assert.equal(capability.o, 'put');
    assert.equal(capability.c, 'image/jpeg');
  });

  test('a get token is not usable as a put token', async () => {
    const view = await storage.presignGet(key, 600);
    const capability = storage.verify(view.url.split('/').pop()!);

    assert.equal(capability?.o, 'get');
    // The route checks the operation; the token itself must carry it so a
    // read link can never be replayed as a write.
    assert.notEqual(capability?.o, 'put');
  });

  test('a tampered payload fails the signature check', async () => {
    const upload = await storage.presignPut(key, 'image/jpeg', 600);
    const [body, mac] = upload.url.split('/').pop()!.split('.');

    // Re-point the capability at a different scan, keeping the original MAC.
    const forged = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    forged.k = evidenceKey({
      orgId: ORG, scanId: randomUUID(), capturedAt: '2026-08-16T09:00:00Z', contentType: 'image/jpeg',
    });
    const forgedBody = Buffer.from(JSON.stringify(forged)).toString('base64url');

    assert.equal(storage.verify(`${forgedBody}.${mac}`), null);
  });

  test('a token signed with a different secret is rejected', async () => {
    const other = new LocalStorageDriver(root, 'http://localhost:9999', 'a-different-secret');
    const upload = await other.presignPut(key, 'image/jpeg', 600);

    assert.equal(storage.verify(upload.url.split('/').pop()!), null);
  });

  test('an expired token is rejected', async () => {
    const upload = await storage.presignPut(key, 'image/jpeg', -1);
    assert.equal(storage.verify(upload.url.split('/').pop()!), null);
  });

  test('malformed tokens are rejected without throwing', () => {
    for (const bad of ['', '.', 'nonsense', 'a.b', 'eyJ9.abc', 'not-base64!.sig']) {
      assert.equal(storage.verify(bad), null, `${bad} should be rejected`);
    }
  });

  test('reports the expiry it granted', async () => {
    const upload = await storage.presignPut(key, 'image/jpeg', 3600);
    const expires = new Date(upload.expiresAt).getTime();

    assert.ok(expires > Date.now());
    assert.ok(expires <= Date.now() + 3601_000);
  });
});

describe('read, write and stat', () => {
  const key = evidenceKey({
    orgId: ORG, scanId: randomUUID(), capturedAt: '2026-08-16T09:00:00Z', contentType: 'image/jpeg',
  });
  const bytes = Buffer.from('pretend this is a JPEG of a container door plate');

  test('round-trips bytes and reports a matching hash', async () => {
    storage.write(key, bytes);

    const stored = await storage.stat(key);
    assert.ok(stored);
    assert.equal(stored.bytes, bytes.length);
    assert.equal(stored.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(storage.read(key), bytes);
  });

  test('stat returns null for an absent object', async () => {
    const absent = evidenceKey({
      orgId: ORG, scanId: randomUUID(), capturedAt: '2026-08-16T09:00:00Z', contentType: 'image/png',
    });
    assert.equal(await storage.stat(absent), null);
    assert.equal(storage.read(absent), null);
  });

  test('delete removes the object and is safe to repeat', async () => {
    storage.write(key, bytes);
    await storage.delete(key);
    assert.equal(await storage.stat(key), null);
    await storage.delete(key); // must not throw
  });

  test('refuses a key that would escape the storage root', () => {
    // isValidKey already excludes this shape; the containment check is the
    // second line of defence if that pattern is ever loosened.
    assert.throws(() => storage.write('../../escaped.jpg', bytes), /escapes storage root/);
  });

  test('writes land inside the configured root', async () => {
    storage.write(key, bytes);
    assert.equal(existsSync(join(root, key)), true);
  });
});

describe('limits', () => {
  test('the size ceiling is a sane evidence-photo bound', () => {
    // Big enough for a full-resolution phone photo, small enough that a
    // runaway upload cannot fill the disk.
    assert.ok(MAX_IMAGE_BYTES >= 4 * 1024 * 1024);
    assert.ok(MAX_IMAGE_BYTES <= 32 * 1024 * 1024);
  });

  test('only image content types are allowed', () => {
    assert.equal(ALLOWED_CONTENT_TYPES.has('image/jpeg'), true);
    assert.equal(ALLOWED_CONTENT_TYPES.has('application/pdf'), false);
    assert.equal(ALLOWED_CONTENT_TYPES.has('text/html'), false);
  });
});

/**
 * getStorage()'s local-driver secret must fail closed, unconditionally — no
 * environment, and no value of NODE_ENV in particular, may cause it to hand
 * back a driver signed with a secret it didn't read from STORAGE_SECRET. This
 * is the Stage 11 regression test for that property, mirroring auth.test.ts's
 * coverage of the identical getJwtSecret() fix. See getStorage()'s own
 * comment for the history: this was previously gated on
 * NODE_ENV === 'production' and fell back to a fresh random secret
 * otherwise, which breaks every previously-issued capability URL on the next
 * restart without ever surfacing an error.
 */
describe('getStorage — fail-closed behaviour (local driver)', () => {
  const ORIGINAL_STORAGE_SECRET = process.env.STORAGE_SECRET;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
  const ORIGINAL_S3_BUCKET = process.env.S3_BUCKET;

  beforeEach(() => {
    delete process.env.STORAGE_SECRET;
    delete process.env.NODE_ENV;
    delete process.env.S3_BUCKET;
    setStorage(null);
  });

  afterEach(() => {
    if (ORIGINAL_STORAGE_SECRET === undefined) delete process.env.STORAGE_SECRET;
    else process.env.STORAGE_SECRET = ORIGINAL_STORAGE_SECRET;

    if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = ORIGINAL_NODE_ENV;

    if (ORIGINAL_S3_BUCKET === undefined) delete process.env.S3_BUCKET;
    else process.env.S3_BUCKET = ORIGINAL_S3_BUCKET;

    setStorage(null);
  });

  test('missing STORAGE_SECRET throws, in every NODE_ENV — never a random fallback secret', () => {
    for (const nodeEnv of [undefined, 'development', 'test', 'staging', 'production', 'PRODUCTION', '']) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      setStorage(null);

      assert.throws(
        () => getStorage(),
        /STORAGE_SECRET is not set/,
        `expected getStorage() to throw with NODE_ENV=${JSON.stringify(nodeEnv)}`,
      );
    }
  });

  test('empty STORAGE_SECRET throws, regardless of NODE_ENV', () => {
    process.env.STORAGE_SECRET = '';
    assert.throws(() => getStorage(), /STORAGE_SECRET is not set/);

    process.env.NODE_ENV = 'development';
    setStorage(null);
    assert.throws(() => getStorage(), /STORAGE_SECRET is not set/);
  });

  test('whitespace-only STORAGE_SECRET is treated as empty', () => {
    process.env.STORAGE_SECRET = '   ';
    assert.throws(() => getStorage(), /STORAGE_SECRET is not set/);
  });

  test('a real, non-empty STORAGE_SECRET is accepted and produces a working local driver', () => {
    process.env.STORAGE_SECRET = 'a-real-configured-secret';
    const driver = getStorage();
    assert.ok(driver instanceof LocalStorageDriver);
  });

  test('NODE_ENV plays no role once a real STORAGE_SECRET is set', () => {
    process.env.STORAGE_SECRET = 'a-real-configured-secret';
    for (const nodeEnv of [undefined, 'development', 'production', 'anything-else']) {
      if (nodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = nodeEnv;
      setStorage(null);

      assert.ok(getStorage() instanceof LocalStorageDriver);
    }
  });

  test('S3_BUCKET bypasses the local-secret requirement entirely, in any environment', () => {
    process.env.S3_BUCKET = 'some-bucket';
    // No STORAGE_SECRET set at all — the S3 driver has its own credential
    // model and must not be blocked by the local driver's secret check.
    assert.doesNotThrow(() => getStorage());
  });
});
