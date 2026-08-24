/**
 * Production entrypoint.
 *
 * Unlike main.ts (dev), this:
 *   - requires DB_PATH. Refuses to boot against an ephemeral in-memory
 *     database, since data that vanishes on restart is never appropriate
 *     outside development.
 *   - requires PUBLIC_BASE_URL whenever the local storage driver is in play
 *     (no S3_BUCKET). getStorage() itself still defaults it to localhost —
 *     correct for dev, where main.ts relies on exactly that — but a
 *     production boot with no real public URl configured would silently mint
 *     every evidence/document link pointing at localhost, which is a
 *     production-only failure mode dev never hits and getStorage() has no way
 *     to distinguish on its own.
 *   - validates required secrets eagerly, at boot, rather than deferring the
 *     failure to whichever request happens to need them first.
 *   - never seeds demo data. There is no code path here that can create a
 *     demo organization, user, location, device, or report — nothing here
 *     imports seed.ts at all.
 *
 * To populate a fresh production database with the reference fixture data
 * (useful for a demo or a dry run, not for real operation), run
 * `npm run seed -w @dp/api` separately, once, against the same DB_PATH,
 * before starting this. A real deployment should otherwise create its first
 * real organization and users through the admin API instead.
 */

import { openDb } from './lib/db.ts';
import { getJwtSecret } from './lib/auth.ts';
import { getStorage } from './lib/storage.ts';
import { createServer } from './server.ts';
import { getOcrProvider } from './modules/ocr.ts';
import { startOcrWorker } from './modules/ocrWorker.ts';

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  throw new Error(
    'DB_PATH is not set. Refusing to start in production against an in-memory ' +
    'database that would lose all data on the next restart.',
  );
}

if (!process.env.S3_BUCKET && !process.env.PUBLIC_BASE_URL?.trim()) {
  throw new Error(
    'PUBLIC_BASE_URL is not set. Refusing to start with the local storage ' +
    'driver and no configured public URL — every evidence and document link ' +
    'it mints would silently point at localhost instead of the real domain. ' +
    'Set PUBLIC_BASE_URL to the real public origin (e.g. https://app.example.com), ' +
    'or set S3_BUCKET to use S3-compatible storage instead, which does not need it.',
  );
}

// Fail fast on missing secrets rather than waiting for the first login or
// evidence upload to discover it — both already fail closed on their own,
// this just moves that failure to boot time, where a misconfigured
// deployment gets caught immediately instead of looking healthy until the
// first real request.
getJwtSecret();
getStorage();

const db = openDb(dbPath);

const stopOcrWorker = startOcrWorker(db);

const port = Number(process.env.PORT ?? 3000);
const server = createServer(db).listen(port, () => {
  console.log(`API listening on port ${port}`);
  console.log(`Database: ${dbPath}`);
  console.log(`OCR provider: ${getOcrProvider().name}`);
});

/**
 * Graceful shutdown: stop accepting new HTTP connections, stop the
 * in-process OCR worker, let in-flight requests finish, close the database
 * cleanly, then exit — rather than relying on Node's default behavior for
 * SIGTERM/SIGINT, which terminates immediately with no chance to do any of
 * this. Idempotent: a second signal while shutdown is already in progress
 * is a no-op, not a second attempt to close an already-closing server or an
 * already-closed database.
 */
let shuttingDown = false;

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}, shutting down...`);
  stopOcrWorker();

  // A safety net, not the primary path: if a lingering connection (or
  // anything else) keeps server.close() from ever calling back, do not hang
  // forever with no explanation — say so and exit non-zero.
  const forceExitTimer = setTimeout(() => {
    console.error('Shutdown did not complete within 10s — forcing exit.');
    process.exit(1);
  }, 10_000);
  forceExitTimer.unref();

  server.close((closeError) => {
    clearTimeout(forceExitTimer);

    let exitCode = 0;
    if (closeError) {
      console.error('Error while closing the HTTP server:', closeError);
      exitCode = 1;
    }

    try {
      db.close();
    } catch (dbError) {
      console.error('Error while closing the database:', dbError);
      exitCode = 1;
    }

    process.exit(exitCode);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
