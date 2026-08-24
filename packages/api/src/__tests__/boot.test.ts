/**
 * Proves the actual production boot path (start.ts), not just the seed()
 * function tests exercise directly elsewhere: spawns the real script as a
 * child process against a temp, file-backed database, exactly the way a real
 * deployment would run it.
 *
 * Properties that matter here, and are not testable by calling functions
 * in-process the way the rest of the suite does — each requires a real
 * process boot against a real file/env:
 *
 *   1. A first boot against an empty database inserts nothing on its own.
 *   2. A real record survives a restart, unduplicated and unmodified — the
 *      Stage 13 fix for the bug where every restart re-seeded demo data on
 *      top of whatever was already there.
 *   3. A production boot with the local storage driver refuses to start
 *      without PUBLIC_BASE_URL (Stage 15) — every evidence/document link it
 *      would otherwise mint silently points at localhost.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer as createNetServer } from 'node:net';

const startScript = fileURLToPath(new URL('../start.ts', import.meta.url));

/** An OS-assigned free port, grabbed and released just before the child binds it. */
function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Boots start.ts against dbPath and resolves once it reports it's listening. */
function bootStartScript(dbPath: string, extraEnv: Record<string, string> = {}): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', startScript],
      {
        env: {
          ...process.env,
          DB_PATH: dbPath,
          JWT_SECRET: 'boot-test-jwt-secret',
          STORAGE_SECRET: 'boot-test-storage-secret',
          PUBLIC_BASE_URL: 'https://boot-test.example.com',
          PORT: '0',
          ...extraEnv,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error('start.ts did not report ready in time')); }
    }, 10_000);

    child.stdout?.on('data', (chunk: Buffer) => {
      if (!settled && chunk.toString().includes('API listening on port')) {
        settled = true;
        clearTimeout(timeout);
        resolve(child);
      }
    });

    child.once('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        reject(new Error(`start.ts exited before reporting ready (code ${code})`));
      }
    });
  });
}

/** Sends SIGTERM and waits for the process to actually exit. */
function stop(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
  });
}

/** Waits for a child to exit and reports exactly how (code vs. killing signal). */
function waitForExit(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve) => {
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
}

const countRows = (dbPath: string, table: string): number => {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  } finally {
    db.close();
  }
};

describe('production boot path (start.ts)', () => {
  test('a first boot against an empty database seeds nothing, and a real record survives a restart unduplicated', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-boot-test-'));
    const dbPath = join(dir, 'prod.db');
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    // First boot, against a database that does not exist yet.
    const first = await bootStartScript(dbPath);
    await stop(first);

    assert.equal(countRows(dbPath, 'organizations'), 0, 'first boot must not create any organization');
    assert.equal(countRows(dbPath, 'users'), 0, 'first boot must not create any user');

    // Insert exactly one real record directly — standing in for whatever a
    // real deployment would have created through the admin API.
    const seedDb = new DatabaseSync(dbPath);
    seedDb.prepare(
      `INSERT INTO organizations (id, name, created_at) VALUES (?,?,?)`,
    ).run('real-org', 'Real Pilot Org', '2026-08-24T00:00:00Z');
    seedDb.prepare(
      `INSERT INTO users (id, org_id, email, password_hash, full_name, role, created_at)
       VALUES (?,?,?,?,?,?,?)`,
    ).run('real-user', 'real-org', 'real.admin@realcompany.example', 'scrypt$x$y',
          'Real Admin', 'admin', '2026-08-24T00:00:00Z');
    seedDb.close();

    // Restart against the same file.
    const second = await bootStartScript(dbPath);
    await stop(second);

    assert.equal(countRows(dbPath, 'organizations'), 1, 'a restart must not add a second (demo) organization');
    assert.equal(countRows(dbPath, 'users'), 1, 'a restart must not add any demo users alongside the real one');

    const db = new DatabaseSync(dbPath);
    const row = db.prepare('SELECT id, org_id, email, role FROM users WHERE id = ?').get('real-user') as
      { id: string; org_id: string; email: string; role: string } | undefined;
    db.close();

    assert.ok(row, 'the real record must still exist after the restart');
    assert.equal(row!.email, 'real.admin@realcompany.example');
    assert.equal(row!.role, 'admin');
  });

  test('refuses to start at all without DB_PATH', async () => {
    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', startScript],
      {
        env: {
          ...process.env, DB_PATH: '',
          JWT_SECRET: 'boot-test-jwt-secret', STORAGE_SECRET: 'boot-test-storage-secret',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );

    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.notEqual(code, 0, 'must exit non-zero rather than boot against an in-memory database');
    assert.match(Buffer.concat(stderr).toString(), /DB_PATH is not set/);
  });

  test('refuses to start with the local storage driver and no PUBLIC_BASE_URL', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-boot-test-nopublicurl-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', startScript],
      {
        env: {
          ...process.env,
          DB_PATH: join(dir, 'prod.db'),
          JWT_SECRET: 'boot-test-jwt-secret',
          STORAGE_SECRET: 'boot-test-storage-secret',
          PUBLIC_BASE_URL: '',
          S3_BUCKET: '',
        },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );

    const stderr: Buffer[] = [];
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));
    assert.notEqual(code, 0, 'must exit non-zero rather than silently mint localhost evidence links');
    assert.match(Buffer.concat(stderr).toString(), /PUBLIC_BASE_URL is not set/);
  });

  test('PUBLIC_BASE_URL is not required when S3_BUCKET is configured', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-boot-test-s3-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const child = spawn(
      process.execPath,
      ['--experimental-strip-types', startScript],
      {
        env: {
          ...process.env,
          DB_PATH: join(dir, 'prod.db'),
          JWT_SECRET: 'boot-test-jwt-secret',
          STORAGE_SECRET: '',
          PUBLIC_BASE_URL: '',
          S3_BUCKET: 'not-a-real-bucket',
          PORT: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let settled = false;
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { if (!settled) { settled = true; child.kill(); reject(new Error('timed out')); } }, 10_000);
      child.stdout?.on('data', (chunk: Buffer) => {
        if (!settled && chunk.toString().includes('API listening on port')) {
          settled = true; clearTimeout(timeout); resolve();
        }
      });
      child.once('exit', (code) => {
        if (!settled) { settled = true; clearTimeout(timeout); reject(new Error(`exited early (code ${code})`)); }
      });
    });

    await ready;
    await stop(child);
  });
});

describe('graceful shutdown (Stage 16A)', () => {
  test('SIGTERM triggers a graceful shutdown, not raw signal termination', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-shutdown-sigterm-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const child = await bootStartScript(join(dir, 'prod.db'));
    child.kill('SIGTERM');
    const { code, signal } = await waitForExit(child);

    // An unhandled SIGTERM kills the process by the signal (code: null,
    // signal: 'SIGTERM'). Reaching process.exit(0) instead — code 0, no
    // killing signal — is only possible through the graceful handler.
    assert.equal(code, 0, 'the graceful handler must call process.exit(0) on a clean shutdown');
    assert.equal(signal, null, 'the process must exit voluntarily, not be killed by the raw signal');
  });

  test('SIGINT triggers the same graceful shutdown', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-shutdown-sigint-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const child = await bootStartScript(join(dir, 'prod.db'));
    child.kill('SIGINT');
    const { code, signal } = await waitForExit(child);

    assert.equal(code, 0);
    assert.equal(signal, null);
  });

  test('a second signal while shutdown is already in progress does not run shutdown twice', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-shutdown-idempotent-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const child = await bootStartScript(join(dir, 'prod.db'));
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

    // Both signals land while the process is still up; the second must be a
    // no-op rather than a second attempt to close the server/database.
    child.kill('SIGTERM');
    child.kill('SIGINT');
    const { code, signal } = await waitForExit(child);

    assert.equal(code, 0, 'must still exit cleanly exactly once');
    assert.equal(signal, null);

    const stderrText = Buffer.concat(stderr).toString();
    assert.doesNotMatch(
      stderrText, /Error while closing/,
      'a second signal must not cause a double-close error',
    );

    // The idempotency guard must have short-circuited the second signal
    // entirely — the shutdown-start log line should appear exactly once,
    // not twice.
    const receivedCount = (Buffer.concat(stdout).toString().match(/Received SIG/g) ?? []).length;
    assert.equal(receivedCount, 1, 'shutdown must only start once, even though two signals arrived');
  });

  test('the database remains valid, and the app can restart against it, after a graceful shutdown', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-shutdown-restart-'));
    const dbPath = join(dir, 'prod.db');
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const first = await bootStartScript(dbPath);
    first.kill('SIGTERM');
    const firstExit = await waitForExit(first);
    assert.equal(firstExit.code, 0);

    const db = new DatabaseSync(dbPath);
    const integrity = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
    db.close();
    assert.equal(integrity.length, 1);
    assert.equal(integrity[0]!.integrity_check, 'ok', 'the database must still pass integrity_check after a graceful shutdown');

    // Restart against the exact same file — proves shutdown actually released
    // the database (no lingering lock) rather than merely exiting the process.
    const second = await bootStartScript(dbPath);
    second.kill('SIGTERM');
    const secondExit = await waitForExit(second);
    assert.equal(secondExit.code, 0, 'a restart against the same database must also boot and shut down cleanly');
  });

  test('existing HTTP behavior is unaffected: the server answers real requests before a graceful shutdown', async (t) => {
    const dir = mkdtempSync(join(tmpdir(), 'dp-shutdown-http-'));
    t.after(() => rmSync(dir, { recursive: true, force: true }));

    const port = await getFreePort();
    const child = await bootStartScript(join(dir, 'prod.db'), { PORT: String(port) });

    const response = await fetch(`http://localhost:${port}/v1/health`);
    assert.equal(response.status, 200);
    const body = await response.json() as { status: string };
    assert.equal(body.status, 'ok');

    child.kill('SIGTERM');
    const { code } = await waitForExit(child);
    assert.equal(code, 0);
  });
});
