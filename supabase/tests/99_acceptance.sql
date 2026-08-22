-- ---------------------------------------------------------------------------
-- ACCEPTANCE
--
-- The business scenario from the build plan, run end to end, in order.
--
--   Container TRHU8755445
--     Vehicle 1  MAT752389T7R20588
--     Vehicle 2  MAT464844TSR09113
--
-- Every step below corresponds to a numbered acceptance criterion. If this
-- file passes, the system does what the business asked for.
-- ---------------------------------------------------------------------------
reset role;

-- A clean day, so the run is independent of everything before it.
insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
  file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-0000000acc01',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date + 100, 'acceptance.csv', 'p/q/acc.csv', repeat('1', 64), 512,
  'READY', 4, 4, 0, '00000000-0000-0000-0000-0000000000c2',
  '[
    {"row_no":1,"container_no":"TRHU8755445","chassis_no":"MAT752389T7R20588","sequence_no":1},
    {"row_no":2,"container_no":"TRHU8755445","chassis_no":"MAT464844TSR09113","sequence_no":2},
    {"row_no":3,"container_no":"CULVNSA2601799","chassis_no":"MAT111333E1E00001","sequence_no":1},
    {"row_no":4,"container_no":"CULVNSA2601799","chassis_no":"MAT111333E1E00002","sequence_no":2}
  ]'::jsonb
);

set role authenticated;

-- ============ 1. A manager publishes the day's manifest ======================
select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
declare r jsonb := publish_manifest_from_import(
  '00000000-0000-0000-0000-0000000acc01', 'ACCEPT-001');
begin
  perform tst.eq((r ->> 'containers')::int, 2, 'two containers published');
  perform tst.eq((r ->> 'vehicles')::int, 4, 'four vehicles published');
end $$;

-- ============ 2. The driver sees the correct next assignment ================
select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
declare t record;
begin
  select * into t from v_driver_tasks
   where container_no = 'TRHU8755445' and sequence_no = 1
     and operating_date = current_date + 100;
  perform tst.eq(t.chassis_no, 'MAT752389T7R20588', 'vehicle 1 of 2 is the first task');
  perform tst.eq(t.expected_vehicle_count, 2, 'the container takes two vehicles');
  perform tst.eq(t.container_filled::int, 0, 'none loaded yet');
end $$;

-- ============ 3-8. Correct container, correct chassis, completed =============
do $$
declare
  v1 uuid := tst.assignment_on(current_date + 100, 'MAT752389T7R20588');
  r  jsonb;
begin
  r := tst.scan_and_verify(v1, 'TRHU8755445', 'MAT752389T7R20588');
  perform tst.eq(r ->> 'outcome', 'MATCH', '3-6: both scans match');
  perform tst.eq(r ->> 'status', 'COMPLETED', '7: the movement completes');
  perform tst.eq((select status::text from vehicle_assignments where id = v1),
                 'COMPLETED', '8: the assignment is completed');

-- ============ 9. The container shows 1 of 2 =================================
  perform tst.eq((r ->> 'container_filled')::int, 1, '9: container shows 1 of 2');
  perform tst.eq((r ->> 'container_capacity')::int, 2, '9: out of 2');
end $$;

-- ============ 10. The next assignment appears ================================
do $$
declare t record;
begin
  select * into t from v_driver_tasks
   where container_no = 'TRHU8755445' and sequence_no = 2
     and operating_date = current_date + 100;
  perform tst.eq(t.chassis_no, 'MAT464844TSR09113', '10: vehicle 2 is next');
  perform tst.eq(t.container_filled::int, 1, '10: and the container shows 1 of 2');
end $$;

-- ============ 11-12. The second vehicle completes the container ==============
do $$
declare
  v2 uuid := tst.assignment_on(current_date + 100, 'MAT464844TSR09113');
  r  jsonb;
begin
  r := tst.scan_and_verify(v2, 'TRHU8755445', 'MAT464844TSR09113');
  perform tst.eq(r ->> 'outcome', 'MATCH', '11: the second vehicle verifies');
  perform tst.eq((r ->> 'container_filled')::int, 2, '12: the container is complete');

  perform tst.ok((select is_complete from v_container_progress
                   where container_no = 'TRHU8755445'
                     and operating_date = current_date + 100),
                 '12: and reports itself complete');
end $$;

-- ============ 13. The manager's board reflects it ============================
select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
declare b jsonb := yard_board('00000000-0000-0000-0000-0000000000b1', current_date + 100);
begin
  perform tst.eq((b -> 'counters' ->> 'vehiclesScheduled')::int, 4, '13: four scheduled');
  perform tst.eq((b -> 'counters' ->> 'vehiclesCompleted')::int, 2, '13: two completed');
  perform tst.ok(
    exists (select 1 from jsonb_array_elements(b -> 'containers') c
             where c ->> 'container_no' = 'TRHU8755445'
               and (c ->> 'filled')::int = 2),
    '13: the board shows the container full');
end $$;

-- ===========================================================================
-- FAILURE SCENARIOS
-- ===========================================================================
select tst.login('00000000-0000-0000-0000-0000000000c3');

do $$
declare
  a uuid := tst.assignment_on(current_date + 100, 'MAT111333E1E00001');
  r jsonb;
begin
  ------------------------------------------------------------ wrong container
  r := tst.scan_and_verify(a, 'TRHU8755445', 'MAT111333E1E00001');
  perform tst.eq(r ->> 'outcome', 'WRONG_CONTAINER', 'wrong container is blocked');

  -------------------------------------------------------------- wrong chassis
  r := tst.scan_and_verify(a, 'CULVNSA2601799', 'MAT111333E1E00002');
  perform tst.eq(r ->> 'outcome', 'WRONG_VEHICLE', 'wrong chassis is blocked');
  perform tst.eq(r -> 'detail' ->> 'scanned_vehicle_belongs_to_container',
                 'CULVNSA2601799',
                 'and the driver is told where that vehicle belongs');

  ------------------------------------------------------------- both wrong
  r := tst.scan_and_verify(a, 'TRHU8755445', 'MAT464844TSR09113');
  perform tst.eq(r ->> 'outcome', 'WRONG_CONTAINER',
                 'both wrong reports the container first');

  ------------------------------------------------------- already completed
  r := tst.scan_and_verify(tst.assignment_on(current_date + 100, 'MAT752389T7R20588'),
                           'TRHU8755445', 'MAT752389T7R20588');
  perform tst.eq(r ->> 'outcome', 'ALREADY_COMPLETED',
                 'a completed vehicle cannot be moved twice');

  ------------------------------------------------------------ evidence gone
  perform tst.eq(
    verify_movement(gen_random_uuid(), a, 'CULVNSA2601799', 'MAT111333E1E00001',
                    null, null, null, 'device-driver-1') ->> 'outcome',
    'EVIDENCE_MISSING', 'no photographs, no verification');

  ------------------------------------------------------- unapproved device
  r := tst.scan_and_verify(a, 'CULVNSA2601799', 'MAT111333E1E00001',
                           'device-driver-1-spare');
  perform tst.eq(r ->> 'outcome', 'DEVICE_NOT_APPROVED',
                 'an unapproved device cannot complete a movement');

  ------------------------------------------------------------- duplicate submit
  declare mv uuid := gen_random_uuid();
  begin
    r := tst.scan_and_verify(a, 'CULVNSA2601799', 'MAT111333E1E00001',
                             'device-driver-1', mv);
    perform tst.eq(r ->> 'outcome', 'MATCH', 'the first submission verifies');
    r := tst.scan_and_verify(a, 'CULVNSA2601799', 'MAT111333E1E00001',
                             'device-driver-1', mv);
    perform tst.eq(r ->> 'replayed', 'true', 'a duplicate submission is a replay');
    perform tst.eq((select count(*)::int from movement_events where id = mv), 1,
                   'and produces exactly one movement');
  end;
end $$;

------------------------------------------------------------ unauthorised driver
select tst.login('00000000-0000-0000-0000-0000000000c5');   -- a manager
do $$
begin
  perform tst.throws(format(
    'select verify_movement(gen_random_uuid(), ''%s'', ''CULVNSA2601799'', ''MAT111333E1E00002'')',
    tst.assignment_on(current_date + 100, 'MAT111333E1E00002')),
    'a non-driver cannot complete a movement');
end $$;

-------------------------------------------------------- invalid manifest data
select tst.logout();
reset role;
insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
  file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-0000000acc02',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date + 101, 'bad.csv', 'p/q/bad.csv', repeat('2', 64), 512,
  'READY', 2, 1, 1, '00000000-0000-0000-0000-0000000000c2',
  '[{"row_no":1,"container_no":"CULVNSA2601800","chassis_no":"MAT1","sequence_no":1}]'::jsonb
);
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
begin
  perform tst.throws(
    'select publish_manifest_from_import(''00000000-0000-0000-0000-0000000acc02'')',
    'a manifest with rejected rows cannot be published');
end $$;

------------------------------------------------------- duplicate chassis guard
reset role;
do $$
declare m uuid := (select id from manifests
                    where operating_date = current_date + 100 and status = 'PUBLISHED');
       c uuid;
begin
  select id into c from containers where manifest_id = m limit 1;
  perform tst.throws(format($q$
    insert into vehicle_assignments (manifest_id, container_id, chassis_no, sequence_no)
    values ('%s', '%s', 'MAT752389T7R20588', 5)$q$, m, c),
    'a chassis cannot be assigned twice in one manifest');
end $$;

-------------------------------------------------------------- the whole record
do $$
declare
  mv movement_events;
begin
  select * into mv from movement_events
   where assignment_id = tst.assignment_on(current_date + 100, 'MAT752389T7R20588')
     and status = 'COMPLETED'
   limit 1;

  perform tst.ok(mv.id is not null, 'the completed movement exists');
  perform tst.ok(mv.driver_id is not null, 'it names the driver');
  perform tst.ok(mv.verified_at is not null, 'it carries a server timestamp');
  perform tst.ok(mv.container_attempt_id is not null, 'and links the container evidence');
  perform tst.ok(mv.chassis_attempt_id is not null, 'and the chassis evidence');

  perform tst.ok(
    (select count(*) from audit_logs
      where action = 'movement.verified' and entity_id = mv.id) = 1,
    'and exactly one audit row records it');
end $$;

-- ===========================================================================
-- END-OF-SHIFT RECONCILIATION
--
-- The error no per-movement check can catch: a container sealed with one
-- vehicle instead of two. Every individual scan passed.
-- ===========================================================================
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
declare
  a uuid := tst.assignment_on(current_date + 100, 'MAT111333E1E00002');
  r jsonb;
begin
  -- Deliberately leave CULVNSA2601799 with only one of its two vehicles.
  perform tst.eq(
    (select count(*)::int from movement_events me
      join vehicle_assignments va on va.id = me.assignment_id
      join containers c on c.id = va.container_id
     where c.container_no = 'CULVNSA2601799'
       and me.status in ('COMPLETED','OVERRIDDEN')),
    1, 'precondition: one of two loaded');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
declare r jsonb := shift_report('00000000-0000-0000-0000-0000000000b1', current_date + 100);
       partial jsonb;
begin
  perform tst.ok(r is not null, 'the shift report returns');

  select value into partial
    from jsonb_array_elements(r -> 'partiallyLoaded')
   where value ->> 'containerNo' = 'CULVNSA2601799';

  perform tst.ok(partial is not null,
                 'a half-loaded container is reported at shift close');
  perform tst.eq((partial ->> 'expected')::int, 2, 'it says how many were expected');
  perform tst.eq((partial ->> 'loaded')::int, 1, 'and how many are in it');
  perform tst.ok(jsonb_array_length(partial -> 'missing') = 1,
                 'and NAMES the vehicle that is missing');
  perform tst.eq(partial -> 'missing' ->> 0, 'MAT111333E1E00002',
                 'by chassis number, so someone can go and find it');

  -- A full container must not appear.
  perform tst.ok(
    not exists (select 1 from jsonb_array_elements(r -> 'partiallyLoaded') c
                 where c ->> 'containerNo' = 'TRHU8755445'),
    'a complete container is not reported');

  perform tst.ok(r ? 'openExceptions', 'it counts open exceptions');
  perform tst.ok(r ? 'manualEntries', 'it counts manual entries');
  perform tst.ok(r ? 'clockAnomalies', 'and clock anomalies');
end $$;

-- A driver cannot see the shift report: it is a supervisory view.
select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
begin
  perform tst.throws(
    'select shift_report(''00000000-0000-0000-0000-0000000000b1'')',
    'a driver cannot read the shift report');
end $$;

select tst.logout();
reset role;
