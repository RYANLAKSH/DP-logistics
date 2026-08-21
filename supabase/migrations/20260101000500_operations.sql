-- ---------------------------------------------------------------------------
-- Verification attempts, movement events, exceptions, overrides, sync.
--
-- Every attempt is retained, including every failure. A failed scan is the
-- most interesting row in the system when something goes wrong later.
-- ---------------------------------------------------------------------------

-- One row per verification attempt: a container scan, a chassis scan, or the
-- FINAL server-side check of both. Never deleted, never edited.
create table verification_attempts (
  id                uuid primary key,          -- CLIENT-generated: the idempotency key
  org_id            uuid not null references organizations(id) on delete restrict,
  yard_id           uuid not null references yards(id) on delete restrict,
  manifest_id       uuid not null references manifests(id) on delete restrict,
  assignment_id     uuid not null references vehicle_assignments(id) on delete restrict,
  driver_id         uuid not null references profiles(id) on delete restrict,
  device_id         uuid references devices(id) on delete restrict,

  kind              attempt_kind not null,
  result            attempt_result not null,
  outcome           verification_outcome,      -- set on FINAL attempts

  expected_container_no text not null,
  expected_chassis_no   text not null,
  scanned_container_no  text,
  scanned_chassis_no    text,

  ocr_text_raw      text,                      -- exactly what OCR produced
  ocr_confidence    real,
  ocr_engine        text,
  value_source      value_source,

  -- Evidence. Paths are Storage keys in the private `evidence` bucket.
  container_image_path   text,
  container_image_sha256 text,
  chassis_image_path     text,
  chassis_image_sha256   text,
  image_phash            text,

  gps_lat           double precision,
  gps_lng           double precision,
  gps_accuracy_m    real,
  gps_denied        boolean not null default false,

  client_outcome    verification_outcome,      -- the device's advisory verdict
  attempted_at_device timestamptz not null,
  received_at       timestamptz not null default now(),
  clock_skew_s      int generated always as
                      (extract(epoch from (received_at - attempted_at_device))::int) stored,

  app_version       text,
  created_at        timestamptz not null default now(),

  constraint attempt_confidence_range check (
    ocr_confidence is null or ocr_confidence between 0 and 1
  ),
  constraint attempt_final_has_outcome check (kind <> 'FINAL' or outcome is not null),
  constraint attempt_gps_pair check (
    (gps_lat is null) = (gps_lng is null)
  )
);

create index attempts_assignment_idx on verification_attempts (assignment_id, created_at desc);
create index attempts_driver_idx on verification_attempts (driver_id, created_at desc);
create index attempts_yard_time_idx on verification_attempts (yard_id, created_at desc);
create index attempts_failures_idx on verification_attempts (yard_id, created_at desc)
  where result <> 'PASS';
-- Duplicate-photograph detection (docs/design/08 section 6).
create index attempts_phash_idx on verification_attempts (image_phash)
  where image_phash is not null;

-- The record that a vehicle was moved into a container. Written only by the
-- server-side verification function.
create table movement_events (
  id                uuid primary key,          -- CLIENT-generated: the idempotency key
  org_id            uuid not null references organizations(id) on delete restrict,
  yard_id           uuid not null references yards(id) on delete restrict,
  manifest_id       uuid not null references manifests(id) on delete restrict,
  container_id      uuid not null references containers(id) on delete restrict,
  assignment_id     uuid not null references vehicle_assignments(id) on delete restrict,
  driver_id         uuid not null references profiles(id) on delete restrict,
  device_id         uuid references devices(id) on delete restrict,

  status            movement_status not null default 'COMPLETED',

  -- Denormalised deliberately. The record must state what was expected and
  -- what was scanned in a form that survives whatever later happens to the
  -- manifest. An audit row that needs three joins into mutable data to
  -- reconstruct its own meaning is a weak audit row.
  expected_container_no text not null,
  expected_chassis_no   text not null,
  scanned_container_no  text not null,
  scanned_chassis_no    text not null,

  container_attempt_id uuid references verification_attempts(id) on delete restrict,
  chassis_attempt_id   uuid references verification_attempts(id) on delete restrict,
  final_attempt_id     uuid references verification_attempts(id) on delete restrict,

  override_id       uuid,                      -- FK added after overrides exists
  reversed_by       uuid references profiles(id) on delete restrict,
  reversed_at       timestamptz,
  reversal_reason   text,
  supersedes_id     uuid references movement_events(id) on delete restrict,

  gps_lat           double precision,
  gps_lng           double precision,
  gps_accuracy_m    real,

  completed_at_device timestamptz,
  verified_at       timestamptz not null default now(),   -- server clock. Authoritative
  app_version       text,
  created_at        timestamptz not null default now(),

  constraint movement_reversal_coherent check (
    status <> 'REVERSED' or (reversed_by is not null and reversed_at is not null
                             and length(btrim(coalesce(reversal_reason, ''))) >= 10)
  ),
  constraint movement_override_coherent check (
    status <> 'OVERRIDDEN' or override_id is not null
  )
);

-- A movement may be completed exactly once. This is the constraint that makes
-- double-tap, retry, and two-drivers-one-vehicle structurally impossible
-- rather than merely unlikely.
create unique index movements_one_completion_per_assignment
  on movement_events (assignment_id)
  where status in ('COMPLETED', 'OVERRIDDEN');

create index movements_yard_time_idx on movement_events (yard_id, verified_at desc);
create index movements_manifest_idx on movement_events (manifest_id);
create index movements_container_idx on movement_events (container_id);
create index movements_driver_idx on movement_events (driver_id, verified_at desc);
create index movements_chassis_idx on movement_events (scanned_chassis_no);

create table exceptions (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references organizations(id) on delete restrict,
  yard_id         uuid not null references yards(id) on delete restrict,
  manifest_id     uuid references manifests(id) on delete restrict,
  assignment_id   uuid references vehicle_assignments(id) on delete restrict,
  attempt_id      uuid references verification_attempts(id) on delete restrict,
  movement_id     uuid references movement_events(id) on delete restrict,

  type            exception_type not null,
  status          exception_status not null default 'OPEN',
  severity        int not null default 2,      -- 1 critical, 2 normal, 3 low

  expected_value  text,
  actual_value    text,
  description     text,

  raised_by       uuid references profiles(id) on delete restrict,
  raised_at       timestamptz not null default now(),

  override_requested boolean not null default false,

  acknowledged_by uuid references profiles(id) on delete restrict,
  acknowledged_at timestamptz,
  resolved_by     uuid references profiles(id) on delete restrict,
  resolved_at     timestamptz,
  resolution      exception_resolution,
  resolution_note text,
  escalated_at    timestamptz,

  constraint exception_severity_range check (severity between 1 and 3),
  constraint exception_resolved_coherent check (
    status <> 'RESOLVED' or (resolved_by is not null and resolved_at is not null
                             and resolution is not null)
  ),
  constraint exception_cancelled_coherent check (
    status <> 'CANCELLED' or (resolved_by is not null and resolved_at is not null
                              and length(btrim(coalesce(resolution_note, ''))) >= 5)
  )
);

create index exceptions_open_idx on exceptions (yard_id, raised_at desc)
  where status in ('OPEN', 'UNDER_REVIEW');
create index exceptions_org_time_idx on exceptions (org_id, raised_at desc);
create index exceptions_assignment_idx on exceptions (assignment_id);
create index exceptions_type_idx on exceptions (type, status);

create table overrides (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id) on delete restrict,
  assignment_id uuid not null references vehicle_assignments(id) on delete restrict,
  exception_id  uuid references exceptions(id) on delete restrict,
  requested_by  uuid not null references profiles(id) on delete restrict,
  approved_by   uuid not null references profiles(id) on delete restrict,
  reason        override_reason not null,
  reason_note   text,
  approved_at   timestamptz not null default now(),
  -- Dual control, in the schema. A control that lives only in application code
  -- is a control that survives until someone writes a script.
  constraint override_requester_is_not_approver check (requested_by <> approved_by),
  constraint override_note_required_for_other check (
    reason <> 'OTHER' or length(btrim(coalesce(reason_note, ''))) >= 10
  )
);

create index overrides_assignment_idx on overrides (assignment_id);
create index overrides_approver_idx on overrides (approved_by, approved_at desc);

alter table movement_events
  add constraint movement_override_fk
  foreign key (override_id) references overrides(id) on delete restrict;

-- Server-side record of offline-queued operations. The client's outbox is in
-- IndexedDB; this is what lets the server recognise a replay, report a
-- conflict, and let a manager see what is still outstanding.
create table sync_operations (
  id             uuid primary key,             -- client-generated operation id
  org_id         uuid not null references organizations(id) on delete restrict,
  driver_id      uuid not null references profiles(id) on delete restrict,
  device_id      uuid references devices(id) on delete restrict,
  operation      text not null,                -- 'verify_movement', 'raise_exception', …
  assignment_id  uuid references vehicle_assignments(id) on delete restrict,
  request_hash   text not null,                -- sha256 of the canonical request payload
  outcome        verification_outcome,
  http_status    int,
  response       jsonb,
  queued_at_device timestamptz,
  received_at    timestamptz not null default now(),
  attempts       int not null default 1
);

create index sync_ops_driver_idx on sync_operations (driver_id, received_at desc);
create index sync_ops_assignment_idx on sync_operations (assignment_id);
