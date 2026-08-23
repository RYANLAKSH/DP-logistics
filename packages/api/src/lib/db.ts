/**
 * Database access.
 *
 * Development runs on node:sqlite so the stack starts with no infrastructure.
 * Production targets PostgreSQL — see docs/data-model.md. The schema below is
 * deliberately held to a portable SQL subset (no SQLite-specific types, no
 * Postgres-specific ones) so the dialect gap stays small, but the two will
 * still need a real migration before launch. Notably:
 *   - UUIDs are TEXT here, uuid there
 *   - timestamps are ISO-8601 TEXT here, timestamptz there
 *   - the partial unique index below is written in a form both accept
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

export type Db = DatabaseSync;

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS organizations (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS locations (
  id       TEXT PRIMARY KEY,
  org_id   TEXT NOT NULL REFERENCES organizations(id),
  code     TEXT NOT NULL,
  name     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES organizations(id),
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  role           TEXT NOT NULL CHECK (role IN ('field_officer','supervisor','admin','auditor')),
  is_active      INTEGER NOT NULL DEFAULT 1,
  last_login_at  TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (org_id, email)
);

CREATE TABLE IF NOT EXISTS user_locations (
  user_id      TEXT NOT NULL REFERENCES users(id),
  location_id  TEXT NOT NULL REFERENCES locations(id),
  PRIMARY KEY (user_id, location_id)
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id),
  device_id    TEXT NOT NULL,
  platform     TEXT,
  model        TEXT,
  app_version  TEXT,
  approved_at  TEXT,
  approved_by  TEXT REFERENCES users(id),
  last_seen_at TEXT,
  created_at   TEXT NOT NULL,
  UNIQUE (user_id, device_id)
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id),
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  revoked_at  TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS pickup_reports (
  id                 TEXT PRIMARY KEY,
  org_id             TEXT NOT NULL REFERENCES organizations(id),
  location_id        TEXT NOT NULL REFERENCES locations(id),
  reference_no       TEXT NOT NULL,
  version            INTEGER NOT NULL DEFAULT 1,
  delivery_order     TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('draft','active','superseded','cancelled')),
  supersedes_id      TEXT REFERENCES pickup_reports(id),
  valid_from         TEXT NOT NULL,
  valid_to           TEXT NOT NULL,
  source_file_name   TEXT,
  source_file_sha256 TEXT,
  uploaded_by        TEXT NOT NULL REFERENCES users(id),
  committed_at       TEXT,
  created_at         TEXT NOT NULL,
  UNIQUE (org_id, reference_no, version)
);

CREATE TABLE IF NOT EXISTS pickup_report_lines (
  id                TEXT PRIMARY KEY,
  report_id         TEXT NOT NULL REFERENCES pickup_reports(id),
  line_no           INTEGER NOT NULL,
  container_no      TEXT NOT NULL,
  vin               TEXT NOT NULL,
  make              TEXT,
  model             TEXT,
  variant           TEXT,
  colour            TEXT,
  load_position     INTEGER,
  booking_ref       TEXT,
  destination_port  TEXT,
  raw_row           TEXT NOT NULL,
  UNIQUE (report_id, vin)
);

CREATE INDEX IF NOT EXISTS idx_lines_container ON pickup_report_lines (container_no);
CREATE INDEX IF NOT EXISTS idx_lines_vin       ON pickup_report_lines (vin);
CREATE INDEX IF NOT EXISTS idx_lines_report    ON pickup_report_lines (report_id);

CREATE TABLE IF NOT EXISTS scan_sessions (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  officer_id   TEXT NOT NULL REFERENCES users(id),
  device_id    TEXT REFERENCES devices(id),
  location_id  TEXT NOT NULL REFERENCES locations(id),
  started_at   TEXT NOT NULL,
  received_at  TEXT NOT NULL,
  app_version  TEXT
);

CREATE TABLE IF NOT EXISTS scans (
  id                TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES scan_sessions(id),
  scan_type         TEXT NOT NULL CHECK (scan_type IN ('container','vin','other')),
  image_key         TEXT,
  image_sha256      TEXT,
  image_content_type TEXT,
  image_bytes       INTEGER,
  image_uploaded_at TEXT,
  /* 0 = declared but unverified, 1 = bytes on disk match the declared hash.
     Only a verified image is defensible evidence. */
  image_verified    INTEGER NOT NULL DEFAULT 0,
  ocr_raw_text      TEXT,
  ocr_confidence    REAL,
  ocr_engine        TEXT,
  detected_value    TEXT,
  final_value       TEXT NOT NULL,
  was_manual_entry  INTEGER NOT NULL DEFAULT 0,
  check_digit_ok    INTEGER,
  gps_lat           REAL,
  gps_lng           REAL,
  gps_accuracy_m    REAL,
  captured_at       TEXT NOT NULL,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_scans_session ON scans (session_id);

CREATE TABLE IF NOT EXISTS reconciliations (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id),
  session_id        TEXT NOT NULL REFERENCES scan_sessions(id),
  container_scan_id TEXT REFERENCES scans(id),
  vin_scan_id       TEXT REFERENCES scans(id),
  container_no      TEXT NOT NULL,
  vin               TEXT NOT NULL,
  report_id         TEXT REFERENCES pickup_reports(id),
  report_version    INTEGER,
  report_line_id    TEXT REFERENCES pickup_report_lines(id),
  outcome           TEXT NOT NULL,
  reason_code       TEXT NOT NULL,
  severity          TEXT NOT NULL,
  match_confidence  REAL NOT NULL DEFAULT 0,
  device_outcome    TEXT,
  outcome_differs   INTEGER NOT NULL DEFAULT 0,
  overridden        INTEGER NOT NULL DEFAULT 0,
  override_by       TEXT REFERENCES users(id),
  override_reason   TEXT,
  override_at       TEXT,
  supersedes_id     TEXT REFERENCES reconciliations(id),
  officer_id        TEXT NOT NULL REFERENCES users(id),
  message           TEXT NOT NULL,
  detail            TEXT,
  reconciled_at     TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_recon_time      ON reconciliations (org_id, reconciled_at DESC);
CREATE INDEX IF NOT EXISTS idx_recon_container ON reconciliations (container_no);
CREATE INDEX IF NOT EXISTS idx_recon_vin       ON reconciliations (vin);

/*
 * The structural guarantee that a vehicle cannot be loaded into two containers:
 * at most one live MATCH per report line. Superseded rows are excluded so an
 * override can replace a decision without tripping the constraint.
 */
CREATE UNIQUE INDEX IF NOT EXISTS idx_recon_one_live_match
  ON reconciliations (report_line_id)
  WHERE outcome = 'MATCH' AND supersedes_id IS NULL AND overridden = 0;

CREATE TABLE IF NOT EXISTS notification_recipients (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organizations(id),
  event_type  TEXT NOT NULL,
  location_id TEXT REFERENCES locations(id),
  email       TEXT NOT NULL,
  is_active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS notifications (
  id                TEXT PRIMARY KEY,
  reconciliation_id TEXT REFERENCES reconciliations(id),
  event_type        TEXT NOT NULL,
  recipients        TEXT NOT NULL,
  subject           TEXT NOT NULL,
  body              TEXT,
  provider          TEXT NOT NULL,
  provider_msg_id   TEXT,
  status            TEXT NOT NULL,
  error             TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  queued_at         TEXT NOT NULL,
  sent_at           TEXT
);

/*
 * Trade documents: the paperwork a shipment travels on.
 *
 * Kept in one table with a type rather than a table per document kind, because
 * the set grows (VGM certificates, exam reports, EGM) and the handling is
 * identical: upload, hash-verify, link, retain, serve under audit.
 */
CREATE TABLE IF NOT EXISTS documents (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id),
  doc_type          TEXT NOT NULL,
  /* The issuer's own reference: invoice number, shipping bill number, DO
     number. Not unique — amendments and reissues share it. */
  reference_no      TEXT,
  issued_on         TEXT,
  /* Free-form issuer name; these come from many parties (CHA, exporter,
     customs, shipping line). */
  issued_by         TEXT,

  file_name         TEXT,
  file_key          TEXT,
  file_sha256       TEXT,
  file_content_type TEXT,
  file_bytes        INTEGER,
  uploaded_at       TEXT,
  /* Same discipline as scan evidence: declared before upload, checked after. */
  verified          INTEGER NOT NULL DEFAULT 0,

  /* Text pulled out of the document, used for auto-linking and search. */
  extracted_text    TEXT,
  /* Mirrors the latest ocr_jobs row so listing documents does not need a join.
     NULL means no recognition was ever attempted. */
  ocr_state         TEXT,

  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','superseded','void')),
  supersedes_id     TEXT REFERENCES documents(id),

  uploaded_by       TEXT NOT NULL REFERENCES users(id),
  location_id       TEXT REFERENCES locations(id),
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_type   ON documents (org_id, doc_type);
CREATE INDEX IF NOT EXISTS idx_documents_ref    ON documents (reference_no);
CREATE INDEX IF NOT EXISTS idx_documents_status ON documents (status);

/*
 * What each document covers.
 *
 * Deliberately many-to-many: one commercial invoice covers many VINs, one VIN
 * appears on an invoice, a packing list, a shipping bill and an LEO. Modelling
 * this as a column on either side would force duplication and then divergence.
 */
CREATE TABLE IF NOT EXISTS document_links (
  document_id  TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type  TEXT NOT NULL CHECK (entity_type IN
                 ('container','vin','delivery_order','pickup_report','booking')),
  entity_id    TEXT NOT NULL,
  /* 'extracted' = we found the identifier in the document text;
     'manual'    = a human asserted the link.
     Worth distinguishing: an extracted link is evidence of what the document
     says, a manual one is someone's claim about it. */
  link_source  TEXT NOT NULL DEFAULT 'manual'
                 CHECK (link_source IN ('manual','extracted')),
  created_at   TEXT NOT NULL,
  PRIMARY KEY (document_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_doc_links_entity ON document_links (entity_type, entity_id);

/*
 * Which document types a shipment must have before it can move.
 *
 * Configurable per org because the required set differs by trade lane and by
 * customer, and hardcoding it would mean a code change every time a new
 * requirement appears.
 */
CREATE TABLE IF NOT EXISTS document_requirements (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organizations(id),
  doc_type     TEXT NOT NULL,
  /* Stage at which it becomes mandatory. */
  required_at  TEXT NOT NULL DEFAULT 'before_dispatch',
  is_active    INTEGER NOT NULL DEFAULT 1,
  UNIQUE (org_id, doc_type, required_at)
);

/*
 * Text recognition jobs for scanned documents.
 *
 * A separate table rather than columns on documents because OCR is genuinely
 * asynchronous — Textract's multi-page path returns a job id and you poll it —
 * and because it is billed per page, so the attempt history is a cost record as
 * well as a status.
 */
CREATE TABLE IF NOT EXISTS ocr_jobs (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL REFERENCES organizations(id),
  document_id       TEXT NOT NULL REFERENCES documents(id),
  provider          TEXT NOT NULL,
  state             TEXT NOT NULL CHECK (state IN
                      ('queued','running','pending_provider','done','failed','skipped')),
  /* Provider-side job handle, for the async multi-page path. */
  provider_job_ref  TEXT,
  pages             INTEGER,
  attempts          INTEGER NOT NULL DEFAULT 0,
  error             TEXT,
  /* What the extracted text linked to, as JSON arrays. Kept on the job so a
     re-run can be compared against what the previous pass concluded. */
  linked_containers TEXT,
  linked_vins       TEXT,
  unmatched         TEXT,
  /* Set when the text was copied from an identical file already recognised —
     the same document gets uploaded more than once, and paying Textract twice
     for identical bytes is waste. */
  reused_from_id    TEXT REFERENCES documents(id),
  queued_at         TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT
);

CREATE INDEX IF NOT EXISTS idx_ocr_state ON ocr_jobs (state);
CREATE INDEX IF NOT EXISTS idx_ocr_document ON ocr_jobs (document_id);

/*
 * Who looked at which evidence image, and when. Separate from audit_log
 * because reads are high-volume and the retention question differs: the audit
 * log is kept for years, access records for months.
 */
CREATE TABLE IF NOT EXISTS evidence_access_log (
  id                TEXT PRIMARY KEY,
  org_id            TEXT NOT NULL,
  actor_id          TEXT REFERENCES users(id),
  scan_id           TEXT REFERENCES scans(id),
  document_id       TEXT REFERENCES documents(id),
  reconciliation_id TEXT REFERENCES reconciliations(id),
  action            TEXT NOT NULL,
  ip                TEXT,
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evidence_access_scan ON evidence_access_log (scan_id);

CREATE TABLE IF NOT EXISTS audit_log (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL,
  actor_id    TEXT,
  action      TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   TEXT,
  before_json TEXT,
  after_json  TEXT,
  ip          TEXT,
  created_at  TEXT NOT NULL
);
`;

/**
 * Columns added after the first release.
 *
 * CREATE TABLE IF NOT EXISTS silently does nothing for a database that already
 * has the table, so new columns need an explicit ALTER. Checked against
 * table_info so it is safe to run on every boot.
 */
const ADDED_COLUMNS: [table: string, column: string, definition: string][] = [
  ['evidence_access_log', 'document_id', 'TEXT'],
  ['documents', 'ocr_state', 'TEXT'],
  ['scans', 'image_content_type', 'TEXT'],
  ['scans', 'image_bytes', 'INTEGER'],
  ['scans', 'image_uploaded_at', 'TEXT'],
  ['scans', 'image_verified', 'INTEGER NOT NULL DEFAULT 0'],
  ['devices', 'revoked_at', 'TEXT'],
  ['refresh_tokens', 'device_row_id', 'TEXT'],
];

export function migrate(db: Db): void {
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (columns.length === 0) continue; // table absent entirely
    if (columns.some((existing) => existing.name === column)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function openDb(path = ':memory:'): Db {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export const newId = (): string => randomUUID();
export const nowIso = (): string => new Date().toISOString();

/** Append-only audit write. Every mutation of consequence goes through here. */
export function audit(
  db: Db,
  entry: {
    orgId: string;
    actorId?: string | null;
    action: string;
    entityType: string;
    entityId?: string | null;
    before?: unknown;
    after?: unknown;
    ip?: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (id, org_id, actor_id, action, entity_type, entity_id,
                            before_json, after_json, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    newId(),
    entry.orgId,
    entry.actorId ?? null,
    entry.action,
    entry.entityType,
    entry.entityId ?? null,
    entry.before === undefined ? null : JSON.stringify(entry.before),
    entry.after === undefined ? null : JSON.stringify(entry.after),
    entry.ip ?? null,
    nowIso(),
  );
}
