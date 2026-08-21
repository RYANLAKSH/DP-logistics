# 06 — Database Entities

PostgreSQL on Supabase. Abridged DDL: the columns and constraints that carry meaning.
Indexes and grants are shown where they encode a rule.

## 1. Entity overview

```
organizations
  ├── yards
  ├── profiles ──────────┬── user_yards
  │                      └── devices
  ├── manifest_imports  (the uploaded file + parse result; pre-commit)
  ├── manifests ────────── manifest_versions ──┬── manifest_containers
  │                                            └── manifest_vehicles   ← THE assignment
  ├── movements ──────────┬── scans ── (Storage objects)
  │                       ├── exceptions ── overrides
  │                       └── notifications
  └── audit_events (append-only, everything)
```

The assignment — "this chassis goes in this container" — lives in `manifest_vehicles`. It
is the single row the entire product is built to enforce.

## 2. Org, yards, people

```sql
create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_at  timestamptz not null default now()
);

create table yards (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id),
  code        text not null,                    -- 'NSA', 'MUN'
  name        text not null,
  timezone    text not null default 'Asia/Kolkata',
  geofence    jsonb,                            -- optional polygon; see §08 anti-fraud
  is_active   boolean not null default true,
  unique (org_id, code)
);

create type user_role as enum ('driver','supervisor','admin','auditor');

-- Mirrors auth.users. Supabase owns identity; this owns authorization data.
create table profiles (
  id          uuid primary key references auth.users(id) on delete restrict,
  org_id      uuid not null references organizations(id),
  role        user_role not null,
  full_name   text not null,
  employee_no text,
  phone       text,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table user_yards (
  user_id  uuid references profiles(id) on delete cascade,
  yard_id  uuid references yards(id) on delete cascade,
  primary key (user_id, yard_id)
);

create table devices (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references profiles(id),
  device_key    text not null,                  -- UUID generated client-side, in IndexedDB
  user_agent    text,
  approved_at   timestamptz,
  approved_by   uuid references profiles(id),
  revoked_at    timestamptz,
  last_seen_at  timestamptz,
  unique (user_id, device_key)
);
```

`on delete restrict` on `profiles.id` is deliberate: deleting an auth user must not be able
to orphan a movement's operator. People are deactivated, never deleted.

## 3. Manifests

Versioned and immutable. This is the source of truth, so it gets the strictest treatment in
the schema.

```sql
create type manifest_status as enum ('draft','active','superseded','cancelled');

-- A manifest identifies a (yard, date) pair across all its versions.
create table manifests (
  id           uuid primary key default gen_random_uuid(),
  org_id       uuid not null references organizations(id),
  yard_id      uuid not null references yards(id),
  manifest_date date not null,
  reference_no text,                             -- operations' own reference
  created_at   timestamptz not null default now(),
  unique (org_id, yard_id, manifest_date)
);

create table manifest_versions (
  id             uuid primary key default gen_random_uuid(),
  manifest_id    uuid not null references manifests(id),
  version        int  not null,
  status         manifest_status not null default 'draft',
  supersedes_id  uuid references manifest_versions(id),
  source_file_path text not null,                -- Storage key; kept forever
  source_file_sha256 text not null,
  import_id      uuid references manifest_imports(id),
  committed_by   uuid references profiles(id),
  committed_at   timestamptz,
  cancelled_at   timestamptz,
  cancel_reason  text,
  created_at     timestamptz not null default now(),
  unique (manifest_id, version)
);

-- Exactly one active version per manifest.
create unique index one_active_version_per_manifest
  on manifest_versions (manifest_id) where status = 'active';

create table manifest_containers (
  id                  uuid primary key default gen_random_uuid(),
  manifest_version_id uuid not null references manifest_versions(id) on delete cascade,
  container_no        char(11) not null,         -- normalized, check-digit valid at ingest
  container_iso_type  text,                      -- '45G1'
  capacity            int  not null default 2,   -- NOT a constant. From the manifest
  bay_position        text,                      -- 'Bay C, row 4' — helps the driver find it
  sequence_no         int,
  raw_row             jsonb not null,
  unique (manifest_version_id, container_no),
  constraint capacity_sane check (capacity between 1 and 6)
);

create table manifest_vehicles (
  id                     uuid primary key default gen_random_uuid(),
  manifest_container_id  uuid not null references manifest_containers(id) on delete cascade,
  manifest_version_id    uuid not null references manifest_versions(id) on delete cascade,
  chassis_no             text not null,          -- normalized at ingest
  vehicle_reg_no         text,                   -- secondary identifier, OCRs far better
  make_model             text,
  colour                 text,
  slot_no                int not null,           -- 1..capacity
  raw_row                jsonb not null,
  unique (manifest_container_id, slot_no),
  unique (manifest_version_id, chassis_no)       -- a vehicle is assigned exactly once
);

create index on manifest_vehicles (manifest_version_id, chassis_no);
create index on manifest_containers (manifest_version_id, container_no);
```

Four constraints doing real work:

- `unique (manifest_version_id, chassis_no)` — a vehicle cannot be assigned to two
  containers in the same manifest. If the source file contains such a row it is rejected at
  preview, where it is fixable, rather than discovered at a ramp.
- `unique (manifest_container_id, slot_no)` — two vehicles cannot occupy slot 1.
- `one_active_version_per_manifest` — makes "which manifest is live?" unambiguous at the
  database level rather than by convention.
- `capacity` is a column, not the literal 2. The brief says "normally two"; the exception
  will appear in week three.

`raw_row` on both tables is not optional. When operations dispute a rejection you need the
row exactly as they sent it, not your parse of it.

### Import staging

Parsing happens before anything becomes live, so it needs its own table.

```sql
create type import_status as enum ('parsing','ready','committed','failed','discarded');

create table manifest_imports (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  yard_id       uuid not null references yards(id),
  manifest_date date not null,
  file_path     text not null,
  file_sha256   text not null,
  status        import_status not null default 'parsing',
  column_map    jsonb,                    -- saved per source; next upload needs no mapping
  parsed_rows   jsonb,                    -- [{row_no, values, errors[]}]
  valid_count   int,
  rejected_count int,
  uploaded_by   uuid not null references profiles(id),
  created_at    timestamptz not null default now()
);
```

## 4. Movements

One movement = one vehicle placed into one container. A container with capacity 2 produces
two movements.

```sql
create type movement_status as enum (
  'pending',              -- assignment exists, nobody has started
  'claimed',              -- a driver has taken it
  'awaiting_verification',-- submitted offline, queued; NOT complete
  'verified',             -- server confirmed both values against the manifest
  'blocked',              -- server rejected; an exception exists
  'overridden',           -- supervisor authorized despite a block
  'cancelled'             -- manifest amended it away, or admin cancelled
);

create type movement_outcome as enum (
  'match',
  'wrong_vehicle',            -- scanned chassis belongs to a different container
  'wrong_container',          -- scanned container is not this vehicle's assignment
  'vehicle_not_on_manifest',
  'container_not_on_manifest',
  'container_full',
  'vehicle_already_loaded',
  'manifest_superseded',
  'unreadable'
);

create table movements (
  id                    uuid primary key,        -- CLIENT-generated: the idempotency key
  org_id                uuid not null references organizations(id),
  yard_id               uuid not null references yards(id),

  manifest_version_id   uuid not null references manifest_versions(id),
  manifest_vehicle_id   uuid not null references manifest_vehicles(id),
  expected_container_no char(11) not null,       -- denormalized on purpose (see below)
  expected_chassis_no   text    not null,

  scanned_container_no  char(11),
  scanned_chassis_no    text,

  status                movement_status not null default 'pending',
  outcome               movement_outcome,

  driver_id             uuid references profiles(id),
  device_id             uuid references devices(id),

  client_verdict        movement_outcome,        -- advisory; for comparison only
  client_verdict_agreed boolean generated always as
                          (client_verdict is not distinct from outcome) stored,

  claimed_at            timestamptz,
  submitted_at_device   timestamptz,             -- device clock
  verified_at           timestamptz,             -- server clock, set only by the RPC
  received_at           timestamptz not null default now(),
  clock_skew_s          int generated always as
                          (extract(epoch from (received_at - submitted_at_device))::int) stored,

  gps_lat               double precision,
  gps_lng               double precision,
  gps_accuracy_m        real,

  supersedes_id         uuid references movements(id),
  app_version           text,
  created_at            timestamptz not null default now()
);

create index on movements (yard_id, status, created_at desc);
create index on movements (manifest_version_id);
create index on movements (scanned_chassis_no);
create index on movements (expected_container_no);
```

Three decisions worth defending:

**The primary key is generated by the client.** It is the idempotency key. A driver whose
network drops mid-submit retries with the same id, and the RPC upserts rather than creating
a duplicate movement. Without this, a flaky connection produces double-loaded containers in
the data.

**`expected_container_no` and `expected_chassis_no` are denormalized copies.** They are
reachable through `manifest_vehicle_id`, so this is redundant — deliberately. The movement
record must state what was expected *at the time it was verified*, in a form that survives
regardless of what later happens to the manifest. An audit record that requires three joins
into mutable-ish data to reconstruct its own meaning is a weak audit record.

**`clock_skew_s` is stored, not computed on read.** A device reporting a time 40 minutes off
is a signal — sometimes a wrong timezone, sometimes a driver trying to make a late movement
look punctual. Storing it makes it indexable and alertable.

### State machine

```
                    ┌──────────┐
                    │ pending  │
                    └────┬─────┘
                 driver claims
                    ┌────▼─────┐
                    │ claimed  │
                    └────┬─────┘
                  submit scans
              ┌──────────┴───────────┐
        online│                      │offline
   ┌──────────▼─────────┐   ┌────────▼──────────────┐
   │ verify_movement()  │   │ awaiting_verification │
   └──────┬──────┬──────┘   └────────┬──────────────┘
       ok │      │ fail              │ (queue drains)
   ┌──────▼───┐ ┌▼────────┐          │
   │ verified │ │ blocked │◄─────────┘
   └──────────┘ └────┬────┘
                 supervisor
                  approves
                ┌────▼───────┐
                │ overridden │
                └────────────┘
```

Only `verify_movement()` may write `verified`, `blocked`, or `overridden`. Enforced by
column-level grants, not by convention — see §08.

### The rule that prevents double-loading

Capacity and single-load are enforced in the same transaction that verifies, with a row
lock on the container:

```sql
-- inside verify_movement(), abridged
perform 1 from manifest_containers
  where id = v_container_id for update;          -- serializes concurrent drivers

select count(*) into v_filled
  from movements
 where manifest_vehicle_id in (select id from manifest_vehicles
                                where manifest_container_id = v_container_id)
   and status in ('verified','overridden');

if v_filled >= v_capacity then
  -- outcome := 'container_full'
end if;
```

Without the `for update`, two drivers scanning the last slot of the same container within
the same second both read `v_filled = 1` and both succeed. That is not a theoretical race;
it is a busy yard at shift change.

## 5. Scans and evidence

```sql
create type scan_kind as enum ('container','chassis','vehicle_reg','context');
create type scan_source as enum ('ocr_auto','ocr_confirmed','manual_entry','manual_authorized');

create table scans (
  id             uuid primary key,               -- client-generated
  movement_id    uuid not null references movements(id) on delete restrict,
  kind           scan_kind not null,

  image_path     text not null,                  -- Storage key, private bucket
  image_sha256   text not null,
  image_bytes    int,
  image_phash    text,                           -- perceptual hash; duplicate detection (§08)

  ocr_text_raw   text,                           -- exactly what OCR produced
  ocr_confidence real,
  ocr_engine     text,                           -- 'tesseract-5-wasm' | 'vision-api'
  value_final    text not null,                  -- after normalization + human confirmation
  source         scan_source not null,

  captured_at_device timestamptz not null,
  gps_lat        double precision,
  gps_lng        double precision,
  created_at     timestamptz not null default now()
);

create index on scans (movement_id);
create index on scans (image_phash);
```

`ocr_text_raw` alongside `value_final` is what lets you measure OCR quality in production
and tune §09's thresholds against real yard conditions instead of guesses. It is also what
proves, in a dispute, that a human corrected a machine rather than the other way round.

`on delete restrict` — evidence cannot be deleted by deleting its parent.

## 6. Exceptions and overrides

```sql
create type exception_type as enum (
  'mismatch','container_unreadable','chassis_unreadable','vehicle_absent',
  'container_absent','container_full','manifest_error','device_unapproved','other'
);
create type exception_status as enum ('open','acknowledged','resolved','escalated');
create type resolution_code as enum (
  'corrected_and_rescanned','manifest_amended','override_approved',
  'manual_entry_authorized','task_reassigned','no_action_required','false_alarm'
);

create table exceptions (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  yard_id       uuid not null references yards(id),
  movement_id   uuid references movements(id),
  type          exception_type not null,
  status        exception_status not null default 'open',
  detail        text,
  raised_by     uuid references profiles(id),
  raised_at     timestamptz not null default now(),
  acknowledged_by uuid references profiles(id),
  acknowledged_at timestamptz,
  resolved_by   uuid references profiles(id),
  resolved_at   timestamptz,
  resolution    resolution_code,
  resolution_note text
);

create type override_reason as enum (
  'last_minute_substitution','manifest_error','damaged_plate',
  'operational_exception','other'
);

create table overrides (
  id             uuid primary key default gen_random_uuid(),
  movement_id    uuid not null references movements(id),
  exception_id   uuid references exceptions(id),
  requested_by   uuid not null references profiles(id),   -- the driver
  approved_by    uuid not null references profiles(id),   -- the supervisor, different person
  reason         override_reason not null,
  reason_note    text,
  approved_at    timestamptz not null default now(),
  constraint requester_is_not_approver check (requested_by <> approved_by),
  constraint note_required_for_other
    check (reason <> 'other' or coalesce(length(reason_note),0) > 10)
);
```

`requester_is_not_approver` puts dual control in the schema. A control that lives only in
application code is a control that survives until someone writes a script.

## 7. Notifications

```sql
create table notifications (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references organizations(id),
  event_type    text not null,                 -- 'movement.blocked', 'override.approved', …
  movement_id   uuid references movements(id),
  exception_id  uuid references exceptions(id),
  channel       text not null,                 -- 'email' | 'webpush'
  recipient     text not null,
  payload       jsonb not null,
  provider_id   text,
  status        text not null default 'queued',-- queued|sent|delivered|bounced|failed
  error         text,
  created_at    timestamptz not null default now(),
  sent_at       timestamptz
);
```

"Did the alert go out?" must be answerable from the database, including when the answer is
"yes, and it bounced".

## 8. Audit events

```sql
create table audit_events (
  id           bigserial primary key,
  org_id       uuid not null references organizations(id),
  occurred_at  timestamptz not null default now(),
  actor_id     uuid references profiles(id),
  actor_role   user_role,
  action       text not null,                  -- 'movement.verified', 'manifest.committed', …
  entity_type  text not null,
  entity_id    uuid,
  before       jsonb,
  after        jsonb,
  context      jsonb,                          -- ip, user agent, device, app version
  prev_hash    text,
  row_hash     text                            -- sha256(prev_hash || canonical(row))
);
```

Append-only, enforced by a trigger that raises on `UPDATE` or `DELETE`, and by granting the
`authenticated` role `SELECT` only. Writes come from `SECURITY DEFINER` functions. The
hash chain is detailed in §13.

## 9. Views the application actually reads

The PWA should not be assembling task lists from five joins on a phone.

```sql
-- What a driver's task queue reads.
create view v_driver_tasks as
select mv.id            as assignment_id,
       mc.container_no, mc.bay_position, mc.capacity,
       mv.chassis_no, mv.vehicle_reg_no, mv.make_model, mv.colour, mv.slot_no,
       mver.id          as manifest_version_id,
       m.yard_id, m.manifest_date,
       mo.id            as movement_id,
       coalesce(mo.status,'pending') as status
  from manifest_vehicles mv
  join manifest_containers mc  on mc.id = mv.manifest_container_id
  join manifest_versions  mver on mver.id = mv.manifest_version_id and mver.status = 'active'
  join manifests m             on m.id = mver.manifest_id
  left join movements mo       on mo.manifest_vehicle_id = mv.id
                              and mo.status <> 'cancelled';

-- The supervisor's end-of-shift completeness sweep.
create view v_container_fill as
select mc.id, mc.container_no, mc.capacity,
       count(*) filter (where mo.status in ('verified','overridden')) as filled,
       m.yard_id, m.manifest_date
  from manifest_containers mc
  join manifest_vehicles mv on mv.manifest_container_id = mc.id
  join manifest_versions mver on mver.id = mc.manifest_version_id and mver.status='active'
  join manifests m on m.id = mver.manifest_id
  left join movements mo on mo.manifest_vehicle_id = mv.id
 group by mc.id, mc.container_no, mc.capacity, m.yard_id, m.manifest_date;
```

**Views need `security_invoker = true`** (Postgres 15+) or they bypass the RLS of their
underlying tables and become a data leak with a friendly name. This is the most common RLS
mistake in Supabase projects. Set it explicitly on every view and assert it in pgTAP.

## 10. Retention

| Data | Retention | Mechanism |
|---|---|---|
| Evidence images | 24 months, configurable per org | Storage lifecycle → delete; the `scans` row and its hash remain forever |
| `movements`, `exceptions`, `overrides` | Indefinite | Small, and they are the record |
| `audit_events` | Indefinite | Partition by month once it grows |
| `manifest_imports.parsed_rows` | 90 days | Bulky JSON; the committed version is the record |
| Source manifest files | Indefinite | Kilobytes. Keep them |

Deleting an image does not delete its `scans` row. The hash survives, so an image produced
later can still be proved to be — or not to be — the original.
