-- ---------------------------------------------------------------------------
-- Device binding is a switch, and production has it off.
--
-- This file exists because of a real gap. The engine refuses a movement from an
-- unapproved handset, and 40_verification.sql proves it — but every call in
-- that file passes 'device-driver-1', an approved device the fixtures create.
-- The PWA passes no device key at all, and nothing anywhere inserts a row into
-- `devices`, so on a fresh project every driver's first scan came back
-- DEVICE_NOT_APPROVED while the whole suite stayed green.
--
-- So the assertion that matters is not "the gate works" — it is "the call shape
-- the browser actually sends succeeds". That is what is tested here.
--
-- The whole file runs inside a transaction that is rolled back. Verifying a
-- movement is not a read: a block records a verification attempt and raises an
-- exception, which parks the assignment, and the suites after this one are
-- written against a known fixture state. Rolling back is what lets this file
-- exercise the real engine — blocks included — without owing anything to the
-- files that follow it.
-- ---------------------------------------------------------------------------
begin;

-- The production posture, asserted at the schema level. A future migration that
-- moved this back to `true` without first building device registration would
-- reintroduce exactly the failure described above, and this is what would catch
-- it.
do $$
begin
  perform tst.eq(
    (select column_default from information_schema.columns
      where table_schema = 'public' and table_name = 'org_settings'
        and column_name = 'require_device_approval'),
    'false',
    'a new organisation gets device binding switched off');
end $$;

-- The fixtures pin org a1 to `true` on purpose, so that 40_verification.sql
-- keeps exercising the gate. Off for this transaction only.
update org_settings set require_device_approval = false
 where org_id = '00000000-0000-0000-0000-0000000000a1';

set local role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c3');   -- driver1, Nhava Sheva

do $$
declare
  a  uuid := tst.assignment_id('MAT752389T7R18439');   -- CAIU4330430, slot 1
  ca uuid := gen_random_uuid();
  ha uuid := gen_random_uuid();
  r  jsonb;
begin
  -- Evidence first, exactly as the driver's phone does it — and with no device
  -- key, because the phone has none to send.
  perform record_scan_attempt(
    ca, a, 'CONTAINER', 'CAIU4330430',
    create_evidence_upload_path(a, 'CONTAINER', ca), repeat('c', 64),
    null, 'CAIU4330430', 0.95, 'test-engine', 'OCR_AUTO', null);
  perform record_scan_attempt(
    ha, a, 'CHASSIS', 'MAT752389T7R18439',
    create_evidence_upload_path(a, 'CHASSIS', ha), repeat('h', 64),
    null, 'MAT752389T7R18439', 0.95, 'test-engine', 'OCR_AUTO', null);

  r := verify_movement(gen_random_uuid(), a, 'CAIU4330430', 'MAT752389T7R18439',
                       ca, ha,
                       null,       -- p_final_attempt_id
                       null,       -- p_device_key: what the browser sends
                       null, null, null, null, false, now(), 'pwa-shaped',
                       true);      -- p_commit: the real thing, not a check
  perform tst.eq(r ->> 'outcome', 'MATCH',
    'with binding off, a driver with no registered device verifies normally');
  perform tst.eq(r ->> 'status', 'COMPLETED',
    'and the movement completes rather than being blocked');
end $$;

-- Switched back on, the identical call is refused. That proves the setting is
-- what did the work above, rather than the gate having been removed outright:
-- the mechanism is intact and one UPDATE away, for the day there is a client
-- that registers a device and a screen that approves one.
--
-- No evidence is recorded for this one deliberately — the device check is
-- evaluated ahead of the evidence check, so DEVICE_NOT_APPROVED is what comes
-- back, and that ordering is worth pinning too.
reset role;
update org_settings set require_device_approval = true
 where org_id = '00000000-0000-0000-0000-0000000000a1';

set local role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
declare
  a uuid := tst.assignment_id('MAT752389T7R20588');   -- TRHU8755445, slot 1
  r jsonb;
begin
  r := verify_movement(gen_random_uuid(), a, 'TRHU8755445', 'MAT752389T7R20588',
                       null, null, null, null,
                       null, null, null, null, false, now(), 'pwa-shaped', false);
  perform tst.eq(r ->> 'outcome', 'DEVICE_NOT_APPROVED',
    'switched back on, the same call shape is refused');
end $$;

select tst.logout();
rollback;
