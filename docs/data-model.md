# Data Model

PostgreSQL. Abridged DDL — indexes, constraints and the parts that carry meaning.

## Entity overview

```
organizations
   ├── users ──────────────┐
   ├── locations           │
   ├── delivery_orders     │
   │      └── pickup_reports (versioned)
   │              └── pickup_report_lines   ← the expected pairing
   └── scan_sessions ──────┤               │
          └── scans ───────┴───────────────┤
                  └── reconciliations ◄────┘   ← the actual pairing + verdict
                          └── notifications
   audit_log (everything)
```

## Core tables

```sql
CREATE TYPE user_role AS ENUM ('field_officer','supervisor','admin','auditor');

CREATE TABLE users (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID NOT NULL REFERENCES organizations(id),
  email           CITEXT NOT NULL,
  phone           TEXT,
  password_hash   TEXT NOT NULL,           -- argon2id
  full_name       TEXT NOT NULL,
  role            user_role NOT NULL,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at   TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, email)
);

-- Which locations an officer may work. Enforced on report sync and scan submit.
CREATE TABLE user_locations (
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  location_id UUID REFERENCES locations(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, location_id)
);

-- Device binding: an unregistered device requires supervisor approval.
CREATE TABLE devices (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(id),
  device_id     TEXT NOT NULL,             -- stable install id
  platform      TEXT NOT NULL,
  model         TEXT,
  app_version   TEXT,
  approved_at   TIMESTAMPTZ,
  approved_by   UUID REFERENCES users(id),
  last_seen_at  TIMESTAMPTZ,
  UNIQUE (user_id, device_id)
);
```

## Pickup reports

Versioned. An amendment supersedes; it never mutates.

```sql
CREATE TYPE report_status AS ENUM ('draft','active','superseded','cancelled');

CREATE TABLE pickup_reports (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id),
  delivery_order_id  UUID NOT NULL REFERENCES delivery_orders(id),
  location_id        UUID NOT NULL REFERENCES locations(id),
  reference_no       TEXT NOT NULL,        -- DO's own reference
  version            INT  NOT NULL DEFAULT 1,
  status             report_status NOT NULL DEFAULT 'draft',
  supersedes_id      UUID REFERENCES pickup_reports(id),
  valid_from         DATE NOT NULL,
  valid_to           DATE NOT NULL,
  source_file_key    TEXT NOT NULL,        -- original upload, kept forever
  source_file_sha256 TEXT NOT NULL,
  uploaded_by        UUID NOT NULL REFERENCES users(id),
  committed_at       TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, reference_no, version)
);

CREATE TABLE pickup_report_lines (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_id         UUID NOT NULL REFERENCES pickup_reports(id) ON DELETE CASCADE,
  line_no           INT  NOT NULL,

  container_no      CHAR(11) NOT NULL,     -- normalized, check-digit validated at ingest
  container_iso     TEXT,                  -- e.g. 45G1
  seal_no           TEXT,

  chassis_no        TEXT,                  -- expected vehicle
  vehicle_reg_no    TEXT,                  -- secondary identifier, easier to OCR
  transporter       TEXT,
  driver_name       TEXT,                  -- PII: supervisor+ only
  driver_phone      TEXT,                  -- PII

  expected_pickup_at TIMESTAMPTZ,
  raw_row            JSONB NOT NULL,       -- the source row, verbatim
  UNIQUE (report_id, container_no)
);

CREATE INDEX ON pickup_report_lines (container_no);
CREATE INDEX ON pickup_report_lines (chassis_no);
```

`raw_row` is not optional. When a DO disputes a mismatch, you need the row exactly as they
sent it, not your interpretation of it.

## Scans and evidence

```sql
CREATE TYPE scan_type AS ENUM ('container','chassis','vehicle_reg','seal','other');

CREATE TABLE scan_sessions (
  id            UUID PRIMARY KEY,          -- CLIENT-generated; the idempotency key
  org_id        UUID NOT NULL REFERENCES organizations(id),
  officer_id    UUID NOT NULL REFERENCES users(id),
  device_id     UUID REFERENCES devices(id),
  location_id   UUID NOT NULL REFERENCES locations(id),
  started_at    TIMESTAMPTZ NOT NULL,      -- device clock
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),  -- server clock
  clock_skew_s  INT GENERATED ALWAYS AS
                (EXTRACT(EPOCH FROM (received_at - started_at))::INT) STORED,
  app_version   TEXT
);

CREATE TABLE scans (
  id               UUID PRIMARY KEY,       -- client-generated
  session_id       UUID NOT NULL REFERENCES scan_sessions(id) ON DELETE CASCADE,
  scan_type        scan_type NOT NULL,

  image_key        TEXT NOT NULL,          -- S3 key, private
  image_sha256     TEXT NOT NULL,
  thumbnail_key    TEXT,

  ocr_raw_text     TEXT,
  ocr_candidates   JSONB,                  -- [{value, confidence, bbox}]
  ocr_confidence   NUMERIC(4,3),
  ocr_engine       TEXT,                   -- 'mlkit-v2' | 'textract' | ...

  detected_value   TEXT,                   -- what OCR proposed
  final_value      TEXT NOT NULL,          -- what the officer confirmed
  was_manual_entry BOOLEAN NOT NULL DEFAULT FALSE,
  check_digit_ok   BOOLEAN,                -- NULL where not applicable

  gps_lat          NUMERIC(9,6),
  gps_lng          NUMERIC(9,6),
  gps_accuracy_m   NUMERIC(6,1),
  captured_at      TIMESTAMPTZ NOT NULL,   -- device clock
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON scans (final_value);
CREATE INDEX ON scans (session_id, scan_type);
```

Keeping `detected_value` alongside `final_value` and `was_manual_entry` gives you your OCR
accuracy metric for free. Track it — it tells you whether the ML is earning its keep, and
which plate types need a better capture guide.

## Reconciliation — the record that matters

```sql
CREATE TYPE recon_outcome AS ENUM (
  'MATCH',                    -- container + chassis pair as the report says
  'MISMATCH',                 -- both known, wrong pairing
  'CONTAINER_NOT_IN_REPORT',
  'CHASSIS_NOT_IN_REPORT',
  'DUPLICATE',                -- container already reconciled on an active session
  'EXPIRED_REPORT',
  'PENDING'                   -- awaiting the second scan
);

CREATE TABLE reconciliations (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             UUID NOT NULL REFERENCES organizations(id),
  session_id         UUID NOT NULL REFERENCES scan_sessions(id),

  container_scan_id  UUID REFERENCES scans(id),
  chassis_scan_id    UUID REFERENCES scans(id),
  container_no       CHAR(11),
  chassis_no         TEXT,

  report_id          UUID REFERENCES pickup_reports(id),
  report_version     INT,
  report_line_id     UUID REFERENCES pickup_report_lines(id),

  outcome            recon_outcome NOT NULL,
  reason_code        TEXT,                 -- see reconciliation-rules.md §5
  match_confidence   NUMERIC(4,3),         -- fuzzy chassis match score
  device_outcome     recon_outcome,        -- what the phone said, for drift detection
  outcome_differs    BOOLEAN GENERATED ALWAYS AS
                     (device_outcome IS DISTINCT FROM outcome) STORED,

  overridden         BOOLEAN NOT NULL DEFAULT FALSE,
  override_by        UUID REFERENCES users(id),
  override_reason    TEXT,
  override_at        TIMESTAMPTZ,

  supersedes_id      UUID REFERENCES reconciliations(id),  -- append-only corrections
  officer_id         UUID NOT NULL REFERENCES users(id),
  reconciled_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON reconciliations (org_id, reconciled_at DESC);
CREATE INDEX ON reconciliations (outcome) WHERE outcome <> 'MATCH';
CREATE INDEX ON reconciliations (container_no);

-- One active MATCH per container per report version.
CREATE UNIQUE INDEX ON reconciliations (report_line_id)
  WHERE outcome = 'MATCH' AND supersedes_id IS NULL;
```

That partial unique index is what stops the same container being released to two vehicles.
It's a small line with a lot of weight on it.

`outcome_differs` surfaces every case where the offline verdict disagreed with the
authoritative one — your early-warning signal for stale caches and rule drift.

## Notifications and audit

```sql
CREATE TABLE notification_recipients (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        UUID NOT NULL REFERENCES organizations(id),
  event_type    TEXT NOT NULL,             -- 'MATCH','MISMATCH','OVERRIDE_APPLIED',...
  delivery_order_id UUID REFERENCES delivery_orders(id),  -- NULL = all
  location_id   UUID REFERENCES locations(id),            -- NULL = all
  email         CITEXT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE notifications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reconciliation_id  UUID REFERENCES reconciliations(id),
  event_type         TEXT NOT NULL,
  recipients         TEXT[] NOT NULL,
  subject            TEXT NOT NULL,
  provider           TEXT NOT NULL,
  provider_msg_id    TEXT,
  status             TEXT NOT NULL,        -- queued|sent|delivered|bounced|failed
  error              TEXT,
  attempts           INT NOT NULL DEFAULT 0,
  queued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at            TIMESTAMPTZ,
  delivered_at       TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id           BIGSERIAL PRIMARY KEY,
  org_id       UUID NOT NULL,
  actor_id     UUID REFERENCES users(id),
  action       TEXT NOT NULL,              -- 'report.commit','recon.override',...
  entity_type  TEXT NOT NULL,
  entity_id    UUID,
  before       JSONB,
  after        JSONB,
  ip           INET,
  user_agent   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`audit_log` is append-only: `REVOKE UPDATE, DELETE ON audit_log FROM app_user`.

## Session state machine

```
        ┌─────────┐  first scan   ┌─────────┐  second scan  ┌───────────┐
        │  OPEN   │──────────────►│ PENDING │──────────────►│ EVALUATED │
        └─────────┘               └─────────┘               └─────┬─────┘
                                                                  │
                        ┌─────────────────────┬───────────────────┤
                        ▼                     ▼                   ▼
                    ┌───────┐           ┌──────────┐        ┌──────────┐
                    │ MATCH │           │ MISMATCH │        │ EXCEPTION│
                    └───┬───┘           └────┬─────┘        └────┬─────┘
                        │                    │                   │
                   email sent          supervisor alert      ops queue
                        │                    │                   │
                        └────────────► supervisor override ──────┘
                                        (reason required,
                                         new row, supersedes)
```

## Retention

| Data | Retain | Then |
|---|---|---|
| Evidence images | 24 months | Lifecycle → Glacier, or purge per policy |
| Thumbnails | 24 months | Purge with parent |
| Source report files | Indefinite | Small, and disputes reference them |
| Reconciliation records | Indefinite | Small, and they're the audit trail |
| `audit_log` | 7 years | Archive to cold storage |
| PII (driver name/phone) | Per report validity + 12 months | Null out on the line, keep the reconciliation |
