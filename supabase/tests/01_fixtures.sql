-- ---------------------------------------------------------------------------
-- Test fixtures and assertion helpers. Local test harness only.
--
-- The business scenario is the one from the build plan:
--   container TRHU8755445
--     vehicle 1  MAT752389T7R20588
--     vehicle 2  MAT464844TSR09113
-- ---------------------------------------------------------------------------

create schema if not exists tst;

create or replace function tst.ok(cond boolean, msg text) returns void
language plpgsql as $$
begin
  if cond is not true then
    raise exception 'ASSERTION FAILED: %', msg;
  end if;
end $$;

create or replace function tst.eq(a anyelement, b anyelement, msg text) returns void
language plpgsql as $$
begin
  if a is distinct from b then
    raise exception 'ASSERTION FAILED: % (expected %, got %)', msg, b, a;
  end if;
end $$;

-- Asserts that a statement raises. Used for the RLS and rule-violation tests:
-- proving a thing is REFUSED matters more than proving it is permitted.
create or replace function tst.throws(stmt text, msg text) returns void
language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    return;
  end;
  raise exception 'ASSERTION FAILED: % (statement succeeded but should have failed)', msg;
end $$;

-- Asserts a SELECT returns exactly n rows, under whatever role is current.
create or replace function tst.rowcount(stmt text, n bigint, msg text) returns void
language plpgsql as $$
declare c bigint;
begin
  execute format('select count(*) from (%s) q', stmt) into c;
  if c <> n then
    raise exception 'ASSERTION FAILED: % (expected % rows, got %)', msg, n, c;
  end if;
end $$;

create or replace function tst.login(p_user uuid) returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, false);
end $$;

create or replace function tst.logout() returns void
language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', false);
end $$;

grant usage on schema tst to public;
grant execute on all functions in schema tst to public;

-- ------------------------------- the data ----------------------------------
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'admin@dp.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'manager@dp.test'),
  ('00000000-0000-0000-0000-0000000000c3', 'driver1@dp.test'),
  ('00000000-0000-0000-0000-0000000000c4', 'driver2@dp.test'),
  ('00000000-0000-0000-0000-0000000000c5', 'manager2@dp.test'),
  ('00000000-0000-0000-0000-0000000000c6', 'outsider@dp.test');

insert into organizations (id, name) values
  ('00000000-0000-0000-0000-0000000000a1', 'DP Logistics'),
  ('00000000-0000-0000-0000-0000000000a2', 'Rival Logistics');

insert into yards (id, org_id, code, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'NSA', 'Nhava Sheva'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a1', 'MUN', 'Mundra');

insert into org_settings (org_id) values
  ('00000000-0000-0000-0000-0000000000a1'),
  ('00000000-0000-0000-0000-0000000000a2');

insert into profiles (id, org_id, role, full_name) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', 'ADMIN',   'Asha Admin'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', 'MANAGER', 'Manoj Manager'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000a1', 'DRIVER',  'Dev Driver'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000a1', 'DRIVER',  'Dina Driver'),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000a1', 'MANAGER', 'Meera Manager'),
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000a2', 'ADMIN',   'Olu Outsider');

-- driver1 + manager work Nhava Sheva. driver2 + manager2 work Mundra.
insert into user_yards (user_id, yard_id) values
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000b1'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000b2'),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000b2');

insert into devices (id, user_id, device_key, status, approved_by, approved_at) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000c3',
   'device-driver-1', 'APPROVED', '00000000-0000-0000-0000-0000000000c2', now()),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000c4',
   'device-driver-2', 'APPROVED', '00000000-0000-0000-0000-0000000000c5', now());
-- driver1 also has an UNAPPROVED second device, for the device-binding test.
insert into devices (id, user_id, device_key, status) values
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000c3',
   'device-driver-1-spare', 'PENDING');

insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256, file_bytes,
  status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-0000000000e1',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date, 'manifest.csv',
  '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000b1/x/abc.csv',
  repeat('a', 64), 512, 'READY', 4, 4, 0,
  '00000000-0000-0000-0000-0000000000c2',
  '[
    {"row_no":1,"container_no":"TRHU8755445","chassis_no":"MAT752389T7R20588","sequence_no":1},
    {"row_no":2,"container_no":"TRHU8755445","chassis_no":"MAT464844TSR09113","sequence_no":2},
    {"row_no":3,"container_no":"CAIU4330430","chassis_no":"MAT752389T7R18439","sequence_no":1},
    {"row_no":4,"container_no":"CAIU4330430","chassis_no":"MAT464844TSR09257","sequence_no":2}
  ]'::jsonb
);

-- Publish it through the real RPC, as the manager, so the fixture exercises
-- the same path production uses.
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c2');
select publish_manifest_from_import('00000000-0000-0000-0000-0000000000e1', 'REF-001');
select tst.logout();
reset role;

-- Runs a full driver cycle: container scan, chassis scan, then the
-- authoritative server verification. Mirrors exactly what the PWA does.
create or replace function tst.scan_and_verify(
  p_assignment uuid,
  p_container  text,
  p_chassis    text,
  p_device     text default 'device-driver-1',
  p_movement   uuid default null,
  p_client_outcome verification_outcome default null
) returns jsonb
language plpgsql as $$
declare
  ca uuid := gen_random_uuid();
  ha uuid := gen_random_uuid();
  mv uuid := coalesce(p_movement, gen_random_uuid());
begin
  perform record_scan_attempt(
    ca, p_assignment, 'CONTAINER', p_container,
    create_evidence_upload_path(p_assignment, 'CONTAINER', ca), repeat('c', 64),
    null, p_container, 0.95, 'test-engine', 'OCR_AUTO', p_device);
  perform record_scan_attempt(
    ha, p_assignment, 'CHASSIS', p_chassis,
    create_evidence_upload_path(p_assignment, 'CHASSIS', ha), repeat('h', 64),
    null, p_chassis, 0.95, 'test-engine', 'OCR_AUTO', p_device);
  return verify_movement(mv, p_assignment, p_container, p_chassis, ca, ha,
                         null, p_device, p_client_outcome);
end $$;

create or replace function tst.assignment_id(p_chassis text) returns uuid
language sql stable as $$
  select va.id from vehicle_assignments va
    join manifests m on m.id = va.manifest_id
   where va.chassis_no = p_chassis and m.status = 'PUBLISHED'
   limit 1
$$;

grant execute on all functions in schema tst to public;

/**
 * Date-scoped assignment lookup.
 *
 * The acceptance suite uses the business's real identifiers, which also appear
 * in the earlier fixtures — so looking one up by chassis alone is ambiguous
 * across published manifests for different days.
 */
create or replace function tst.assignment_on(p_date date, p_chassis text) returns uuid
language sql stable as $$
  select va.id from vehicle_assignments va
    join manifests m on m.id = va.manifest_id
   where va.chassis_no = p_chassis
     and m.status = 'PUBLISHED'
     and m.operating_date = p_date
   limit 1
$$;

grant execute on all functions in schema tst to public;
