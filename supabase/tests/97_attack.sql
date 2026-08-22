-- ---------------------------------------------------------------------------
-- Adversarial suite.
--
-- Written from the attacker's side: each block is something a malicious or
-- careless driver would actually try, expressed as the raw SQL a hand-crafted
-- PostgREST call would produce. Every one must fail.
-- ---------------------------------------------------------------------------
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c3');   -- an ordinary driver

-- ===================== "Let me see other people's work" =====================
do $$
begin
  perform tst.rowcount(
    'select * from movement_events where driver_id <> auth.uid()', 0,
    'a driver cannot read another driver''s movements');
  perform tst.rowcount(
    'select * from verification_attempts where driver_id <> auth.uid()', 0,
    'nor their scan attempts');
  perform tst.rowcount(
    'select * from exceptions where raised_by <> auth.uid()', 0,
    'nor exceptions they did not raise');
  perform tst.rowcount('select * from audit_logs', 0,
    'nor any audit history at all');
  perform tst.rowcount('select * from overrides where requested_by <> auth.uid()', 0,
    'nor overrides granted to others');
  perform tst.rowcount('select * from devices where user_id <> auth.uid()', 0,
    'nor other people''s devices');
  perform tst.rowcount('select * from manifest_imports', 0,
    'nor the import staging area');
  perform tst.rowcount('select * from manifest_corrections', 0,
    'nor the correction history');
end $$;

-- ================== "Let me change what I am supposed to do" ================
do $$
begin
  perform tst.throws(
    'update vehicle_assignments set chassis_no = ''MAT000000X0X00000''',
    'a driver cannot rewrite the chassis they are meant to collect');
  perform tst.throws(
    'update containers set container_no = ''CULVNSA0000000''',
    'nor the container');
  perform tst.throws(
    'update containers set expected_vehicle_count = 99',
    'nor a container''s capacity');
  perform tst.throws(
    'update vehicle_assignments set status = ''COMPLETED''',
    'nor mark their own assignment done');
  perform tst.throws(
    'delete from vehicle_assignments',
    'nor delete an assignment to make it go away');
  perform tst.throws(
    'update manifests set status = ''ARCHIVED''',
    'nor retire the manifest that is blocking them');
  perform tst.throws(
    'insert into manifests (org_id, yard_id, operating_date, version, status, created_by) '
    'values (''00000000-0000-0000-0000-0000000000a1'', '
    '''00000000-0000-0000-0000-0000000000b1'', current_date, 900, ''PUBLISHED'', auth.uid())',
    'nor publish a manifest of their own devising');
end $$;

-- ==================== "Let me record a movement myself" =====================
do $$
declare a uuid := (select id from vehicle_assignments limit 1);
begin
  perform tst.throws(format($q$
    insert into movement_events (id, org_id, yard_id, manifest_id, container_id,
      assignment_id, driver_id, expected_container_no, expected_chassis_no,
      scanned_container_no, scanned_chassis_no)
    select gen_random_uuid(), org_id, '00000000-0000-0000-0000-0000000000b1',
           manifest_id, container_id, id, auth.uid(), 'X', 'Y', 'X', 'Y'
      from vehicle_assignments where id = '%s'$q$, a),
    'a driver cannot write a movement directly');

  perform tst.throws(
    'update movement_events set status = ''COMPLETED''',
    'nor flip an existing one to completed');
  perform tst.throws(
    'update movement_events set scanned_chassis_no = ''MAT000000X0X00000''',
    'nor edit what a movement says was scanned');
  perform tst.throws('delete from movement_events', 'nor delete one');
end $$;

-- ================ "Let me forge the evidence for a movement" ================
do $$
begin
  perform tst.throws($q$
    insert into verification_attempts (id, org_id, yard_id, manifest_id, assignment_id,
      driver_id, kind, result, expected_container_no, expected_chassis_no, attempted_at_device)
    select gen_random_uuid(), org_id, '00000000-0000-0000-0000-0000000000b1',
           manifest_id, id, auth.uid(), 'CONTAINER', 'PASS', 'X', 'Y', now()
      from vehicle_assignments limit 1$q$,
    'a driver cannot insert a passing scan attempt by hand');

  perform tst.throws(
    'update verification_attempts set result = ''PASS'', outcome = ''MATCH''',
    'nor upgrade a failed attempt to a pass');
  perform tst.throws(
    'update verification_attempts set ocr_text_raw = ''something else''',
    'nor rewrite what the engine read');
  perform tst.throws(
    'update verification_attempts set container_image_sha256 = repeat(''0'', 64)',
    'nor change an image hash to match a substituted photograph');
end $$;

-- ================== "Let me approve my own way through" =====================
do $$
declare x uuid := (select id from exceptions where raised_by = auth.uid() limit 1);
begin
  perform tst.throws('update exceptions set status = ''RESOLVED''',
    'a driver cannot resolve an exception directly');
  perform tst.throws('delete from exceptions', 'nor delete one');
  perform tst.throws($q$
    insert into overrides (org_id, assignment_id, requested_by, approved_by, reason)
    select '00000000-0000-0000-0000-0000000000a1', id, auth.uid(), auth.uid(), 'OTHER'
      from vehicle_assignments limit 1$q$,
    'nor write themselves an override');
  if x is not null then
    perform tst.throws(format(
      'select approve_override(''%s'', ''MANIFEST_ERROR'', ''letting myself through'')', x),
      'nor call the approval function');
  end if;
end $$;

-- ===================== "Let me become someone else" =========================
do $$
begin
  perform tst.throws('update profiles set role = ''ADMIN'' where id = auth.uid()',
    'a driver cannot promote themselves');
  perform tst.throws('update profiles set is_active = true',
    'nor reactivate a suspended account');
  perform tst.throws($q$
    insert into user_yards (user_id, yard_id)
    values (auth.uid(), '00000000-0000-0000-0000-0000000000b2')$q$,
    'nor grant themselves another yard');
  perform tst.throws($q$
    update devices set status = 'APPROVED' where user_id = auth.uid()$q$,
    'nor approve their own device');
  perform tst.throws($q$
    insert into devices (user_id, device_key, status)
    values (auth.uid(), 'self-approved', 'APPROVED')$q$,
    'nor register one pre-approved');
  perform tst.throws(
    'select admin_create_profile(gen_random_uuid(), ''ADMIN'', ''Me Again'')',
    'nor create an admin account');
end $$;

-- ==================== "Let me tamper with the record" =======================
do $$
begin
  perform tst.throws(
    'insert into audit_logs (action, entity_type, row_hash) values (''forged'', ''x'', '''')',
    'a driver cannot write an audit row');
  perform tst.throws('update audit_logs set action = ''nothing happened''',
    'nor alter one');
  perform tst.throws('delete from audit_logs', 'nor delete one');
  perform tst.throws('truncate audit_logs', 'nor truncate the table');
  perform tst.throws('select verify_audit_chain(0)',
    'nor read the chain verifier, which is an admin tool');
end $$;

-- ============ "Let me point the RPCs at things that are not mine" ===========
do $$
declare
  other_assignment uuid;
begin
  -- An assignment in a yard this driver is not assigned to.
  select va.id into other_assignment
    from vehicle_assignments va
    join manifests m on m.id = va.manifest_id
   where m.yard_id = '00000000-0000-0000-0000-0000000000b2'
   limit 1;

  perform tst.throws(
    'select claim_assignment(gen_random_uuid())',
    'claiming a non-existent assignment fails rather than creating anything');

  perform tst.throws($q$
    select create_evidence_upload_path(gen_random_uuid(), 'CONTAINER', gen_random_uuid())$q$,
    'an upload path cannot be minted for an assignment that does not exist');

  perform tst.throws(
    'select create_manifest_upload_path(''00000000-0000-0000-0000-0000000000b1'', '
    'current_date, repeat(''a'',64), ''csv'')',
    'a driver cannot mint a manifest upload path at all');

  perform tst.throws(
    'select publish_manifest_from_import(''00000000-0000-0000-0000-0000000000e1'')',
    'nor publish a manifest');

  perform tst.throws(
    'select correct_manifest_assignment((select id from vehicle_assignments limit 1), '
    '''chassis_no'', ''MAT000000X0X00000'', ''changing this to suit myself'')',
    'nor correct the manifest');

  perform tst.throws(
    'select yard_board(''00000000-0000-0000-0000-0000000000b2'')',
    'nor read the board for a yard they do not work');
end $$;

-- ============= "Let me hijack another driver's queued movement" =============
select tst.login('00000000-0000-0000-0000-0000000000c4');
do $$
declare mv uuid := (select id from movement_events
                     where driver_id = '00000000-0000-0000-0000-0000000000c3' limit 1);
begin
  -- Reusing a movement id that belongs to someone else must be refused, not
  -- silently create a second record or overwrite the first.
  if mv is not null then
    perform tst.throws(format(
      'select verify_movement(''%s'', (select id from vehicle_assignments limit 1), '
      '''X'', ''Y'')', mv),
      'a driver cannot submit against another driver''s movement id');
  end if;
end $$;

select tst.logout();
reset role;

-- ======================= Grants, swept exhaustively =========================
-- Anything a future migration adds is caught here rather than in production.
do $$
declare g record;
begin
  for g in
    select table_name, privilege_type, grantee
      from information_schema.role_table_grants
     where table_schema = 'public'
       and grantee in ('anon', 'authenticated')
       and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES')
  loop
    -- The complete list of client-writable surfaces. Three tables, and each
    -- one is column-restricted and policy-gated. If this fails, a migration
    -- has widened the write boundary and the reviewer needs to know why.
    perform tst.ok(
      g.table_name in ('devices', 'manifest_imports', 'org_settings'),
      format('unexpected %s grant to %s on %s — the write boundary has widened',
             g.privilege_type, g.grantee, g.table_name));
  end loop;
end $$;

-- anon must reach nothing at all. It exists only to hit the auth endpoints.
do $$
begin
  perform tst.ok(
    not exists (
      select 1 from information_schema.role_table_grants
       where table_schema = 'public' and grantee = 'anon'),
    'the anonymous role holds no grant on any table');
end $$;

-- Every SECURITY DEFINER function must pin its search_path. A mutable one is
-- a privilege-escalation primitive.
do $$
declare f record;
begin
  for f in
    select p.proname, p.proconfig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname in ('public', 'app') and p.prosecdef
  loop
    perform tst.ok(
      f.proconfig is not null
        and exists (select 1 from unnest(f.proconfig) c where c like 'search_path=%'),
      format('SECURITY DEFINER function %s must pin search_path', f.proname));
  end loop;
end $$;
