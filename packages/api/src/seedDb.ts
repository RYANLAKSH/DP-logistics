/**
 * Explicit database seeding — the reference organization, four demo users,
 * two locations, and a synthetic pickup report, run through the real ingest
 * pipeline.
 *
 * Populates DB_PATH, which is required: seeding an in-memory database from
 * this separate, one-shot process would have no effect, since a running
 * server's in-memory database is not shared with this process's memory.
 *
 * Never invoked automatically by any startup path — see main.ts (dev, which
 * seeds an in-memory database inline instead, for the reason above) and
 * start.ts (production, which never seeds at all).
 */

import { openDb } from './lib/db.ts';
import { seed } from './lib/seed.ts';

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  throw new Error(
    'DB_PATH is not set. Point it at the same file your server uses, e.g.\n' +
    '  DB_PATH=./dev.db npm run seed -w @dp/api',
  );
}

const db = openDb(dbPath);
const result = seed(db);

console.log(`Seeded ${result.lineCount} vehicles (${result.rejectedCount} rejected) into ${dbPath}\n`);
console.log('Logins (all use the same password):');
for (const user of result.users) console.log(`  ${user.role.padEnd(14)} ${user.email}`);
console.log(`  password       ${result.users[0]!.password}\n`);
console.log(`  locationId     ${result.locationId}`);
