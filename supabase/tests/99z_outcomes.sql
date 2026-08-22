-- ---------------------------------------------------------------------------
-- Every rule outcome the engine can return, proved reachable.
--
-- Runs LAST, and deliberately so: proving MANIFEST_SUPERSEDED and
-- MANIFEST_NOT_PUBLISHED means publishing over the fixture manifest and
-- archiving it, and proving ASSIGNMENT_NOT_ACTIVE means cancelling one of its
-- vehicles. Every suite shares one database, so a file that does those things
-- anywhere but at the end quietly changes what the files after it are testing.
--
-- Written because an audit found five outcomes that no test exercised. Two of
-- them turned out to be unreachable in the engine itself, which is worse than
-- untested: an outcome the code can never produce is a promise the product
-- does not keep. Both were fixed rather than documented, and this file is what
-- stops either regressing.
-- ---------------------------------------------------------------------------
do $$
declare
  r          jsonb;
  v_a1       uuid;
  v_a2       uuid;
  v_other    uuid;
  v_manifest uuid;
  n          int;
begin
  -- 50_auth deactivates driver2 to prove that deactivation revokes access.
  -- This file needs them active again to prove something different: that an
  -- ACTIVE driver, with nothing wrong except the yard they work in, is still
  -- refused. Without this the test would pass for the wrong reason.
  set local role postgres;
  update profiles set is_active = true
   where id = '00000000-0000-0000-0000-0000000000c4';
  set local role authenticated;

  -- ------------------------------------------------- DRIVER_NOT_AUTHORISED
  -- driver2 works Mundra. The assignment is Nhava Sheva. Nothing about the
  -- scan is wrong — the numbers match — and it must still be refused.
  perform tst.login('00000000-0000-0000-0000-0000000000c3');
  v_a1 := tst.assignment_id('MAT752389T7R20588');
  perform tst.logout();

  perform tst.login('00000000-0000-0000-0000-0000000000c4');

  -- Two layers refuse this, and both matter. The outer one will not even mint
  -- an upload path for a vehicle outside the driver's yards, so the attempt
  -- cannot be recorded — a driver from another yard never gets as far as
  -- putting evidence in the bucket.
  perform tst.throws(format(
    'select create_evidence_upload_path(%L, ''CONTAINER''::attempt_kind, gen_random_uuid())', v_a1),
    'no evidence path is issued for another yard''s vehicle');

  -- The inner one is the engine's own verdict, reached when a call arrives
  -- without going through the upload path at all. Nothing about this scan is
  -- wrong — the container and chassis are the correct pair — and it is still
  -- refused, purely on who is asking.
  r := verify_movement(gen_random_uuid(), v_a1, 'TRHU8755445', 'MAT752389T7R20588',
                       null, null, null, 'device-driver-2');
  perform tst.eq(r ->> 'outcome', 'DRIVER_NOT_AUTHORISED',
                 'a driver from another yard is refused by the engine too');
  perform tst.eq(r ->> 'status', 'BLOCKED',
                 'and the movement is blocked');
  perform tst.ok(r ->> 'movement_id' is null,
                 'nothing is recorded as moved for an unauthorised driver');
  -- The attempt itself is filed as a rule failure rather than a mismatch: the
  -- numbers were right, the person was not.
  perform tst.eq(
    (select va.result::text from verification_attempts va
      where va.id = (r ->> 'attempt_id')::uuid),
    'FAIL_RULE', 'the attempt is recorded as a rule failure, not a mismatch');
  -- Checked before evidence, so the answer is about authority and does not
  -- leak into a complaint about a missing photograph.
  perform tst.ok(r ->> 'outcome' <> 'EVIDENCE_MISSING',
                 'the refusal names the real reason, not the missing evidence');
  perform tst.logout();

  perform tst.logout();

  -- ------------------------------------------------- ASSIGNMENT_NOT_ACTIVE
  -- A vehicle pulled from the day's work. The row stays for the audit trail;
  -- it must stop being loadable the moment it is cancelled.
  perform tst.login('00000000-0000-0000-0000-0000000000c3');
  v_other := tst.assignment_id('MAT464844TSR09257');
  perform tst.logout();

  set local role postgres;
  update vehicle_assignments
     set status = 'CANCELLED', cancelled_at = now(), cancel_reason = 'withdrawn by ops'
   where id = v_other;
  set local role authenticated;

  perform tst.login('00000000-0000-0000-0000-0000000000c3');
  r := tst.scan_and_verify(v_other, 'CAIU4330430', 'MAT464844TSR09257');
  perform tst.eq(r ->> 'outcome', 'ASSIGNMENT_NOT_ACTIVE',
                 'a cancelled assignment cannot be loaded');

  -- And the refusal must not quietly reinstate it. Blocking used to set every
  -- non-completed assignment to EXCEPTION, which took a vehicle ops had
  -- withdrawn and put it back in front of a manager as something to resolve.
  perform tst.eq((select status::text from vehicle_assignments where id = v_other),
                 'CANCELLED', 'a blocked scan leaves a cancelled vehicle cancelled');
  -- At least one, not exactly one: earlier suites have already raised
  -- exceptions against this vehicle, and pinning the total would make this
  -- assertion break every time an unrelated test is added.
  select count(*) into n from exceptions where assignment_id = v_other;
  perform tst.ok(n >= 1, 'the block is still recorded as an exception');
  perform tst.logout();

  -- Cancelling frees the chassis, so a corrected assignment can reuse it.
  -- That is the whole reason the uniqueness index is partial.
  set local role postgres;
  select manifest_id into v_manifest from vehicle_assignments where id = v_other;
  insert into vehicle_assignments (manifest_id, container_id, chassis_no, sequence_no)
  select v_manifest, container_id, 'MAT464844TSR09257', 3
    from vehicle_assignments where id = v_other;
  select count(*) into n from vehicle_assignments
   where manifest_id = v_manifest and chassis_no = 'MAT464844TSR09257';
  perform tst.eq(n, 2, 'a cancelled row does not block a corrected one');
  -- But two ACTIVE rows for one chassis must still be impossible.
  perform tst.throws(format(
    'update vehicle_assignments set status = ''PENDING'' where id = %L', v_other),
    'un-cancelling would give one chassis two live containers');
  set local role authenticated;

  -- ------------------------------------------------- MANIFEST_SUPERSEDED
  -- The offline case. A driver holds yesterday's plan on a phone that has been
  -- out of signal; the manager has since published a corrected version.
  perform tst.login('00000000-0000-0000-0000-0000000000c3');
  v_a2 := tst.assignment_id('MAT752389T7R18439');
  perform tst.logout();

  set local role postgres;
  insert into manifest_imports (
    id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
    file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
  ) values (
    '00000000-0000-0000-0000-0000000000e9',
    '00000000-0000-0000-0000-0000000000a1',
    '00000000-0000-0000-0000-0000000000b1',
    current_date, 'manifest-v2.csv',
    '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000b1/x/v2.csv',
    repeat('b', 64), 512, 'READY', 2, 2, 0,
    '00000000-0000-0000-0000-0000000000c2',
    '[
      {"row_no":1,"container_no":"TGBU8901124","chassis_no":"MAT752389T7R19760","sequence_no":1},
      {"row_no":2,"container_no":"TGBU8901124","chassis_no":"MAT464844TSR09235","sequence_no":2}
    ]'::jsonb
  );
  set local role authenticated;

  perform tst.login('00000000-0000-0000-0000-0000000000c2');
  perform publish_manifest_from_import('00000000-0000-0000-0000-0000000000e9', 'REF-002');
  perform tst.logout();

  perform tst.login('00000000-0000-0000-0000-0000000000c3');

  -- The phone cannot even file evidence against the stale plan.
  perform tst.throws(format(
    'select create_evidence_upload_path(%L, ''CONTAINER''::attempt_kind, gen_random_uuid())', v_a2),
    'no evidence path is issued against a superseded manifest');

  -- What the queued offline movement gets when it finally reaches the server.
  r := verify_movement(gen_random_uuid(), v_a2, 'CAIU4330430', 'MAT752389T7R18439',
                       null, null, null, 'device-driver-1');
  perform tst.eq(r ->> 'outcome', 'MANIFEST_SUPERSEDED',
                 'a movement against a replaced manifest says so specifically');
  perform tst.ok(r ->> 'outcome' <> 'MANIFEST_NOT_PUBLISHED',
                 'and is NOT reported as the generic manifest failure');

  -- The distinction has to reach the manager as a different kind of problem:
  -- one is "your driver needs to sync", the other is "your manifest is broken".
  perform tst.rowcount(format(
    'select 1 from exceptions where assignment_id = %L and type = ''MANIFEST_CONFLICT''', v_a2),
    1, 'it raises a manifest CONFLICT, not a manifest ERROR');
  perform tst.logout();

  -- ------------------------------------------------- MANIFEST_NOT_PUBLISHED
  -- The other half of that branch: archived with nothing newer behind it.
  set local role postgres;
  update manifests set status = 'ARCHIVED'
   where yard_id = '00000000-0000-0000-0000-0000000000b1' and status = 'PUBLISHED';
  set local role authenticated;

  perform tst.login('00000000-0000-0000-0000-0000000000c3');
  r := verify_movement(gen_random_uuid(), v_a1, 'TRHU8755445', 'MAT752389T7R20588',
                       null, null, null, 'device-driver-1');
  perform tst.eq(r ->> 'outcome', 'MANIFEST_NOT_PUBLISHED',
                 'with no newer version, it is a manifest problem not a sync problem');
  perform tst.logout();

  raise notice '41_outcomes: ok';
end $$;

-- --------------------------------------------------------------------------
-- The rule itself, at the type level: one chassis, one container. There is no
-- outcome for "the right vehicle in the wrong way" because there is no such
-- state — a scanned chassis is assigned here, assigned elsewhere, or nowhere.
-- --------------------------------------------------------------------------
do $$
declare vals text[];
begin
  select array_agg(e.enumlabel::text order by e.enumsortorder)
    into vals
    from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'verification_outcome';

  perform tst.ok(not ('WRONG_CHASSIS' = any(vals)),
                 'there is no WRONG_CHASSIS outcome to write a branch for');
  perform tst.ok('WRONG_VEHICLE' = any(vals),
                 'a chassis assigned to another container is WRONG_VEHICLE');
  perform tst.ok('CHASSIS_NOT_ON_MANIFEST' = any(vals),
                 'a chassis assigned nowhere is CHASSIS_NOT_ON_MANIFEST');

  raise notice '41_outcomes enum: ok';
end $$;
