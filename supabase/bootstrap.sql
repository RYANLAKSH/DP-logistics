-- ---------------------------------------------------------------------------
-- Bootstrap: everything between an empty project and a yard that can load a
-- vehicle.
--
-- Run this in the Supabase dashboard SQL editor, in parts, after
-- `supabase db push` has applied the migrations.
--
-- Why this file exists rather than a screen in the app: yards have no creation
-- UI at all, the users screen is read-only, and devices have no approval
-- screen — the RPCs behind all three exist and are audited, but nothing calls
-- them yet. Until that is built, this is the admin panel. Each part is
-- separately runnable and safe to re-run.
-- ---------------------------------------------------------------------------


-- ============================ PART 1 — the organisation =====================
-- Run once. Creates the company, its settings, and the yards it operates.
-- Edit the names; leave the ids alone unless you have a reason.

insert into organizations (id, name)
values ('11111111-1111-1111-1111-111111111111', 'RYLA Global Services')
on conflict (id) do update set name = excluded.name;

insert into org_settings (org_id)
values ('11111111-1111-1111-1111-111111111111')
on conflict (org_id) do nothing;

insert into yards (id, org_id, code, name) values
  ('22222222-2222-2222-2222-222222222221',
   '11111111-1111-1111-1111-111111111111', 'NSA', 'Nhava Sheva')
  -- add more yards here, one row each, with their own uuid and a short code
on conflict (id) do update set code = excluded.code, name = excluded.name;

select 'part 1 done — org and ' || count(*) || ' yard(s)' from yards;


-- ============================ PART 2 — the first admin ======================
-- Before running: Dashboard -> Authentication -> Users -> Add user.
-- Create the account, then copy its UUID into <ADMIN-AUTH-UUID> below.
--
-- This one is a direct insert rather than the RPC, because admin_create_profile
-- requires an existing admin to authorise it and there is not one yet. It is
-- the only profile that has to be made this way; every later one uses PART 3.

insert into profiles (id, org_id, role, full_name)
values (
  '<ADMIN-AUTH-UUID>',
  '11111111-1111-1111-1111-111111111111',
  'ADMIN',
  'Your Name'
)
on conflict (id) do update
  set role = excluded.role, full_name = excluded.full_name;

-- An admin sees the whole organisation, so they need no yard rows. Managers
-- and drivers do — PART 3 handles that.

select 'part 2 done — ' || full_name || ' is ' || role
  from profiles where id = '<ADMIN-AUTH-UUID>';


-- ============================ PART 3 — a manager or driver ==================
-- Repeat for each person. Create the auth user in the dashboard first, then
-- fill in the four values below.
--
-- This goes through the RPC so it is audited and so role and yard assignment
-- are validated. It must be run while signed in as an admin — in the SQL
-- editor that means setting the session to that admin first.

-- Wrapped in an explicit transaction. `set local role` outside one is a
-- no-op that only WARNS, so without the begin/commit this runs as the
-- superuser instead of as the admin — which would still succeed, and would
-- therefore prove nothing about whether an admin is allowed to do it.
begin;

select set_config(
  'request.jwt.claims',
  json_build_object('sub', '<ADMIN-AUTH-UUID>', 'role', 'authenticated')::text,
  true);
set local role authenticated;

select admin_create_profile(
  '<NEW-USER-AUTH-UUID>'::uuid,
  'DRIVER'::user_role,                 -- or 'MANAGER'
  'Driver Name',
  'E-107',                             -- employee number: unique per org, or null
  array['22222222-2222-2222-2222-222222222221']::uuid[]   -- yards they work
);

commit;

select 'part 3 done' as status;


-- ============================ PART 4 — device approval ======================
-- A driver's phone registers itself as PENDING the first time they sign in.
-- Until it is APPROVED the server refuses every movement with
-- DEVICE_NOT_APPROVED — which is correct, and with no approval screen yet it
-- is also a dead end.
--
-- Two ways out. Pick deliberately.

-- 4a. Approve the phones that have registered. Look first, then approve:
select d.id, d.device_key, d.status, p.full_name, d.created_at
  from devices d join profiles p on p.id = d.user_id
 order by d.created_at desc;

-- ...then, for each one you recognise:
-- update devices set status = 'APPROVED', approved_at = now(),
--        approved_by = '<ADMIN-AUTH-UUID>'
--  where id = '<DEVICE-ID>';

-- 4b. Or switch the control off for the pilot, and back on before go-live.
--
-- What you give up: device binding is what stops a driver's stolen or shared
-- credentials being used from another phone. Off, a password is enough. For a
-- supervised pilot on known handsets that is a reasonable trade; for a live
-- yard it is not, and 4a is a two-line update once there is a screen for it.
--
-- update org_settings set require_device_approval = false
--  where org_id = '11111111-1111-1111-1111-111111111111';


-- ============================ PART 5 — check it =============================
-- What a working bootstrap looks like.

select
  (select count(*) from organizations)                         as orgs,
  (select count(*) from yards)                                 as yards,
  (select count(*) from profiles where role = 'ADMIN')         as admins,
  (select count(*) from profiles where role = 'MANAGER')       as managers,
  (select count(*) from profiles where role = 'DRIVER')        as drivers,
  (select count(*) from devices where status = 'APPROVED')     as approved_devices,
  (select require_device_approval from org_settings limit 1)   as device_binding_on;
