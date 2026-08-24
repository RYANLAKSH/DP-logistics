/**
 * Backup and restore — proves an actual restore, not just that a backup file
 * gets created. See lib/backup.ts for the design rationale.
 *
 * The core test (Stage 14's required proof): create real records and real
 * evidence bytes, back them up, destroy the originals entirely, restore from
 * the backup, and confirm the records, the evidence bytes, and the hashes
 * that tie them together all survive intact — then actually boot the real
 * HTTP server against the restored files and read the record back over the
 * API, the way an operator recovering from an incident would.
 *
 * Everything after that is a battery of failure tests: a restore attempt
 * must report a clear, specific problem rather than silently producing a
 * partially-restored system.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import { openDb, newId, nowIso } from '../lib/db.ts';
import { hashPassword } from '../lib/auth.ts';
import { createServer } from '../server.ts';
import { createBackup, restoreBackup } from '../lib/backup.ts';

// Only needed for the one test that boots the real HTTP server against
// restored data; harmless for the rest, which never touch JWT.
process.env.JWT_SECRET ??= 'backup-test-jwt-secret';

const sha256 = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');

/** A temp dir per test, cleaned up automatically via t.after. */
function tempDir(t: { after: (fn: () => void) => void }, prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('createBackup + restoreBackup — the real restore test', () => {
  test('a real record and real evidence bytes survive backup, destruction, and restore — with matching hashes, over the real API', async (t) => {
    const workDir = tempDir(t, 'dp-backup-e2e-');
    const dbPath = join(workDir, 'source.db');
    const storageDir = join(workDir, 'evidence');
    const backupDir = join(workDir, 'backups');

    // 1-4: a real database with a real record, and a real evidence file whose
    // hash the record declares — exactly the shape evidence.ts produces.
    const db = openDb(dbPath);
    const orgId = newId();
    const userId = newId();
    const locationId = newId();
    const sessionId = newId();
    const scanId = newId();
    const imageBytes = Buffer.from('a real evidentiary photograph, or a stand-in for one');
    const imageKey = `org/${orgId}/2026/08/24/${scanId}.jpg`;
    const imageHash = sha256(imageBytes);

    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)')
      .run(orgId, 'Real Pilot Org', nowIso());
    db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)')
      .run(locationId, orgId, 'REAL', 'Real Yard');
    db.prepare(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run(userId, orgId, 'real.admin@realcompany.example', hashPassword('Real#Password2026'),
          'Real Admin', 'admin', nowIso());
    db.prepare('INSERT INTO user_locations (user_id, location_id) VALUES (?,?)').run(userId, locationId);
    db.prepare(
      `INSERT INTO scan_sessions (id, org_id, officer_id, location_id, started_at, received_at)
       VALUES (?,?,?,?,?,?)`,
    ).run(sessionId, orgId, userId, locationId, nowIso(), nowIso());
    db.prepare(
      `INSERT INTO scans (id, session_id, scan_type, image_key, image_sha256, image_content_type,
                          image_bytes, image_uploaded_at, image_verified, final_value, captured_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(scanId, sessionId, 'container', imageKey, imageHash, 'image/jpeg',
          imageBytes.length, nowIso(), 1, 'MSKU1234567', nowIso(), nowIso());
    db.close();

    mkdirSync(join(storageDir, ...imageKey.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(storageDir, imageKey), imageBytes);

    // 5. Backup.
    const { backupPath, manifest } = await createBackup({ dbPath, storageDir, backupDir });
    assert.equal(manifest.status, 'ok', 'the backup itself must report complete, matched evidence');
    assert.equal(manifest.evidence.fileCount, 1);
    assert.equal(manifest.verification.matchedCount, 1);
    assert.equal(manifest.verification.missing.length, 0);
    assert.equal(manifest.verification.hashMismatch.length, 0);

    // 6. Destroy the originals entirely.
    rmSync(dbPath, { force: true });
    rmSync(storageDir, { recursive: true, force: true });

    // 7. Restore.
    const restoreTargetDir = join(workDir, 'restored');
    const result = await restoreBackup({ backupSourceDir: backupPath, restoreTargetDir });

    // 8-13.
    assert.equal(result.ok, true, `expected a clean restore, got problems: ${result.problems.join('; ')}`);
    assert.equal(result.integrityCheck.ok, true);
    assert.equal(result.evidenceCheck.missing.length, 0);
    assert.equal(result.evidenceCheck.hashMismatch.length, 0);
    assert.equal(result.relationshipCheck.missing.length, 0);
    assert.equal(result.relationshipCheck.hashMismatch.length, 0);

    const restoredDb = new DatabaseSync(result.restoredDbPath);
    const restoredScan = restoredDb.prepare(
      'SELECT image_key, image_sha256 FROM scans WHERE id = ?',
    ).get(scanId) as { image_key: string; image_sha256: string };
    assert.equal(restoredScan.image_key, imageKey, 'the real record must still exist, unmodified, after restore');
    restoredDb.close();

    const restoredBytes = readFileSync(join(result.restoredStorageDir, imageKey));
    assert.equal(sha256(restoredBytes), imageHash, 'recalculated hash of the restored file must match the original');
    assert.deepEqual(restoredBytes, imageBytes, 'restored bytes must be byte-for-byte identical, not just hash-equal');

    // 14-15. Actually boot the real API against the restored files and read
    // the record back over HTTP, the way a recovering operator would.
    const liveDb = openDb(result.restoredDbPath);
    const server = createServer(liveDb).listen(0);
    t.after(() => { server.close(); liveDb.close(); });
    const address = server.address();
    const baseUrl = `http://localhost:${typeof address === 'object' && address ? address.port : 0}`;

    const login = await fetch(`${baseUrl}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'real.admin@realcompany.example', password: 'Real#Password2026' }),
    });
    assert.equal(login.status, 200, 'the restored server must authenticate the real, restored user');
    const { accessToken } = await login.json() as { accessToken: string };

    const me = await fetch(`${baseUrl}/v1/auth/me`, { headers: { authorization: `Bearer ${accessToken}` } });
    assert.equal(me.status, 200, 'the restored server must serve authenticated requests over the restored data');
  });
});

describe('restoreBackup — failure modes', () => {
  test('missing manifest.json is a structural failure, not a silent partial restore', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-manifest-');
    const backupSourceDir = join(workDir, 'not-a-backup');
    mkdirSync(backupSourceDir, { recursive: true });

    await assert.rejects(
      () => restoreBackup({ backupSourceDir, restoreTargetDir: join(workDir, 'restored') }),
      /manifest\.json/,
    );
  });

  test('missing database.sqlite is a structural failure', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-db-');
    const backupSourceDir = join(workDir, 'backup');
    mkdirSync(join(backupSourceDir, 'evidence'), { recursive: true });
    writeFileSync(join(backupSourceDir, 'manifest.json'), JSON.stringify({
      backupId: 'x', database: { fileName: 'database.sqlite' }, evidence: { files: [] },
    }));

    await assert.rejects(
      () => restoreBackup({ backupSourceDir, restoreTargetDir: join(workDir, 'restored') }),
      /database\.sqlite/,
    );
  });

  test('missing evidence directory is a structural failure', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-evdir-');
    const backupSourceDir = join(workDir, 'backup');
    mkdirSync(backupSourceDir, { recursive: true });
    const db = new DatabaseSync(join(backupSourceDir, 'database.sqlite'));
    db.close();
    writeFileSync(join(backupSourceDir, 'manifest.json'), JSON.stringify({
      backupId: 'x', database: { fileName: 'database.sqlite' }, evidence: { files: [] },
    }));

    await assert.rejects(
      () => restoreBackup({ backupSourceDir, restoreTargetDir: join(workDir, 'restored') }),
      /evidence/,
    );
  });

  test('a corrupt manifest.json is a structural failure', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-corrupt-manifest-');
    const backupSourceDir = join(workDir, 'backup');
    mkdirSync(join(backupSourceDir, 'evidence'), { recursive: true });
    writeFileSync(join(backupSourceDir, 'database.sqlite'), 'not even close to sqlite');
    writeFileSync(join(backupSourceDir, 'manifest.json'), '{ this is not valid json');

    await assert.rejects(
      () => restoreBackup({ backupSourceDir, restoreTargetDir: join(workDir, 'restored') }),
      /not valid JSON/,
    );
  });

  test('an invalid (non-SQLite) database file fails the integrity check, not silently', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-invaliddb-');
    const backupSourceDir = join(workDir, 'backup');
    mkdirSync(join(backupSourceDir, 'evidence'), { recursive: true });
    writeFileSync(join(backupSourceDir, 'database.sqlite'), 'this is plainly not a sqlite file');
    writeFileSync(join(backupSourceDir, 'manifest.json'), JSON.stringify({
      backupId: 'x', database: { fileName: 'database.sqlite' }, evidence: { files: [] },
    }));

    const result = await restoreBackup({ backupSourceDir, restoreTargetDir: join(workDir, 'restored') });
    assert.equal(result.ok, false);
    assert.equal(result.integrityCheck.ok, false);
    assert.ok(result.problems.some((p) => p.includes('integrity check failed')));
  });

  test('a missing evidence file (incomplete backup) is reported, not silently passed', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-incomplete-');
    const dbPath = join(workDir, 'source.db');
    const storageDir = join(workDir, 'evidence');
    const backupDir = join(workDir, 'backups');

    const db = openDb(dbPath);
    const orgId = newId(); const scanId = newId(); const sessionId = newId();
    const userId = newId(); const locationId = newId();
    const bytes = Buffer.from('evidence that will go missing after backup');
    const key = `org/${orgId}/2026/08/24/${scanId}.jpg`;
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)').run(orgId, 'Org', nowIso());
    db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)').run(locationId, orgId, 'L', 'L');
    db.prepare(`INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(userId, orgId, 'u@x.example', hashPassword('x'), 'U', 'admin', nowIso());
    db.prepare(`INSERT INTO scan_sessions (id, org_id, officer_id, location_id, started_at, received_at)
                VALUES (?,?,?,?,?,?)`).run(sessionId, orgId, userId, locationId, nowIso(), nowIso());
    db.prepare(`INSERT INTO scans (id, session_id, scan_type, image_key, image_sha256, image_content_type,
                image_bytes, image_uploaded_at, image_verified, final_value, captured_at, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(scanId, sessionId, 'container', key, sha256(bytes), 'image/jpeg', bytes.length, nowIso(), 1, 'X', nowIso(), nowIso());
    db.close();
    mkdirSync(join(storageDir, ...key.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(storageDir, key), bytes);

    const { backupPath } = await createBackup({ dbPath, storageDir, backupDir });

    // Simulate an incomplete backup by deleting the evidence file from the
    // already-created backup copy before restoring from it.
    rmSync(join(backupPath, 'evidence', key), { force: true });

    const result = await restoreBackup({ backupSourceDir: backupPath, restoreTargetDir: join(workDir, 'restored') });
    assert.equal(result.ok, false);
    assert.ok(result.evidenceCheck.missing.includes(key));
    assert.ok(result.relationshipCheck.missing.includes(key));
  });

  test('a corrupted evidence file (hash no longer matches) is reported, not silently passed', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-corrupted-');
    const dbPath = join(workDir, 'source.db');
    const storageDir = join(workDir, 'evidence');
    const backupDir = join(workDir, 'backups');

    const db = openDb(dbPath);
    const orgId = newId(); const scanId = newId(); const sessionId = newId();
    const userId = newId(); const locationId = newId();
    const bytes = Buffer.from('evidence that will be corrupted after backup');
    const key = `org/${orgId}/2026/08/24/${scanId}.jpg`;
    db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)').run(orgId, 'Org', nowIso());
    db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)').run(locationId, orgId, 'L', 'L');
    db.prepare(`INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
                VALUES (?,?,?,?,?,?,?)`)
      .run(userId, orgId, 'u@x.example', hashPassword('x'), 'U', 'admin', nowIso());
    db.prepare(`INSERT INTO scan_sessions (id, org_id, officer_id, location_id, started_at, received_at)
                VALUES (?,?,?,?,?,?)`).run(sessionId, orgId, userId, locationId, nowIso(), nowIso());
    db.prepare(`INSERT INTO scans (id, session_id, scan_type, image_key, image_sha256, image_content_type,
                image_bytes, image_uploaded_at, image_verified, final_value, captured_at, created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(scanId, sessionId, 'container', key, sha256(bytes), 'image/jpeg', bytes.length, nowIso(), 1, 'X', nowIso(), nowIso());
    db.close();
    mkdirSync(join(storageDir, ...key.split('/').slice(0, -1)), { recursive: true });
    writeFileSync(join(storageDir, key), bytes);

    const { backupPath } = await createBackup({ dbPath, storageDir, backupDir });

    // Flip a byte in the backed-up copy — simulating disk corruption between
    // backup and restore.
    writeFileSync(join(backupPath, 'evidence', key), Buffer.from('CORRUPTED-not-the-real-bytes-at-all'));

    const result = await restoreBackup({ backupSourceDir: backupPath, restoreTargetDir: join(workDir, 'restored') });
    assert.equal(result.ok, false);
    assert.ok(result.evidenceCheck.hashMismatch.includes(key));
    assert.ok(result.relationshipCheck.hashMismatch.includes(key));
  });

  test('mismatched database and evidence backups (an operator mixing up two different backups) is detected', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-mismatched-');

    // Two independent, unrelated backups, each internally consistent.
    async function makeBackup(label: string) {
      const dbPath = join(workDir, `${label}.db`);
      const storageDir = join(workDir, `${label}-evidence`);
      const backupDir = join(workDir, `${label}-backups`);
      const db = openDb(dbPath);
      const orgId = newId(); const scanId = newId(); const sessionId = newId();
      const userId = newId(); const locationId = newId();
      const bytes = Buffer.from(`evidence unique to ${label}: ${randomUUID()}`);
      const key = `org/${orgId}/2026/08/24/${scanId}.jpg`;
      db.prepare('INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)').run(orgId, label, nowIso());
      db.prepare('INSERT INTO locations (id, org_id, code, name) VALUES (?,?,?,?)').run(locationId, orgId, 'L', 'L');
      db.prepare(`INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
                  VALUES (?,?,?,?,?,?,?)`)
        .run(userId, orgId, `${label}@x.example`, hashPassword('x'), 'U', 'admin', nowIso());
      db.prepare(`INSERT INTO scan_sessions (id, org_id, officer_id, location_id, started_at, received_at)
                  VALUES (?,?,?,?,?,?)`).run(sessionId, orgId, userId, locationId, nowIso(), nowIso());
      db.prepare(`INSERT INTO scans (id, session_id, scan_type, image_key, image_sha256, image_content_type,
                  image_bytes, image_uploaded_at, image_verified, final_value, captured_at, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(scanId, sessionId, 'container', key, sha256(bytes), 'image/jpeg', bytes.length, nowIso(), 1, 'X', nowIso(), nowIso());
      db.close();
      mkdirSync(join(storageDir, ...key.split('/').slice(0, -1)), { recursive: true });
      writeFileSync(join(storageDir, key), bytes);
      return createBackup({ dbPath, storageDir, backupDir });
    }

    const a = await makeBackup('org-a');
    const b = await makeBackup('org-b');

    // An operator's mistake: org A's database paired with org B's evidence folder.
    const frankenstein = join(workDir, 'frankenstein-backup');
    mkdirSync(frankenstein, { recursive: true });
    cpSync(join(a.backupPath, 'database.sqlite'), join(frankenstein, 'database.sqlite'));
    cpSync(join(a.backupPath, 'manifest.json'), join(frankenstein, 'manifest.json'));
    cpSync(join(b.backupPath, 'evidence'), join(frankenstein, 'evidence'), { recursive: true });

    const result = await restoreBackup({ backupSourceDir: frankenstein, restoreTargetDir: join(workDir, 'restored') });
    assert.equal(result.ok, false, 'org A\'s database paired with org B\'s evidence must not verify as a clean restore');
    assert.ok(result.relationshipCheck.missing.length > 0, 'org A\'s verified image key must not resolve inside org B\'s evidence files');
  });

  test('refuses to restore on top of the live DB_PATH/STORAGE_DIR', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-live-guard-');
    const dbPath = join(workDir, 'source.db');
    const storageDir = join(workDir, 'evidence');
    const backupDir = join(workDir, 'backups');
    openDb(dbPath).close();

    const { backupPath } = await createBackup({ dbPath, storageDir, backupDir });

    await assert.rejects(
      () => restoreBackup({
        backupSourceDir: backupPath,
        restoreTargetDir: workDir, // same directory dirname(dbPath) resolves to
        liveDbPath: dbPath,
      }),
      /live DB_PATH/,
    );
  });

  test('refuses to overwrite an existing restore target', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-target-exists-');
    const dbPath = join(workDir, 'source.db');
    const storageDir = join(workDir, 'evidence');
    const backupDir = join(workDir, 'backups');
    openDb(dbPath).close();

    const { backupPath } = await createBackup({ dbPath, storageDir, backupDir });
    const restoreTargetDir = join(workDir, 'restored');
    mkdirSync(restoreTargetDir);

    await assert.rejects(
      () => restoreBackup({ backupSourceDir: backupPath, restoreTargetDir }),
      /already exists/,
    );
  });
});

describe('createBackup — safety', () => {
  test('refuses to back up a database that does not exist', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-nodb-');
    await assert.rejects(
      () => createBackup({
        dbPath: join(workDir, 'nope.db'), storageDir: join(workDir, 'ev'), backupDir: join(workDir, 'backups'),
      }),
      /nothing to back up/,
    );
  });

  test('never overwrites a previous backup with the same id', async (t) => {
    const workDir = tempDir(t, 'dp-backup-fail-dup-');
    const dbPath = join(workDir, 'source.db');
    openDb(dbPath).close();
    const backupDir = join(workDir, 'backups');
    const first = await createBackup({ dbPath, storageDir: join(workDir, 'ev'), backupDir });

    // Force a collision by pre-creating the exact directory a second backup would use.
    mkdirSync(join(backupDir, 'forced-collision'), { recursive: true });
    const original = Date.prototype.toISOString;
    try {
      // Not touching Date.now()/global time semantics elsewhere — only this
      // local override, restored immediately after, to deterministically
      // force the id collision this test exists to prove is refused.
      Date.prototype.toISOString = function toISOString() { return 'forced-collision'; };
      await assert.rejects(
        () => createBackup({ dbPath, storageDir: join(workDir, 'ev'), backupDir }),
        /already exists/,
      );
    } finally {
      Date.prototype.toISOString = original;
    }
    assert.ok(first.backupPath);
  });

  test('handles a fresh deployment with no evidence uploaded yet', async (t) => {
    const workDir = tempDir(t, 'dp-backup-empty-evidence-');
    const dbPath = join(workDir, 'source.db');
    openDb(dbPath).close(); // schema only, no records, no evidence dir ever created

    const { manifest } = await createBackup({
      dbPath, storageDir: join(workDir, 'never-created'), backupDir: join(workDir, 'backups'),
    });
    assert.equal(manifest.evidence.fileCount, 0);
    assert.equal(manifest.status, 'ok', 'zero evidence is a legitimate state, not an incomplete backup');
  });
});
