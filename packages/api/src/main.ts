/**
 * Dev entrypoint. Boots an in-memory database, seeds it, and serves the API.
 *
 * Set DB_PATH to persist between restarts.
 */

import { openDb } from './lib/db.ts';
import { seed } from './lib/seed.ts';
import { createServer } from './server.ts';

const db = openDb(process.env.DB_PATH ?? ':memory:');
const result = seed(db);

const port = Number(process.env.PORT ?? 3000);
createServer(db).listen(port, () => {
  console.log(`\nAPI listening on http://localhost:${port}`);
  console.log(`Seeded ${result.lineCount} vehicles (${result.rejectedCount} rejected)\n`);
  console.log('Logins (all use the same password):');
  for (const user of result.users) console.log(`  ${user.role.padEnd(14)} ${user.email}`);
  console.log(`  password       ${result.users[0]!.password}\n`);
  console.log(`  locationId     ${result.locationId}\n`);
});
