-- ---------------------------------------------------------------------------
-- The verification engine, completing the acceptance matrix.
--
-- The cases the earlier suites did not reach, plus proof that a completed
-- movement actually carries everything a dispute six months later will need.
-- ---------------------------------------------------------------------------
reset role;
insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
  file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-00000000e200',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date + 10, 'engine.csv', 'p/q/engine.csv', repeat('f', 64), 256,
  'READY', 4, 4, 0, '00000000-0000-0000-0000-0000000000c2',
  '[
    {"row_no":1,"container_no":"CULVNSA2699200","chassis_no":"MAT800001B0B00001","sequence_no":1},
    {"row_no":2,"container_no":"CULVNSA2699200","chassis_no":"MAT800002B0B00002","sequence_no":2},
    {"row_no":3,"container_no":"CULVNSA2699201","chassis_no":"MAT800003B0B00003","sequence_no":1},
    {"row_no":4,"container_no":"CULVNSA2699201","chassis_no":"MAT800004B0B00004","sequence_no":2}
  ]'::jsonb
);
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c2');
select publish_manifest_from_import('00000000-0000-0000-0000-00000000e200', 'ENG-001');

select tst.login('00000000-0000-0000-0000-0000000000c3');

-- ------------------------- both values wrong --------------------------------
do $$
declare
  a uuid := tst.assignment_id('MAT800001B0B00001');
  r jsonb;
begin
  -- Container AND chassis both belong elsewhere. The container is evaluated
  -- first, so that is what the driver is told: it is the more actionable fact,
  -- and telling them about the chassis of a container they should not be
  -- standing at would send them looking in the wrong place.
  r := tst.scan_and_verify(a, 'CULVNSA2699201', 'MAT800003B0B00003');
  perform tst.eq(r ->> 'outcome', 'WRONG_CONTAINER',
                 'when both are wrong, the container is reported first');
  perform tst.eq(r ->> 'status', 'BLOCKED', 'and it is blocked');
  perform tst.eq((select count(*)::int from movement_events where assignment_id = a), 0,
                 'nothing recorded');
end $$;

-- ------------- evidence belonging to somebody else is not evidence -----------
do $$
declare
  a     uuid := tst.assignment_id('MAT800001B0B00001');
  other uuid := tst.assignment_id('MAT800003B0B00003');
  ca uuid := gen_random_uuid();
  cb uuid := gen_random_uuid();
  r  jsonb;
begin
  -- Attempts recorded against a DIFFERENT assignment must not satisfy this one.
  perform record_scan_attempt(ca, other, 'CONTAINER', 'CULVNSA2699201',
    create_evidence_upload_path(other, 'CONTAINER', ca), repeat('c', 64));
  perform record_scan_attempt(cb, other, 'CHASSIS', 'MAT800003B0B00003',
    create_evidence_upload_path(other, 'CHASSIS', cb), repeat('h', 64));

  r := verify_movement(gen_random_uuid(), a, 'CULVNSA2699200', 'MAT800001B0B00001',
                       ca, cb, null, 'device-driver-1');
  perform tst.eq(r ->> 'outcome', 'EVIDENCE_MISSING',
                 'evidence from another assignment does not count as evidence');
end $$;

-- --------------------- what a completed movement carries ---------------------
do $$
declare
  a  uuid := tst.assignment_id('MAT800001B0B00001');
  ca uuid := gen_random_uuid();
  cb uuid := gen_random_uuid();
  mv uuid := gen_random_uuid();
  m  movement_events;
  r  jsonb;
begin
  perform record_scan_attempt(ca, a, 'CONTAINER', 'CULVNSA2699200',
    create_evidence_upload_path(a, 'CONTAINER', ca), repeat('c', 64),
    null, 'CULVNSA2699200', 0.93, 'tesseract-6-wasm', 'OCR_AUTO', 'device-driver-1',
    18.9481, 72.9214, 12.0);
  perform record_scan_attempt(cb, a, 'CHASSIS', 'MAT800001B0B00001',
    create_evidence_upload_path(a, 'CHASSIS', cb), repeat('h', 64),
    null, 'MAT800001B0B00001', 0.88, 'tesseract-6-wasm', 'OCR_CONFIRMED', 'device-driver-1',
    18.9481, 72.9214, 12.0);

  r := verify_movement(mv, a, 'CULVNSA2699200', 'MAT800001B0B00001', ca, cb,
                       null, 'device-driver-1', 'MATCH',
                       18.9481, 72.9214, 12.0, false, now(), '1.0.0', true);
  perform tst.eq(r ->> 'outcome', 'MATCH', 'it verifies');

  select * into m from movement_events where id = mv;

  perform tst.eq(m.driver_id, auth.uid(), 'the operator is recorded');
  perform tst.ok(m.device_id is not null, 'the device is recorded');
  perform tst.ok(m.verified_at is not null, 'the server timestamp is recorded');
  perform tst.eq(m.expected_container_no, 'CULVNSA2699200',
                 'what was expected is stored on the record itself');
  perform tst.eq(m.scanned_chassis_no, 'MAT800001B0B00001', 'and what was scanned');
  perform tst.eq(m.container_attempt_id, ca, 'the container evidence is linked');
  perform tst.eq(m.chassis_attempt_id, cb, 'the chassis evidence is linked');
  perform tst.ok(m.final_attempt_id is not null, 'the deciding attempt is linked');
  perform tst.eq(m.gps_lat::numeric(8,4), 18.9481::numeric(8,4), 'GPS is recorded');
  perform tst.eq(m.app_version, '1.0.0', 'the app version is recorded');
  perform tst.ok(m.clock_skew_s is not null, 'device/server clock skew is materialised');

  -- The evidence itself.
  perform tst.eq((select count(*)::int from verification_attempts
                   where id in (ca, cb)
                     and coalesce(container_image_sha256, chassis_image_sha256) is not null), 2,
                 'both images carry a content hash');
  perform tst.eq((select ocr_text_raw from verification_attempts where id = ca),
                 'CULVNSA2699200',
                 'the raw OCR text is retained alongside the confirmed value');
  perform tst.eq((select value_source::text from verification_attempts where id = cb),
                 'OCR_CONFIRMED',
                 'how the value was obtained is permanently distinguishable');
end $$;

-- ----------------------- the client verdict is stored, not used --------------
do $$
declare
  a  uuid := tst.assignment_id('MAT800002B0B00002');
  ca uuid := gen_random_uuid();
  cb uuid := gen_random_uuid();
  r  jsonb;
begin
  perform record_scan_attempt(ca, a, 'CONTAINER', 'CULVNSA2699200',
    create_evidence_upload_path(a, 'CONTAINER', ca), repeat('c', 64));
  perform record_scan_attempt(cb, a, 'CHASSIS', 'MAT800004B0B00004',
    create_evidence_upload_path(a, 'CHASSIS', cb), repeat('h', 64));

  -- The device claims MATCH. The chassis belongs to another container.
  r := verify_movement(gen_random_uuid(), a, 'CULVNSA2699200', 'MAT800004B0B00004',
                       ca, cb, null, 'device-driver-1', 'MATCH');

  perform tst.eq(r ->> 'outcome', 'WRONG_VEHICLE',
                 'a device claiming MATCH does not make it one');
  perform tst.eq((select client_outcome::text from verification_attempts
                   where assignment_id = a and kind = 'FINAL'
                   order by created_at desc limit 1),
                 'MATCH', 'the device''s claim is stored');
  perform tst.eq((select outcome::text from verification_attempts
                   where assignment_id = a and kind = 'FINAL'
                   order by created_at desc limit 1),
                 'WRONG_VEHICLE', 'alongside the server''s decision');
end $$;

select tst.logout();
reset role;

-- The disagreement between device and server is queryable, which is what makes
-- a tampered client visible rather than merely theoretical.
do $$
begin
  perform tst.ok(
    (select count(*) from verification_attempts
      where kind = 'FINAL' and client_outcome is not null
        and client_outcome is distinct from outcome) > 0,
    'client/server disagreements are recorded and findable');
end $$;
