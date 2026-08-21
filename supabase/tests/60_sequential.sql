-- ---------------------------------------------------------------------------
-- Sequential loading, and the verify/confirm split.
--
-- Uses a manifest for a later operating date so it does not disturb the state
-- the earlier suites built.
-- ---------------------------------------------------------------------------
insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
  file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-0000000000e2',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date + 1, 'seq.csv', 'p/q/r/seq.csv', repeat('b', 64), 256,
  'READY', 2, 2, 0, '00000000-0000-0000-0000-0000000000c2',
  '[
    {"row_no":1,"container_no":"CULVNSA2699001","chassis_no":"MAT900001A0A00001","sequence_no":1},
    {"row_no":2,"container_no":"CULVNSA2699001","chassis_no":"MAT900002A0A00002","sequence_no":2}
  ]'::jsonb
);

set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c2');
select publish_manifest_from_import('00000000-0000-0000-0000-0000000000e2', 'SEQ-001');

select tst.login('00000000-0000-0000-0000-0000000000c3');   -- driver1

-- ---------------------------- out of sequence -------------------------------
do $$
declare
  slot2 uuid := tst.assignment_id('MAT900002A0A00002');
  slot1 uuid := tst.assignment_id('MAT900001A0A00001');
  r jsonb;
begin
  r := tst.scan_and_verify(slot2, 'CULVNSA2699001', 'MAT900002A0A00002');
  perform tst.eq(r ->> 'outcome', 'OUT_OF_SEQUENCE',
                 'slot 2 cannot be loaded while slot 1 is still open');
  perform tst.eq(r ->> 'status', 'BLOCKED', 'and it is blocked, not warned');
  perform tst.eq((select count(*)::int from movement_events where assignment_id = slot2), 0,
                 'no movement was recorded');

  -- Slot 1 is unaffected and loads normally.
  r := tst.scan_and_verify(slot1, 'CULVNSA2699001', 'MAT900001A0A00001');
  perform tst.eq(r ->> 'outcome', 'MATCH', 'slot 1 loads');

  -- With slot 1 done, slot 2 opens.
  r := tst.scan_and_verify(slot2, 'CULVNSA2699001', 'MAT900002A0A00002');
  perform tst.eq(r ->> 'outcome', 'MATCH', 'slot 2 opens once slot 1 is filled');
end $$;

-- --------------- an exception is the manager-authorised skip -----------------
reset role;
insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
  file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-0000000000e3',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date + 2, 'skip.csv', 'p/q/r/skip.csv', repeat('c', 64), 256,
  'READY', 2, 2, 0, '00000000-0000-0000-0000-0000000000c2',
  '[
    {"row_no":1,"container_no":"CULVNSA2699002","chassis_no":"MAT900003A0A00003","sequence_no":1},
    {"row_no":2,"container_no":"CULVNSA2699002","chassis_no":"MAT900004A0A00004","sequence_no":2}
  ]'::jsonb
);
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c2');
select publish_manifest_from_import('00000000-0000-0000-0000-0000000000e3', 'SKIP-001');

select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
declare
  slot1 uuid := tst.assignment_id('MAT900003A0A00003');
  slot2 uuid := tst.assignment_id('MAT900004A0A00004');
  r jsonb;
begin
  perform tst.eq(
    (tst.scan_and_verify(slot2, 'CULVNSA2699002', 'MAT900004A0A00004')) ->> 'outcome',
    'OUT_OF_SEQUENCE', 'blocked while slot 1 is open');

  -- The driver reports that the first vehicle is not in the yard. That parks
  -- the assignment and, deliberately, unblocks the next slot.
  perform raise_exception('MISSING_VEHICLE', 'Vehicle is not in the yard', slot1);

  r := tst.scan_and_verify(slot2, 'CULVNSA2699002', 'MAT900004A0A00004');
  perform tst.eq(r ->> 'outcome', 'MATCH',
                 'a parked assignment opens the next slot — the authorised skip');
  perform tst.eq((select status::text from vehicle_assignments where id = slot1),
                 'EXCEPTION', 'the skipped assignment stays visibly incomplete');
end $$;

-- ------------------------- verify, then confirm -----------------------------
reset role;
insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
  file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-0000000000e4',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date + 3, 'confirm.csv', 'p/q/r/c.csv', repeat('d', 64), 256,
  'READY', 1, 1, 0, '00000000-0000-0000-0000-0000000000c2',
  '[{"row_no":1,"container_no":"CULVNSA2699003","chassis_no":"MAT900005A0A00005","sequence_no":1}]'::jsonb
);
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c2');
select publish_manifest_from_import('00000000-0000-0000-0000-0000000000e4', 'CONF-001');

select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
declare
  a  uuid := tst.assignment_id('MAT900005A0A00005');
  mv uuid := gen_random_uuid();
  ca uuid := gen_random_uuid();
  ha uuid := gen_random_uuid();
  r  jsonb;
  attempts_before int;
begin
  perform record_scan_attempt(ca, a, 'CONTAINER', 'CULVNSA2699003',
    create_evidence_upload_path(a, 'CONTAINER', ca), repeat('c', 64));
  perform record_scan_attempt(ha, a, 'CHASSIS', 'MAT900005A0A00005',
    create_evidence_upload_path(a, 'CHASSIS', ha), repeat('h', 64));

  select count(*) into attempts_before from verification_attempts
   where assignment_id = a and kind = 'FINAL';

  -- VERIFY VEHICLE: the identical decision, without recording the movement.
  r := verify_movement(mv, a, 'CULVNSA2699003', 'MAT900005A0A00005', ca, ha,
                       null, 'device-driver-1', null, null, null, null, false,
                       now(), null, false);
  perform tst.eq(r ->> 'outcome', 'MATCH', 'the check passes');
  perform tst.eq(r ->> 'status', 'READY_TO_CONFIRM', 'and asks for confirmation');
  perform tst.ok((r ->> 'movement_id') is null, 'nothing is recorded yet');
  perform tst.eq((select count(*)::int from movement_events where assignment_id = a), 0,
                 'no movement exists after a check');
  perform tst.eq((select count(*)::int from verification_attempts
                   where assignment_id = a and kind = 'FINAL'), attempts_before,
                 'a passing check does not double the attempt rows');
  perform tst.eq((select status::text from vehicle_assignments where id = a), 'PENDING',
                 'the assignment is untouched by a check');

  -- CONFIRM VEHICLE MOVED: now it commits.
  r := verify_movement(mv, a, 'CULVNSA2699003', 'MAT900005A0A00005', ca, ha,
                       null, 'device-driver-1', null, null, null, null, false,
                       now(), null, true);
  perform tst.eq(r ->> 'status', 'COMPLETED', 'confirming records the movement');
  perform tst.eq((select count(*)::int from movement_events where assignment_id = a), 1,
                 'exactly one movement');
  perform tst.eq((select status::text from vehicle_assignments where id = a), 'COMPLETED',
                 'and the assignment is completed');
end $$;

-- A failing check still records the block. Evidence does not wait for a commit.
do $$
declare
  a  uuid := tst.assignment_id('MAT900004A0A00004');
  r  jsonb;
begin
  perform tst.eq((select status::text from vehicle_assignments where id = a), 'COMPLETED',
                 'precondition: it was completed above');
  r := verify_movement(gen_random_uuid(), a, 'CULVNSA2699002', 'MAT900004A0A00004',
                       null, null, null, 'device-driver-1', null, null, null, null,
                       false, now(), null, false);
  perform tst.eq(r ->> 'outcome', 'ALREADY_COMPLETED', 'the check reports the block');
  perform tst.ok((r ->> 'exception_id') is not null,
                 'a failing check raises an exception even though it did not commit');
end $$;

select tst.logout();
reset role;
