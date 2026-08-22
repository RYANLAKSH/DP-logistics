-- ---------------------------------------------------------------------------
-- The verification engine. This is the security-critical core: every outcome,
-- in its specified evaluation order, plus idempotency and authorisation.
--
-- Scenario (from the build plan):
--   TRHU8755445  <- MAT752389T7R20588 (slot 1), MAT464844TSR09113 (slot 2)
--   CAIU4330430  <- MAT752389T7R18439 (slot 1), MAT464844TSR09257 (slot 2)
-- ---------------------------------------------------------------------------
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c3');   -- driver1, Nhava Sheva

-- ============================ FAILURE CASES ================================
do $$
declare
  a1 uuid := tst.assignment_id('MAT752389T7R18439');   -- belongs to CAIU4330430
  r  jsonb;
begin
  ---------------------------------------------------------------- wrong container
  -- Correct vehicle, but scanned a container that belongs to another vehicle.
  r := tst.scan_and_verify(a1, 'TRHU8755445', 'MAT752389T7R18439');
  perform tst.eq(r ->> 'outcome', 'WRONG_CONTAINER', 'scanning another container blocks');
  perform tst.eq(r ->> 'status', 'BLOCKED', 'a wrong container is blocked, not warned');
  perform tst.ok((r ->> 'movement_id') is null, 'no movement is recorded for a block');
  perform tst.ok((r ->> 'exception_id') is not null, 'a block raises an exception');
  perform tst.eq((r -> 'detail' ->> 'scanned_container_belongs_to_manifest'), 'true',
                 'the response says the scanned container is on the manifest');

  ------------------------------------------------------ container not on manifest
  r := tst.scan_and_verify(a1, 'CULVNSA9999999', 'MAT752389T7R18439');
  perform tst.eq(r ->> 'outcome', 'CONTAINER_NOT_ON_MANIFEST',
                 'an unknown container is distinguished from a wrong one');

  ------------------------------------------------------------------ wrong vehicle
  -- THE case the product exists for: right container, vehicle assigned elsewhere.
  r := tst.scan_and_verify(a1, 'CAIU4330430', 'MAT752389T7R20588');
  perform tst.eq(r ->> 'outcome', 'WRONG_VEHICLE', 'a vehicle from another container blocks');
  perform tst.eq(r -> 'detail' ->> 'scanned_vehicle_belongs_to_container', 'TRHU8755445',
                 'the driver is told which container that vehicle is actually for');

  ------------------------------------------------ wrong container AND wrong chassis
  -- Both values belong to the other container. The driver is told about the
  -- CONTAINER, because that is the thing they are standing in front of and the
  -- thing they can act on: walk to the right box and the chassis is right too.
  -- Reporting the vehicle first would send them looking for a second problem
  -- that does not exist. The evaluation order is the specification, not an
  -- accident of how the branches were written.
  r := tst.scan_and_verify(a1, 'TRHU8755445', 'MAT752389T7R20588');
  perform tst.eq(r ->> 'outcome', 'WRONG_CONTAINER',
                 'when both are wrong, the container is the reported failure');
  perform tst.eq(r ->> 'status', 'BLOCKED', 'and it is blocked');
  perform tst.ok((r ->> 'movement_id') is null, 'with nothing recorded as moved');
  -- The scanned pair is preserved verbatim, so the manager reviewing the
  -- exception can see that BOTH were wrong even though one was reported.
  perform tst.eq(r ->> 'scanned_container_no', 'TRHU8755445',
                 'the scanned container is kept on the record');
  perform tst.eq(r ->> 'scanned_chassis_no', 'MAT752389T7R20588',
                 'and so is the scanned chassis');
  perform tst.eq(r ->> 'expected_container_no', 'CAIU4330430',
                 'alongside what was expected');

  ------------------------------------------------------- chassis not on manifest
  r := tst.scan_and_verify(a1, 'CAIU4330430', 'MAT000000X0X00000');
  perform tst.eq(r ->> 'outcome', 'CHASSIS_NOT_ON_MANIFEST',
                 'an unknown chassis is distinguished from a misdirected one');

  -------------------------------------------------------------- evidence missing
  perform tst.eq(
    verify_movement(gen_random_uuid(), a1, 'CAIU4330430', 'MAT752389T7R18439',
                    null, null, null, 'device-driver-1') ->> 'outcome',
    'EVIDENCE_MISSING',
    'a movement without evidence cannot be verified');

  ------------------------------------------------------------ unapproved device
  r := tst.scan_and_verify(a1, 'CAIU4330430', 'MAT752389T7R18439',
                           'device-driver-1-spare');
  perform tst.eq(r ->> 'outcome', 'DEVICE_NOT_APPROVED',
                 'an unapproved device cannot complete a movement');

  -- Every one of those was recorded. A blocked attempt is evidence.
  perform tst.ok((select count(*) from verification_attempts
                   where assignment_id = a1 and kind = 'FINAL' and result <> 'PASS') = 7,
                 'all six blocked attempts were retained');
  perform tst.ok((select count(*) from exceptions where assignment_id = a1) = 7,
                 'each block raised an exception');
  perform tst.ok((select count(*) from movement_events where assignment_id = a1) = 0,
                 'not one blocked attempt produced a movement');
end $$;

-- ============================== HAPPY PATH =================================
do $$
declare
  v1 uuid := tst.assignment_id('MAT752389T7R20588');
  v2 uuid := tst.assignment_id('MAT464844TSR09113');
  r  jsonb;
begin
  -- Vehicle 1 of 2.
  r := tst.scan_and_verify(v1, 'TRHU8755445', 'MAT752389T7R20588',
                           'device-driver-1', null, 'MATCH');
  perform tst.eq(r ->> 'outcome', 'MATCH', 'correct container + correct chassis verifies');
  perform tst.eq(r ->> 'status', 'COMPLETED', 'the movement is completed');
  perform tst.eq(r ->> 'container_filled', '1', 'container shows 1 of 2');
  perform tst.eq(r ->> 'container_capacity', '2', 'capacity is 2');
  perform tst.eq((select status::text from vehicle_assignments where id = v1), 'COMPLETED',
                 'the assignment is marked completed');

  -- Vehicle 2 of 2.
  r := tst.scan_and_verify(v2, 'TRHU8755445', 'MAT464844TSR09113',
                           'device-driver-1', null, 'MATCH');
  perform tst.eq(r ->> 'outcome', 'MATCH', 'the second vehicle verifies');
  perform tst.eq(r ->> 'container_filled', '2', 'container shows 2 of 2');

  perform tst.ok((select is_complete from v_container_progress
                   where container_no = 'TRHU8755445'),
                 'the container reports complete');

  -- The device agreed with the server on both. Disagreement is a signal, so it
  -- has to be recorded either way.
  perform tst.ok((select bool_and(client_outcome = outcome)
                    from verification_attempts
                   where kind = 'FINAL' and assignment_id in (v1, v2)),
                 'client and server verdicts agreed and both were stored');

  ------------------------------------------------------------ already completed
  r := tst.scan_and_verify(v1, 'TRHU8755445', 'MAT752389T7R20588');
  perform tst.eq(r ->> 'outcome', 'ALREADY_COMPLETED',
                 'a completed assignment cannot be completed twice');
  perform tst.eq((select count(*)::int from movement_events
                   where assignment_id = v1 and status = 'COMPLETED'), 1,
                 'still exactly one completion after the retry');
end $$;

-- ============================ IDEMPOTENCY ==================================
do $$
declare
  a  uuid := tst.assignment_id('MAT752389T7R18439');
  mv uuid := gen_random_uuid();
  r1 jsonb; r2 jsonb;
begin
  r1 := tst.scan_and_verify(a, 'CAIU4330430', 'MAT752389T7R18439',
                            'device-driver-1', mv);
  perform tst.eq(r1 ->> 'outcome', 'MATCH', 'first submission verifies');

  -- A double tap, a retry after a timeout, or an outbox replay: same movement
  -- id, same values. Must return the original result and change nothing.
  r2 := tst.scan_and_verify(a, 'CAIU4330430', 'MAT752389T7R18439',
                            'device-driver-1', mv);
  perform tst.eq(r2 ->> 'replayed', 'true', 'the replay is recognised');
  perform tst.eq(r2 ->> 'movement_id', r1 ->> 'movement_id', 'the same movement is returned');
  perform tst.eq((select count(*)::int from movement_events where id = mv), 1,
                 'exactly one movement row exists');

  -- The same id with DIFFERENT scanned values is not a retry. It is either a
  -- bug or an attack, and it must not overwrite the original.
  r2 := tst.scan_and_verify(a, 'TRHU8755445', 'MAT752389T7R20588',
                            'device-driver-1', mv);
  perform tst.eq(r2 ->> 'outcome', 'REPLAY_CONFLICT',
                 'a movement id resubmitted with different values is refused');
  perform tst.eq(r2 ->> 'status', 'BLOCKED', 'the conflicting replay is blocked');
  perform tst.eq((select scanned_chassis_no from movement_events where id = mv),
                 'MAT752389T7R18439',
                 'the originally recorded values are untouched');
  perform tst.ok((select count(*) > 0 from exceptions
                   where type = 'SYNC_ISSUE' and severity = 1),
                 'the conflicting replay raised a critical exception that SURVIVED');
  -- (the audit assertion for this lives in the AUDIT COVERAGE block below:
  --  a driver cannot read audit_logs, which is itself the correct behaviour)
end $$;

-- ============================ CONTAINER FULL ================================
select tst.logout();
reset role;
-- A manifest may legitimately state a capacity lower than the number of rows
-- (a container downgraded after allocation). Simulate that directly.
update containers set expected_vehicle_count = 1 where container_no = 'CAIU4330430';

set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
declare
  a2 uuid := tst.assignment_id('MAT464844TSR09257');
  r  jsonb;
begin
  r := tst.scan_and_verify(a2, 'CAIU4330430', 'MAT464844TSR09257');
  perform tst.eq(r ->> 'outcome', 'CONTAINER_FULL',
                 'a container at capacity refuses another vehicle');
  perform tst.eq(r -> 'detail' ->> 'capacity', '1', 'the response reports the capacity');
end $$;

-- ======================== AUTHORISATION BOUNDARIES ==========================
select tst.login('00000000-0000-0000-0000-0000000000c4');   -- driver2, Mundra
do $$
declare a uuid;
begin
  -- driver2 cannot even resolve the assignment through RLS, and the RPC
  -- refuses it on yard scope regardless.
  perform tst.throws(
    'select tst.scan_and_verify((select id from vehicle_assignments limit 1), '
    '''TRHU8755445'', ''MAT752389T7R20588'', ''device-driver-2'')',
    'a driver from another yard cannot verify a movement there');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c2');   -- a manager
do $$
begin
  perform tst.throws(
    'select verify_movement(gen_random_uuid(), (select id from vehicle_assignments limit 1), '
    '''TRHU8755445'', ''MAT752389T7R20588'')',
    'a manager cannot complete a movement — only a DRIVER can');
  perform tst.throws(
    'select claim_assignment((select id from vehicle_assignments limit 1))',
    'a manager cannot claim a driver task');
end $$;

select tst.logout();
do $$
begin
  perform tst.throws(
    'select verify_movement(gen_random_uuid(), gen_random_uuid(), ''X'', ''Y'')',
    'an unauthenticated caller cannot verify anything');
end $$;

reset role;

-- ============================ AUDIT COVERAGE ================================
do $$
begin
  perform tst.ok((select count(*) from audit_logs where action = 'movement.verified') = 3,
                 'every verified movement wrote an audit row');
  perform tst.ok((select count(*) from audit_logs where action = 'movement.blocked') >= 7,
                 'every blocked movement wrote an audit row');
  perform tst.ok((select count(*) from audit_logs where action = 'manifest.published') = 1,
                 'publishing wrote an audit row');
  perform tst.ok((select bool_and(row_hash is not null and length(row_hash) = 64)
                    from audit_logs),
                 'every audit row carries a sha256 hash');
  perform tst.ok((select count(*) > 0 from audit_logs
                   where action = 'movement.replay_conflict'),
                 'the conflicting replay was audited');
  perform tst.ok((select count(*) > 0 from audit_logs where action = 'scan.failed'),
                 'failed scans were audited');
end $$;
