-- ---------------------------------------------------------------------------
-- Organisations, yards, people, devices.
-- ---------------------------------------------------------------------------

create table organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

create table yards (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references organizations(id) on delete restrict,
  code        text not null,
  name        text not null,
  timezone    text not null default 'Asia/Kolkata',
  gps_lat     double precision,
  gps_lng     double precision,
  geofence_radius_m int,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint yards_code_unique unique (org_id, code)
);

-- Mirrors auth.users. Supabase Auth owns identity; this table owns
-- authorisation data. `on delete restrict` so deleting an auth user can never
-- orphan a movement's operator: people are deactivated, never deleted.
create table profiles (
  id           uuid primary key references auth.users(id) on delete restrict,
  org_id       uuid not null references organizations(id) on delete restrict,
  role         user_role not null,
  full_name    text not null,
  employee_no  text,
  phone        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_employee_no_unique unique (org_id, employee_no)
);

create index profiles_org_role_idx on profiles (org_id, role) where is_active;

-- Which yards a user may work. ADMIN is org-wide and needs no rows here.
create table user_yards (
  user_id  uuid not null references profiles(id) on delete cascade,
  yard_id  uuid not null references yards(id) on delete cascade,
  assigned_at timestamptz not null default now(),
  primary key (user_id, yard_id)
);

create index user_yards_yard_idx on user_yards (yard_id);

-- Device registration. A driver completing a movement from an unapproved
-- device is blocked; see docs/design/03 section 5.
create table devices (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references profiles(id) on delete cascade,
  device_key   text not null,                 -- client-generated UUID, stored in IndexedDB
  label        text,
  user_agent   text,
  platform     text,
  status       device_status not null default 'PENDING',
  approved_by  uuid references profiles(id),
  approved_at  timestamptz,
  revoked_by   uuid references profiles(id),
  revoked_at   timestamptz,
  last_seen_at timestamptz,
  created_at   timestamptz not null default now(),
  constraint devices_key_unique unique (user_id, device_key),
  constraint devices_approval_coherent check (
    (status = 'APPROVED' and approved_by is not null and approved_at is not null)
    or (status = 'REVOKED' and revoked_at is not null)
    or (status = 'PENDING')
  )
);

create index devices_user_idx on devices (user_id, status);

-- Per-organisation configuration. OCR thresholds live here, NOT in the client
-- bundle: they must be tunable against a real yard without a redeploy.
create table org_settings (
  org_id                     uuid primary key references organizations(id) on delete cascade,
  container_min_confidence   real not null default 0.70,
  chassis_min_confidence     real not null default 0.85,
  chassis_match_margin       real not null default 0.15,
  require_device_approval    boolean not null default true,
  require_gps                boolean not null default false,
  evidence_retention_months  int not null default 24,
  max_clock_skew_seconds     int not null default 300,
  geofence_warn_metres       int not null default 2000,
  override_rate_alert_pct    real not null default 5.0,
  updated_by                 uuid references profiles(id),
  updated_at                 timestamptz not null default now(),
  constraint settings_sane check (
    container_min_confidence between 0 and 1
    and chassis_min_confidence between 0 and 1
    and chassis_match_margin between 0 and 1
    and evidence_retention_months between 1 and 240
  )
);
