/**
 * Backup CLI. Produces one uniquely-identified backup of the database and
 * evidence store — see lib/backup.ts for what a backup actually contains and
 * why. Standalone: this never touches the running API process, so a backup
 * can run at any time without slowing down uploads, scans, or reconciliation.
 *
 *   DB_PATH=./dev.db STORAGE_DIR=./.evidence npm run backup -w @dp/api
 *
 * BACKUP_DIR (default ./backups) must live outside anything publicly served
 * — it is not, and must never become, a static-file directory.
 */

import { createBackup } from './lib/backup.ts';

const dbPath = process.env.DB_PATH;
if (!dbPath) {
  throw new Error('DB_PATH is not set. Point it at the database file to back up.');
}

const storageDir = process.env.STORAGE_DIR ?? './.evidence';
const backupDir = process.env.BACKUP_DIR ?? './backups';

const { backupId, backupPath, manifest } = await createBackup({ dbPath, storageDir, backupDir });

console.log(`Backup ${backupId} written to ${backupPath}`);
console.log(`  database: ${manifest.database.bytes} bytes, ${manifest.database.pagesCopied} pages`);
console.log(`  evidence: ${manifest.evidence.fileCount} files, ${manifest.evidence.totalBytes} bytes`);
console.log(`  verified scans: ${manifest.verification.verifiedScans}, verified documents: ${manifest.verification.verifiedDocuments}`);
console.log(`  matched: ${manifest.verification.matchedCount}, missing: ${manifest.verification.missing.length}, hash mismatch: ${manifest.verification.hashMismatch.length}`);
console.log(`  status: ${manifest.status}`);

if (manifest.status !== 'ok') {
  console.error('\nBackup completed but is INCOMPLETE — see manifest.json for the specific missing/mismatched keys.');
  process.exit(1);
}
