-- ---------------------------------------------------------------------------
-- Exception resolution and overrides.
-- ---------------------------------------------------------------------------
reset role;
insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
  file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-00000000e300',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date + 20, 'exc.csv', 'p/q/exc.csv', repeat('9', 64), 256,
  'READY', 3, 3, 0, '00000000-0000-0000-0000-0000000000c2',
  '[
    {"row_no":1,"container_no":"CULVNSA2699300","chassis_no":"MAT700001C0C00001","sequence_no":1},
    {"row_no":2,"container_no":"CULVNSA2699301","chassis_no":"MAT700002C0C00002","sequence_no":1},
    {"row_no":3,"container_no":"CULVNSA2699302","chassis_no":"MAT700003C0C00003","sequence_no":1}
  ]'::jsonb
);
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c2');
select publish_manifest_from_import('00000000-0000-0000-0000-00000000e300', 'EXC-001');

-- ------------------------------ who may resolve ------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c3');   -- driver
do $$
declare e exceptions;
begin
  e := raise_exception('DAMAGED_CHASSIS_MARKING', 'Plate corroded',
                       tst.assignment_id('MAT700001C0C00001'));
  perform tst.throws(format('select resolve_exception(''%s'', ''FALSE_ALARM'', ''nothing wrong'')', e.id),
                     'a driver cannot resolve an exception');
  perform tst.throws(format('select acknowledge_exception(''%s'')', e.id),
                     'a driver cannot acknowledge one either');
  perform tst.throws(format('select cancel_exception(''%s'', ''never mind'')', e.id),
                     'and cannot cancel one');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c5');   -- a manager, wrong yard
do $$
declare e uuid := (select id from exceptions
                    where type = 'DAMAGED_CHASSIS_MARKING' order by raised_at desc limit 1);
begin
  perform tst.throws(format('select resolve_exception(''%s'', ''FALSE_ALARM'', ''not mine'')', e),
                     'a manager cannot resolve an exception in another yard');
end $$;

-- --------------------------- resolving properly ------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c2');   -- the right manager
do $$
declare
  e uuid := (select id from exceptions
              where type = 'DAMAGED_CHASSIS_MARKING' order by raised_at desc limit 1);
  a uuid := tst.assignment_id('MAT700001C0C00001');
  x exceptions;
begin
  perform tst.throws(format('select resolve_exception(''%s'', ''FALSE_ALARM'', ''ok'')', e),
                     'a resolution needs a substantive note');

  perform tst.throws(
    format('select resolve_exception(''%s'', ''OVERRIDE_APPROVED'', ''just letting it through'')', e),
    'an override cannot be selected as a resolution code — it has its own path');

  x := acknowledge_exception(e);
  perform tst.eq(x.status::text, 'UNDER_REVIEW', 'acknowledging moves it to review');
  perform tst.eq(x.acknowledged_by, auth.uid(), 'and records who');

  x := resolve_exception(e, 'MANUAL_ENTRY_AUTHORISED', 'Inspected the plate and authorised typed entry');
  perform tst.eq(x.status::text, 'RESOLVED', 'it resolves');
  perform tst.eq(x.resolution::text, 'MANUAL_ENTRY_AUTHORISED', 'with a code');
  perform tst.ok(x.resolution_note is not null, 'and a note');
  perform tst.eq((select status::text from vehicle_assignments where id = a), 'PENDING',
                 'the task is released back to the driver');

  perform tst.throws(format('select resolve_exception(''%s'', ''FALSE_ALARM'', ''again please'')', e),
                     'a resolved exception cannot be resolved twice');

  perform tst.ok((select count(*) > 0 from audit_logs where action = 'exception.resolved'),
                 'resolution is audited');
end $$;

-- Rescheduling cancels the assignment rather than releasing it.
select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
declare e exceptions;
begin
  e := raise_exception('MISSING_VEHICLE', 'Not in the yard',
                       tst.assignment_id('MAT700002C0C00002'));
  perform set_config('tst.resched', e.id::text, false);
end $$;
select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
declare
  e uuid := current_setting('tst.resched')::uuid;
  a uuid := tst.assignment_id('MAT700002C0C00002');
begin
  perform resolve_exception(e, 'VEHICLE_RESCHEDULED', 'Vehicle moved to tomorrow''s manifest');
  perform tst.eq((select status::text from vehicle_assignments where id = a), 'CANCELLED',
                 'a rescheduled vehicle is cancelled, not left pending');
end $$;

-- ------------------------------ overrides ------------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c3');   -- driver
do $$
declare
  a uuid := tst.assignment_id('MAT700003C0C00003');
  r jsonb;
  e uuid;
begin
  -- A genuine block: the driver scans a vehicle assigned elsewhere.
  r := tst.scan_and_verify(a, 'CULVNSA2699302', 'MAT700001C0C00001');
  perform tst.eq(r ->> 'outcome', 'WRONG_VEHICLE', 'blocked as expected');
  e := (r ->> 'exception_id')::uuid;

  perform request_override(e, 'Transporter substituted the vehicle at the gate');
  perform tst.ok((select override_requested from exceptions where id = e),
                 'the request is recorded on the exception');
  perform set_config('tst.override_exception', e::text, false);

  perform tst.throws(format(
    'select approve_override(''%s'', ''MANIFEST_ERROR'', ''approving my own request'')', e),
    'a driver cannot approve their own override');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c2');   -- the manager approves
do $$
declare
  e uuid := current_setting('tst.override_exception')::uuid;
  a uuid := tst.assignment_id('MAT700003C0C00003');
  r jsonb;
  o overrides;
begin
  r := approve_override(e, 'LAST_MINUTE_SUBSTITUTION',
                        'Transporter swapped the vehicle; confirmed with operations');
  perform tst.eq(r ->> 'status', 'OVERRIDDEN', 'the movement is recorded as overridden');

  perform tst.eq((select status::text from movement_events where id = (r ->> 'movement_id')::uuid),
                 'OVERRIDDEN', 'and never as a plain completion');
  perform tst.eq((select status::text from vehicle_assignments where id = a), 'COMPLETED',
                 'the assignment closes');
  perform tst.eq((select status::text from exceptions where id = e), 'RESOLVED',
                 'the exception resolves');
  perform tst.eq((select resolution::text from exceptions where id = e), 'OVERRIDE_APPROVED',
                 'with the override code');

  select * into o from overrides where exception_id = e;
  perform tst.ok(o.requested_by <> o.approved_by, 'two different people');
  perform tst.eq(o.reason::text, 'LAST_MINUTE_SUBSTITUTION', 'with a mandatory reason code');

  -- What was actually scanned is preserved. An override authorises what
  -- happened; it does not rewrite it.
  perform tst.eq((select scanned_chassis_no from movement_events
                   where id = (r ->> 'movement_id')::uuid),
                 'MAT700001C0C00001',
                 'the record keeps the chassis the driver actually scanned');

  perform tst.ok((select count(*) > 0 from audit_logs where action = 'override.approved'),
                 'the override is audited');

  perform tst.throws(format(
    'select approve_override(''%s'', ''MANIFEST_ERROR'', ''twice'')', e),
    'an override cannot be approved twice');
end $$;

-- A manager cannot approve an override they requested. Belt and braces: the
-- function refuses it and a CHECK constraint refuses it.
do $$
begin
  perform tst.throws($q$
    insert into overrides (org_id, assignment_id, requested_by, approved_by, reason)
    select '00000000-0000-0000-0000-0000000000a1', id, auth.uid(), auth.uid(), 'OTHER'
      from vehicle_assignments limit 1$q$,
    'the schema refuses a self-approved override');
end $$;

select tst.logout();
reset role;
