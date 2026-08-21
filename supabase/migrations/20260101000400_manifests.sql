-- ---------------------------------------------------------------------------
-- Manifests, containers, vehicle assignments, imports, corrections.
--
-- The manifest is the source of truth. Everything here is versioned and
-- append-only at the version level: a correction publishes a new version and
-- archives the old one. Rows in a published version are never edited.
-- ---------------------------------------------------------------------------

-- Staging for an uploaded file, before anything becomes live.
create table manifest_imports (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete restrict,
  yard_id         uuid not null references yards(id) on delete restrict,
  operating_date  date not null,
  file_name       text not null,
  file_path       text not null,               -- Storage key in the `manifests` bucket
  file_sha256     text not null,
  file_bytes      int  not null,
  status          import_status not null default 'PARSING',
  column_map      jsonb,                       -- saved per source; reused next upload
  parsed_rows     jsonb,                       -- [{row_no, values, errors[]}] — retained 90 days
  row_count       int,
  valid_count     int,
  rejected_count  int,
  error_summary   jsonb,
  uploaded_by     uuid not null references profiles(id) on delete restrict,
  created_at      timestamptz not null default now(),
  committed_at    timestamptz,
  constraint import_file_size check (file_bytes > 0 and file_bytes <= 10485760)  -- 10 MB
);

create index manifest_imports_lookup_idx
  on manifest_imports (org_id, yard_id, operating_date, created_at desc);

-- A manifest version. (yard, operating_date, version) is the natural key.
-- A second upload for the same day produces version 2; version 1 is ARCHIVED,
-- never mutated and never deleted.
create table manifests (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete restrict,
  yard_id         uuid not null references yards(id) on delete restrict,
  operating_date  date not null,
  version         int  not null default 1,
  status          manifest_status not null default 'DRAFT',
  reference_no    text,
  supersedes_id   uuid references manifests(id) on delete restrict,
  import_id       uuid references manifest_imports(id) on delete restrict,
  source_file_path   text,
  source_file_sha256 text,
  total_containers int not null default 0,
  total_vehicles   int not null default 0,
  created_by      uuid not null references profiles(id) on delete restrict,
  created_at      timestamptz not null default now(),
  published_by    uuid references profiles(id) on delete restrict,
  published_at    timestamptz,
  archived_at     timestamptz,
  archive_reason  text,
  constraint manifests_version_unique unique (yard_id, operating_date, version),
  constraint manifests_version_positive check (version >= 1),
  constraint manifests_published_coherent check (
    status <> 'PUBLISHED' or (published_by is not null and published_at is not null)
  ),
  constraint manifests_supersedes_not_self check (supersedes_id is null or supersedes_id <> id)
);

-- At most one live manifest per yard per operating day. This makes "which
-- manifest is authoritative right now?" a database fact rather than a
-- convention the application is trusted to maintain.
create unique index manifests_one_published_per_day
  on manifests (yard_id, operating_date) where status = 'PUBLISHED';

create index manifests_org_date_idx on manifests (org_id, operating_date desc, status);
create index manifests_yard_status_idx on manifests (yard_id, status, operating_date desc);

create table containers (
  id              uuid primary key default gen_random_uuid(),
  manifest_id     uuid not null references manifests(id) on delete cascade,
  container_no    text not null,               -- normalised: A-Z0-9, upper
  iso_type        text,
  expected_vehicle_count int not null default 2,
  bay_position    text,
  sequence_no     int,
  raw_row         jsonb,
  created_at      timestamptz not null default now(),
  constraint containers_unique_per_manifest unique (manifest_id, container_no),
  -- "Normally two vehicles per container" is a default, not a law. Capacity is
  -- data because the exception turns up in week three.
  constraint containers_capacity_sane check (expected_vehicle_count between 1 and 6),
  constraint containers_no_format check (container_no ~ '^[A-Z0-9]{4,15}$')
);

create index containers_manifest_idx on containers (manifest_id);
create index containers_number_idx on containers (container_no);

create table vehicle_assignments (
  id              uuid primary key default gen_random_uuid(),
  manifest_id     uuid not null references manifests(id) on delete cascade,
  container_id    uuid not null references containers(id) on delete cascade,
  chassis_no      text not null,               -- normalised
  sequence_no     int  not null,               -- 1..expected_vehicle_count
  vehicle_reg_no  text,
  make_model      text,
  colour          text,
  status          assignment_status not null default 'PENDING',
  claimed_by      uuid references profiles(id) on delete restrict,
  claimed_at      timestamptz,
  cancelled_at    timestamptz,
  cancel_reason   text,
  raw_row         jsonb,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint assignments_sequence_positive check (sequence_no >= 1),
  constraint assignments_chassis_format check (chassis_no ~ '^[A-Z0-9]{5,25}$'),
  -- One vehicle per slot within a container.
  constraint assignments_slot_unique unique (container_id, sequence_no)
);

-- THE rule from the brief: a chassis number must not be assigned to two
-- active containers within the same manifest. Partial, so a cancelled
-- assignment frees the chassis for a corrected one.
create unique index assignments_chassis_unique_per_manifest
  on vehicle_assignments (manifest_id, chassis_no)
  where status <> 'CANCELLED';

create index assignments_manifest_status_idx on vehicle_assignments (manifest_id, status);
create index assignments_container_idx on vehicle_assignments (container_id, sequence_no);
create index assignments_chassis_idx on vehicle_assignments (chassis_no);
create index assignments_claimed_idx on vehicle_assignments (claimed_by, status)
  where claimed_by is not null;

-- Corrections. A correction never mutates a published row; it records the
-- before/after and the reason, and points at the new version it produced.
create table manifest_corrections (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references organizations(id) on delete restrict,
  from_manifest_id   uuid not null references manifests(id) on delete restrict,
  to_manifest_id     uuid references manifests(id) on delete restrict,
  container_no       text,
  chassis_no         text,
  field_name         text not null,
  before_value       text,
  after_value        text,
  reason             text not null,
  affected_movements jsonb not null default '[]'::jsonb,
  corrected_by       uuid not null references profiles(id) on delete restrict,
  corrected_at       timestamptz not null default now(),
  -- A dropdown alone lets people click through a correction to the source of
  -- truth. Free text is required, and the minimum length is enforced here
  -- rather than in a form that can be bypassed.
  constraint correction_reason_substantive check (length(btrim(reason)) >= 10),
  constraint correction_changed_something check (
    before_value is distinct from after_value
  )
);

create index corrections_from_idx on manifest_corrections (from_manifest_id);
create index corrections_org_time_idx on manifest_corrections (org_id, corrected_at desc);
