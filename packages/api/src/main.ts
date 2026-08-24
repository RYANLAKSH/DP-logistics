/**
 * Dev entrypoint. Boots the API for local development.
 *
 * With no DB_PATH set, boots a fresh in-memory database and seeds it
 * immediately — that is the only way to get a populated in-memory server
 * (a separate process cannot reach into this one's memory), and it is always
 * safe because nothing here persists past this process exiting.
 *
 * Set DB_PATH to develop against a persistent file instead. In that case this
 * does NOT seed automatically — run `npm run seed -w @dp/api` once, against
 * that same DB_PATH, to populate it. This keeps a persistent dev database
 * from silently accumulating a duplicate demo organization on every restart.
 *
 * For production, use `npm start` (src/start.ts) instead — it never seeds,
 * regardless of DB_PATH, and it requires DB_PATH to be set at all.
 */

import { openDb } from './lib/db.ts';
import { seed } from './lib/seed.ts';
import { createServer } from './server.ts';
import { getOcrProvider } from './modules/ocr.ts';
import { startOcrWorker } from './modules/ocrWorker.ts';

const dbPath = process.env.DB_PATH;
const db = openDb(dbPath ?? ':memory:');

// Only the ephemeral in-memory case seeds automatically — see header comment.
const result = dbPath ? undefined : seed(db);

// Recognition runs in-process at this scale. The queue lives in the database,
// so moving to a dedicated worker later means pointing another process at the
// same table.
startOcrWorker(db);

const port = Number(process.env.PORT ?? 3000);
createServer(db).listen(port, () => {
  console.log(`\nAPI listening on http://localhost:${port}`);
  if (result) {
    console.log(`Seeded ${result.lineCount} vehicles (${result.rejectedCount} rejected)\n`);
    console.log('Logins (all use the same password):');
    for (const user of result.users) console.log(`  ${user.role.padEnd(14)} ${user.email}`);
    console.log(`  password       ${result.users[0]!.password}\n`);
    console.log(`  locationId     ${result.locationId}`);
  } else {
    console.log(`Using persistent database at ${dbPath} — not seeding automatically.`);
    console.log(`Run "npm run seed -w @dp/api" once to populate it with demo data.\n`);
  }
  console.log(`  OCR provider   ${getOcrProvider().name}\n`);
});
