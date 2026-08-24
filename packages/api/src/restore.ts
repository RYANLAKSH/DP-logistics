/**
 * Restore CLI. Restores a backup into a fresh, explicit staging directory and
 * verifies it — it never touches the live database or evidence store, and it
 * never promotes the restored copy into place automatically. See lib/backup.ts
 * for exactly what is checked and docs/running.md for the full procedure,
 * including the manual promote/restart steps this script deliberately does
 * not perform.
 *
 *   BACKUP_SOURCE_DIR=./backups/2026-08-24T19-30-00-000Z \
 *   RESTORE_TARGET_DIR=./restore-test \
 *   npm run restore -w @dp/api
 */

import { restoreBackup } from './lib/backup.ts';

const backupSourceDir = process.env.BACKUP_SOURCE_DIR;
if (!backupSourceDir) {
  throw new Error('BACKUP_SOURCE_DIR is not set. Point it at the specific backup directory to restore.');
}

const restoreTargetDir = process.env.RESTORE_TARGET_DIR;
if (!restoreTargetDir) {
  throw new Error('RESTORE_TARGET_DIR is not set. Point it at an empty staging directory — never the live DB_PATH/STORAGE_DIR.');
}

const result = await restoreBackup({
  backupSourceDir,
  restoreTargetDir,
  liveDbPath: process.env.DB_PATH,
  liveStorageDir: process.env.STORAGE_DIR,
});

console.log(`Restored into ${restoreTargetDir}`);
console.log(`  database integrity check: ${result.integrityCheck.ok ? 'ok' : `FAILED (${result.integrityCheck.detail})`}`);
console.log(`  evidence files checked: ${result.evidenceCheck.checked}, missing: ${result.evidenceCheck.missing.length}, hash mismatch: ${result.evidenceCheck.hashMismatch.length}`);
console.log(`  verified DB->evidence references checked: ${result.relationshipCheck.verifiedRefs}, missing: ${result.relationshipCheck.missing.length}, hash mismatch: ${result.relationshipCheck.hashMismatch.length}`);

if (!result.ok) {
  console.error('\nRESTORE VERIFICATION FAILED:');
  for (const problem of result.problems) console.error(`  - ${problem}`);
  console.error('\nDo not promote this restored copy. Investigate before proceeding.');
  process.exit(1);
}

console.log('\nRestore verification PASSED. This is a staged copy, not yet live. To promote it:');
console.log('  1. Stop the running API process.');
console.log(`  2. Move the current DB_PATH/STORAGE_DIR aside (do not delete them yet).`);
console.log(`  3. Move ${result.restoredDbPath} to the real DB_PATH.`);
console.log(`  4. Move ${result.restoredStorageDir} to the real STORAGE_DIR.`);
console.log('  5. Restart the API process and confirm it serves the restored data correctly.');
console.log('See docs/running.md, "Restore", for the full procedure.');
