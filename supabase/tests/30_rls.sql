-- ---------------------------------------------------------------------------
-- Row level security.
--
-- These tests assert DENIAL. A policy suite that only proves the permitted
-- cases work is not a security test — it is a smoke test with ambition.
--
-- The standard being verified: delete every route guard from the React app and
-- no user gains a single row.
-- ---------------------------------------------------------------------------
set role authenticated;

-- ------------------------------ driver1, NSA -------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
begin
  perform tst.rowcount('select * from v_driver_tasks', 4,
    'driver1 sees the four tasks in their own yard');
  perform tst.rowcount('select * from manifests', 1,
    'driver1 sees exactly one manifest — the published one for their yard');
  perform tst.rowcount('select * from yards', 1,
    'driver1 sees only their assigned yard');
  perform tst.rowcount('select * from profiles', 1,
    'driver1 sees only their own profile, not their colleagues');
  perform tst.rowcount('select * from organizations', 1,
    'driver1 sees their own organisation');
  perform tst.rowcount('select * from audit_logs', 0,
    'a driver reads no audit log at all');
  perform tst.rowcount('select * from manifest_imports', 0,
    'a driver reads no manifest imports');

  -- The central write prohibition: there is no INSERT/UPDATE policy on
  -- movement_events for any role, so PostgREST cannot write it, ever.
  perform tst.throws($q$
    insert into movement_events (id, org_id, yard_id, manifest_id, container_id,
      assignment_id, driver_id, expected_container_no, expected_chassis_no,
      scanned_container_no, scanned_chassis_no)
    select gen_random_uuid(), '00000000-0000-0000-0000-0000000000a1',
           '00000000-0000-0000-0000-0000000000b1', va.manifest_id, va.container_id,
           va.id, '00000000-0000-0000-0000-0000000000c3',
           'X','Y','X','Y' from vehicle_assignments va limit 1$q$,
    'a driver cannot insert a movement directly');

  perform tst.throws(
    'update movement_events set status = ''COMPLETED''',
    'a driver cannot update a movement');

  perform tst.throws(
    'update vehicle_assignments set status = ''COMPLETED''',
    'a driver cannot mark their own assignment completed');

  perform tst.throws(
    'update vehicle_assignments set chassis_no = ''MAT000000X0X00000''',
    'a driver cannot alter a chassis number on the manifest');

  perform tst.throws(
    'update containers set container_no = ''CULVNSA0000000''',
    'a driver cannot alter a container number on the manifest');

  perform tst.throws(
    'insert into audit_logs (action, entity_type, row_hash) values (''forged'',''x'','''')',
    'a driver cannot write an audit row');

  perform tst.throws(
    'update profiles set role = ''ADMIN'' where id = auth.uid()',
    'a driver cannot escalate their own role');

  perform tst.throws(
    'insert into exceptions (org_id, yard_id, type, raised_by) values '
    '(''00000000-0000-0000-0000-0000000000a1'',''00000000-0000-0000-0000-0000000000b1'','
    '''OTHER'',auth.uid())',
    'a driver cannot insert an exception directly — it goes through an RPC');

  -- Device self-registration is permitted, but only as PENDING and only for
  -- oneself. A device that could self-approve would make binding decorative.
  perform tst.throws($q$
    insert into devices (user_id, device_key, status)
    values ('00000000-0000-0000-0000-0000000000c4', 'stolen-key', 'PENDING')$q$,
    'a driver cannot register a device for another user');

  perform tst.throws($q$
    update devices set status = 'APPROVED' where user_id = auth.uid()$q$,
    'a driver cannot approve their own device');
end $$;

-- --------------------- driver2, Mundra: horizontal denial -------------------
select tst.login('00000000-0000-0000-0000-0000000000c4');
do $$
begin
  perform tst.rowcount('select * from v_driver_tasks', 0,
    'driver2 sees NONE of the Nhava Sheva tasks');
  perform tst.rowcount('select * from manifests', 0,
    'driver2 sees no manifest for a yard they are not assigned to');
  perform tst.rowcount('select * from containers', 0,
    'driver2 sees no containers outside their yards');
  perform tst.rowcount('select * from vehicle_assignments', 0,
    'driver2 sees no assignments outside their yards');
  perform tst.rowcount(
    'select * from verification_attempts', 0,
    'driver2 sees no other driver''s verification attempts');
end $$;

-- ---------------------------- manager, NSA ---------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
begin
  perform tst.rowcount('select * from manifests', 1, 'manager sees their yard''s manifest');
  perform tst.rowcount('select * from yards', 1, 'manager sees only their yard');
  perform tst.rowcount('select * from manifest_imports', 1, 'manager sees their yard''s imports');
  perform tst.ok((select count(*) from profiles) >= 2,
    'manager sees the people who share their yard');

  perform tst.throws('update movement_events set status = ''COMPLETED''',
    'a manager cannot write a movement either');
  perform tst.throws('delete from audit_logs', 'a manager cannot delete audit history');
  perform tst.throws('update profiles set role = ''ADMIN'' where id = auth.uid()',
    'a manager cannot escalate their own role');
end $$;

-- ----------------------- manager2, Mundra: denial ---------------------------
select tst.login('00000000-0000-0000-0000-0000000000c5');
do $$
begin
  perform tst.rowcount('select * from manifests', 0,
    'a manager sees nothing from a yard they do not run');
  perform tst.rowcount('select * from manifest_imports', 0,
    'a manager sees no imports from another yard');
  perform tst.rowcount('select * from v_container_progress', 0,
    'a manager sees no container progress from another yard');
end $$;

-- --------------------------- admin, own org --------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c1');
do $$
begin
  perform tst.rowcount('select * from yards', 2, 'admin sees every yard in their org');
  perform tst.rowcount('select * from manifests', 1, 'admin sees the org''s manifests');
  perform tst.ok((select count(*) from audit_logs) > 0, 'admin reads the audit log');
  perform tst.ok((select count(*) from profiles) = 5, 'admin sees their org''s five people');

  perform tst.throws('delete from audit_logs', 'not even an admin can delete audit history');
  perform tst.throws('update movement_events set status = ''REVERSED''',
    'not even an admin can write a movement directly');
end $$;

-- ------------------- outsider, different organisation ----------------------
-- Tenant isolation. An ADMIN of another organisation must see nothing at all.
select tst.login('00000000-0000-0000-0000-0000000000c6');
do $$
begin
  perform tst.rowcount('select * from yards', 0, 'cross-org: no yards');
  perform tst.rowcount('select * from manifests', 0, 'cross-org: no manifests');
  perform tst.rowcount('select * from containers', 0, 'cross-org: no containers');
  perform tst.rowcount('select * from vehicle_assignments', 0, 'cross-org: no assignments');
  perform tst.rowcount('select * from movement_events', 0, 'cross-org: no movements');
  perform tst.rowcount('select * from verification_attempts', 0, 'cross-org: no attempts');
  perform tst.rowcount('select * from exceptions', 0, 'cross-org: no exceptions');
  perform tst.rowcount('select * from audit_logs', 0, 'cross-org: no audit history');
  perform tst.rowcount('select * from profiles', 1, 'cross-org: only their own profile');
  perform tst.rowcount('select * from v_driver_tasks', 0, 'cross-org: no tasks');
  perform tst.rowcount('select * from v_yard_dashboard', 0, 'cross-org: no dashboard');
  perform tst.rowcount('select * from v_activity_feed', 0, 'cross-org: no activity feed');
end $$;

-- ------------------------------ unauthenticated -----------------------------
select tst.logout();
do $$
begin
  perform tst.rowcount('select * from manifests', 0, 'anonymous session reads no manifests');
  perform tst.rowcount('select * from profiles', 0, 'anonymous session reads no profiles');
  perform tst.rowcount('select * from v_driver_tasks', 0, 'anonymous session reads no tasks');
end $$;

reset role;

-- Every view must be security_invoker. A view that is not silently bypasses
-- the RLS of its underlying tables.
do $$
declare v record;
begin
  for v in select c.relname, c.reloptions
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'v'
  loop
    perform tst.ok(
      coalesce(array_to_string(v.reloptions, ','), '') like '%security_invoker=true%',
      format('view %s must set security_invoker=true', v.relname));
  end loop;
end $$;

-- No table in public may exist without RLS enabled.
do $$
declare t record;
begin
  for t in select c.relname, c.relrowsecurity, c.relforcerowsecurity
             from pg_class c join pg_namespace n on n.oid = c.relnamespace
            where n.nspname = 'public' and c.relkind = 'r'
  loop
    perform tst.ok(t.relrowsecurity, format('table %s must have RLS enabled', t.relname));
    perform tst.ok(t.relforcerowsecurity, format('table %s must FORCE RLS', t.relname));
  end loop;
end $$;
