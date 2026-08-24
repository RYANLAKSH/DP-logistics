/**
 * Backup and restore for the SQLite database and the local evidence store.
 *
 * The database alone is not a usable backup: `scans.image_key`/`image_sha256`
 * and `documents.file_key`/`file_sha256` are metadata pointing at files that
 * live only on disk — the bytes are never in the database. The evidence
 * directory alone is equally useless: nothing on disk says which
 * reconciliation, officer, or organization a file belongs to, or whether it
 * was ever verified. A backup is only meaningful as the pair, taken together,
 * which is what this module produces and can prove is still true on restore.
 *
 * The database half uses node:sqlite's own `backup()` (SQLite's Online
 * Backup API) rather than copying the live file — empirically confirmed
 * during development to remain consistent and to produce a file that passes
 * `PRAGMA integrity_check` even while writes are landing on the source
 * concurrently, which a plain `cp` of a live file cannot promise. The
 * evidence half is a plain recursive file copy: bytes are never
 * recompressed or transformed, so a file's hash cannot change in transit.
 *
 * Integrity checking reuses the application's own SHA-256 discipline (the
 * same one evidence.ts/documents.ts use to verify uploads) rather than
 * inventing a second one: every *verified* scan/document image is expected,
 * by the database's own record, to exist at its key with a specific hash —
 * the manifest simply checks that this is still true of what got copied.
 */

import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import {
  existsSync, mkdirSync, readdirSync, statSync, readFileSync, writeFileSync, cpSync, rmSync, chmodSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDb } from './db.ts';

/* ------------------------------------------------------------------ *
 * Shared types
 * ------------------------------------------------------------------ */

export interface EvidenceManifestEntry {
  path: string;    // relative to the evidence directory
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  backupId: string;
  createdAt: string;
  appVersion: string | null;
  source: { dbPath: string; storageDir: string };
  database: { fileName: string; bytes: number; sha256: string; pagesCopied: number };
  evidence: { fileCount: number; totalBytes: number; files: EvidenceManifestEntry[] };
  verification: {
    verifiedScans: number;
    verifiedDocuments: number;
    matchedCount: number;
    missing: string[];
    hashMismatch: string[];
    orphanedCount: number;
  };
  /** 'ok' only if every verified scan/document image resolved to a present, matching file. */
  status: 'ok' | 'incomplete';
}

const readAppVersion = (): string | null => {
  try {
    const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
    return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
};

const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/** Lists every file under root, recursively, as paths relative to root. */
function walkFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(relative(root, full));
    }
  }
  return out.sort();
}

/**
 * Backups contain the same sensitive evidence and personal data the live
 * system does, so every file and directory under root is locked down to
 * owner-only — belt-and-braces alongside the 0700 mode already given to the
 * backup's top-level directory when it is created.
 */
function lockDownPermissions(root: string): void {
  if (!existsSync(root)) return;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    chmodSync(dir, 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) chmodSync(full, 0o600);
    }
  }
}

interface VerifiedRef { key: string; sha256: string; kind: 'scan' | 'document' }

/** Every image the database itself considers verified evidence. */
function collectVerifiedRefs(dbPath: string): VerifiedRef[] {
  const db = new DatabaseSync(dbPath);
  try {
    const scans = db
      .prepare(`SELECT image_key AS key, image_sha256 AS sha256 FROM scans
                 WHERE image_key IS NOT NULL AND image_verified = 1`)
      .all() as { key: string; sha256: string }[];
    const documents = db
      .prepare(`SELECT file_key AS key, file_sha256 AS sha256 FROM documents
                 WHERE file_key IS NOT NULL AND verified = 1`)
      .all() as { key: string; sha256: string }[];
    return [
      ...scans.map((r) => ({ ...r, kind: 'scan' as const })),
      ...documents.map((r) => ({ ...r, kind: 'document' as const })),
    ];
  } finally {
    db.close();
  }
}

/* ------------------------------------------------------------------ *
 * Backup
 * ------------------------------------------------------------------ */

export interface CreateBackupOptions {
  dbPath: string;
  storageDir: string;
  backupDir: string;
}

export interface CreateBackupResult {
  backupId: string;
  backupPath: string;
  manifest: BackupManifest;
}

export async function createBackup(options: CreateBackupOptions): Promise<CreateBackupResult> {
  const { dbPath, storageDir, backupDir } = options;

  if (!existsSync(dbPath)) {
    throw new Error(`No database found at ${dbPath} — nothing to back up.`);
  }

  const backupId = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = join(backupDir, backupId);
  if (existsSync(backupPath)) {
    throw new Error(`Backup target ${backupPath} already exists — refusing to overwrite it.`);
  }
  mkdirSync(backupPath, { recursive: true, mode: 0o700 });

  // Database half: SQLite's own Online Backup API, safe against a live,
  // concurrently-written source (see this module's header comment).
  const dbBackupPath = join(backupPath, 'database.sqlite');
  const sourceDb = openDb(dbPath);
  let pagesCopied: number;
  try {
    pagesCopied = await sqliteBackup(sourceDb, dbBackupPath);
  } finally {
    sourceDb.close();
  }
  chmodSync(dbBackupPath, 0o600);

  // Evidence half: a raw recursive copy. No transformation, so no file's
  // hash can change in transit.
  const evidenceBackupPath = join(backupPath, 'evidence');
  if (existsSync(storageDir)) {
    cpSync(storageDir, evidenceBackupPath, { recursive: true });
  } else {
    mkdirSync(evidenceBackupPath, { recursive: true });
  }
  lockDownPermissions(evidenceBackupPath);

  const evidenceFiles: EvidenceManifestEntry[] = walkFiles(evidenceBackupPath).map((relPath) => {
    const full = join(evidenceBackupPath, relPath);
    return { path: relPath, bytes: statSync(full).size, sha256: sha256File(full) };
  });
  const evidenceHashByPath = new Map(evidenceFiles.map((f) => [f.path, f.sha256]));

  // Cross-check: every verified scan/document image the database records
  // must resolve, by key, to a file that was actually copied — with the
  // exact hash the database declared it should have.
  const verifiedRefs = collectVerifiedRefs(dbBackupPath);
  const missing: string[] = [];
  const hashMismatch: string[] = [];
  let matchedCount = 0;
  for (const ref of verifiedRefs) {
    const actual = evidenceHashByPath.get(ref.key);
    if (actual === undefined) missing.push(ref.key);
    else if (actual !== ref.sha256) hashMismatch.push(ref.key);
    else matchedCount++;
  }
  const referencedKeys = new Set(verifiedRefs.map((r) => r.key));
  const orphanedCount = evidenceFiles.filter((f) => !referencedKeys.has(f.path)).length;

  const manifest: BackupManifest = {
    backupId,
    createdAt: new Date().toISOString(),
    appVersion: readAppVersion(),
    source: { dbPath: resolve(dbPath), storageDir: resolve(storageDir) },
    database: {
      fileName: 'database.sqlite',
      bytes: statSync(dbBackupPath).size,
      sha256: sha256File(dbBackupPath),
      pagesCopied,
    },
    evidence: {
      fileCount: evidenceFiles.length,
      totalBytes: evidenceFiles.reduce((sum, f) => sum + f.bytes, 0),
      files: evidenceFiles,
    },
    verification: {
      verifiedScans: verifiedRefs.filter((r) => r.kind === 'scan').length,
      verifiedDocuments: verifiedRefs.filter((r) => r.kind === 'document').length,
      matchedCount,
      missing,
      hashMismatch,
      orphanedCount,
    },
    status: missing.length === 0 && hashMismatch.length === 0 ? 'ok' : 'incomplete',
  };

  writeFileSync(join(backupPath, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });

  return { backupId, backupPath, manifest };
}

/* ------------------------------------------------------------------ *
 * Restore
 * ------------------------------------------------------------------ */

export interface RestoreOptions {
  backupSourceDir: string;
  restoreTargetDir: string;
  /** Guard rails: if set, refuses to restore on top of the live paths in use. */
  liveDbPath?: string;
  liveStorageDir?: string;
}

export interface RestoreResult {
  ok: boolean;
  restoredDbPath: string;
  restoredStorageDir: string;
  integrityCheck: { ok: boolean; detail: string };
  evidenceCheck: { checked: number; missing: string[]; hashMismatch: string[] };
  relationshipCheck: { verifiedRefs: number; missing: string[]; hashMismatch: string[] };
  problems: string[];
}

/**
 * Restores a backup into `restoreTargetDir` (never the live paths) and
 * verifies it. Structural problems (no manifest, no database backup, no
 * evidence directory, an unreadable manifest) throw — there is nothing to
 * meaningfully restore. Data-integrity problems (a missing or corrupted
 * evidence file, a failed PRAGMA integrity_check) do not throw: the restore
 * still completes into the target directory for inspection, and the
 * returned result's `ok` is false with `problems` explaining why. Promoting
 * a restored copy into the live paths is never done here — see docs/running.md.
 */
export async function restoreBackup(options: RestoreOptions): Promise<RestoreResult> {
  const { backupSourceDir, restoreTargetDir } = options;

  const manifestPath = join(backupSourceDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`${manifestPath} does not exist — ${backupSourceDir} is not a valid backup.`);
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (error) {
    throw new Error(`${manifestPath} is not valid JSON — the backup manifest is corrupt: ${
      error instanceof Error ? error.message : String(error)}`);
  }

  const srcDbPath = join(backupSourceDir, manifest.database?.fileName ?? 'database.sqlite');
  if (!existsSync(srcDbPath)) {
    throw new Error(`${srcDbPath} is missing — this backup has no database file.`);
  }
  const srcEvidenceDir = join(backupSourceDir, 'evidence');
  if (!existsSync(srcEvidenceDir)) {
    throw new Error(`${srcEvidenceDir} is missing — this backup has no evidence directory.`);
  }

  if (options.liveDbPath && resolve(restoreTargetDir) === resolve(dirname(options.liveDbPath))) {
    throw new Error('Refusing to restore into the directory holding the live DB_PATH.');
  }
  if (options.liveStorageDir && resolve(restoreTargetDir) === resolve(options.liveStorageDir)) {
    throw new Error('Refusing to restore into the live STORAGE_DIR.');
  }
  if (existsSync(restoreTargetDir)) {
    throw new Error(`${restoreTargetDir} already exists — remove it or choose a different target.`);
  }

  mkdirSync(restoreTargetDir, { recursive: true, mode: 0o700 });
  const restoredDbPath = join(restoreTargetDir, 'database.sqlite');
  const restoredStorageDir = join(restoreTargetDir, 'evidence');
  cpSync(srcDbPath, restoredDbPath);
  chmodSync(restoredDbPath, 0o600);
  cpSync(srcEvidenceDir, restoredStorageDir, { recursive: true });
  lockDownPermissions(restoredStorageDir);

  const problems: string[] = [];

  // 1. Database integrity. Brought up through openDb() so the restored file
  // also picks up any additive schema migration the current code expects —
  // the same idempotent path a normal boot uses (see db.ts's migrate()).
  let integrityOk = false;
  let integrityDetail = '';
  try {
    const db = openDb(restoredDbPath);
    try {
      const rows = db.prepare('PRAGMA integrity_check').all() as { integrity_check: string }[];
      integrityDetail = rows.map((r) => r.integrity_check).join('; ');
      integrityOk = rows.length === 1 && rows[0]!.integrity_check === 'ok';
    } finally {
      db.close();
    }
  } catch (error) {
    integrityDetail = error instanceof Error ? error.message : String(error);
  }
  if (!integrityOk) problems.push(`database integrity check failed: ${integrityDetail}`);

  // 2. Every file the manifest recorded still exists, unmodified.
  const evMissing: string[] = [];
  const evMismatch: string[] = [];
  for (const file of manifest.evidence?.files ?? []) {
    const full = join(restoredStorageDir, file.path);
    if (!existsSync(full)) { evMissing.push(file.path); continue; }
    const actual = sha256File(full);
    if (actual !== file.sha256) evMismatch.push(file.path);
  }
  if (evMissing.length) problems.push(`${evMissing.length} evidence file(s) from the manifest are missing after restore`);
  if (evMismatch.length) problems.push(`${evMismatch.length} evidence file(s) do not match their manifest hash`);

  // 3. The database/evidence relationship, re-checked directly against the
  // restored database rather than trusting the manifest's own copy of it.
  const relRefs = integrityOk ? collectVerifiedRefs(restoredDbPath) : [];
  const relMissing: string[] = [];
  const relMismatch: string[] = [];
  for (const ref of relRefs) {
    const full = join(restoredStorageDir, ref.key);
    if (!existsSync(full)) { relMissing.push(ref.key); continue; }
    if (sha256File(full) !== ref.sha256) relMismatch.push(ref.key);
  }
  if (relMissing.length) problems.push(`${relMissing.length} verified database record(s) reference evidence missing after restore`);
  if (relMismatch.length) problems.push(`${relMismatch.length} verified database record(s) reference evidence with a mismatched hash after restore`);

  return {
    ok: problems.length === 0,
    restoredDbPath,
    restoredStorageDir,
    integrityCheck: { ok: integrityOk, detail: integrityDetail },
    evidenceCheck: { checked: manifest.evidence?.files?.length ?? 0, missing: evMissing, hashMismatch: evMismatch },
    relationshipCheck: { verifiedRefs: relRefs.length, missing: relMissing, hashMismatch: relMismatch },
    problems,
  };
}

/** Removes a directory tree produced by createBackup/restoreBackup. Test/CLI convenience. */
export function removeDir(path: string): void {
  if (existsSync(path)) rmSync(path, { recursive: true, force: true });
}
