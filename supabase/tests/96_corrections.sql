-- ---------------------------------------------------------------------------
-- Manifest corrections. The highest-risk mutation: changing the source of
-- truth after work has been done against it.
-- ---------------------------------------------------------------------------
reset role;
insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
  file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-00000000e400',
  '00000000-0000-0000-0000-0000000000a1',
  '00000000-0000-0000-0000-0000000000b1',
  current_date + 40, 'corr.csv', 'p/q/corr.csv', repeat('7', 64), 256,
  'READY', 2, 2, 0, '00000000-0000-0000-0000-0000000000c2',
  '[
    {"row_no":1,"container_no":"CULVNSA2699400","chassis_no":"MAT600001D0D00001","sequence_no":1},
    {"row_no":2,"container_no":"CULVNSA2699400","chassis_no":"MAT600002D0D00002","sequence_no":2}
  ]'::jsonb
);
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c2');
select publish_manifest_from_import('00000000-0000-0000-0000-00000000e400', 'CORR-001');

-- ---------------------------- who may correct --------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c3');   -- a driver
do $$
begin
  perform tst.throws(format(
    'select correct_manifest_assignment(''%s'', ''chassis_no'', ''MAT999'', ''driver edit'')',
    tst.assignment_id('MAT600001D0D00001')),
    'a driver cannot correct the manifest');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c5');   -- a manager, wrong yard
do $$
begin
  perform tst.throws(format(
    'select correct_manifest_assignment(''%s'', ''chassis_no'', ''MAT600009D0D00009'', ''not my yard at all'')',
    tst.assignment_id('MAT600001D0D00001')),
    'a manager cannot correct another yard''s manifest');
end $$;

-- ------------------------------ correcting -----------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
declare
  a uuid := tst.assignment_id('MAT600001D0D00001');
  old_manifest uuid := (select manifest_id from vehicle_assignments where id = a);
  r jsonb;
  c manifest_corrections;
begin
  perform tst.throws(format(
    'select correct_manifest_assignment(''%s'', ''chassis_no'', ''MAT600009D0D00009'', ''oops'')', a),
    'a correction needs a substantive reason');

  perform tst.throws(format(
    'select correct_manifest_assignment(''%s'', ''colour'', ''red'', ''changing the colour please'')', a),
    'only the fields that decide a pairing can be corrected');

  perform tst.throws(format(
    'select correct_manifest_assignment(''%s'', ''chassis_no'', ''MAT600001D0D00001'', ''no change at all here'')', a),
    'correcting a value to itself is refused');

  r := correct_manifest_assignment(
    a, 'chassis_no', 'MAT600009D0D00009',
    'Operations sent the wrong chassis; corrected against the loading list');

  perform tst.eq(r ->> 'before', 'MAT600001D0D00001', 'the before value is reported');
  perform tst.eq(r ->> 'after', 'MAT600009D0D00009', 'and the after value');
  perform tst.eq((r ->> 'version')::int, 2, 'it produced version 2');

  -- The old version is intact and archived, not edited.
  perform tst.eq((select status::text from manifests where id = old_manifest), 'ARCHIVED',
                 'the previous version is archived');
  perform tst.eq((select chassis_no from vehicle_assignments
                   where manifest_id = old_manifest and chassis_no = 'MAT600001D0D00001'),
                 'MAT600001D0D00001',
                 'and its rows are untouched — history is never rewritten');

  -- The new version carries the change and everything else unchanged.
  perform tst.eq((select count(*)::int from vehicle_assignments
                   where manifest_id = (r ->> 'manifest_id')::uuid), 2,
                 'the new version has both vehicles');
  perform tst.ok(exists (select 1 from vehicle_assignments
                          where manifest_id = (r ->> 'manifest_id')::uuid
                            and chassis_no = 'MAT600009D0D00009'),
                 'the corrected value is live');
  perform tst.ok(exists (select 1 from vehicle_assignments
                          where manifest_id = (r ->> 'manifest_id')::uuid
                            and chassis_no = 'MAT600002D0D00002'),
                 'the untouched vehicle carried over');

  -- Exactly one published manifest for the day, still.
  perform tst.eq((select count(*)::int from manifests
                   where yard_id = '00000000-0000-0000-0000-0000000000b1'
                     and operating_date = current_date + 40 and status = 'PUBLISHED'), 1,
                 'exactly one version is live');

  select * into c from manifest_corrections where id = (r ->> 'correction_id')::uuid;
  perform tst.eq(c.before_value, 'MAT600001D0D00001', 'the correction records before');
  perform tst.eq(c.after_value, 'MAT600009D0D00009', 'and after');
  perform tst.ok(length(c.reason) >= 10, 'and the reason');
  perform tst.eq(c.corrected_by, auth.uid(), 'and who made it');

  perform tst.ok((select count(*) > 0 from audit_logs where action = 'manifest.corrected'),
                 'the correction is audited');
  perform tst.eq((select before_value ->> 'value' from audit_logs
                   where action = 'manifest.corrected' order by id desc limit 1),
                 'MAT600001D0D00001',
                 'and the audit row carries the before value');
end $$;

-- ------------- correcting something already loaded raises a conflict ---------
do $$
declare
  a uuid := tst.assignment_id('MAT600002D0D00002');
  r jsonb;
begin
  perform set_config('tst.loaded_assignment', a::text, false);
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
declare
  a uuid := current_setting('tst.loaded_assignment')::uuid;
  first_slot uuid := tst.assignment_id('MAT600009D0D00009');
  r jsonb;
begin
  -- Load slot 1, then slot 2, so slot 2 is genuinely completed.
  r := tst.scan_and_verify(first_slot, 'CULVNSA2699400', 'MAT600009D0D00009');
  perform tst.eq(r ->> 'outcome', 'MATCH', 'slot 1 loads');
  r := tst.scan_and_verify(a, 'CULVNSA2699400', 'MAT600002D0D00002');
  perform tst.eq(r ->> 'outcome', 'MATCH', 'slot 2 loads');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
declare
  a uuid := current_setting('tst.loaded_assignment')::uuid;
  exceptions_before int;
  r jsonb;
begin
  select count(*) into exceptions_before from exceptions where type = 'MANIFEST_CONFLICT';

  r := correct_manifest_assignment(
    a, 'chassis_no', 'MAT600022D0D00022',
    'Operations amended after the vehicle had already been loaded');

  perform tst.ok(jsonb_array_length(r -> 'affected_movements') = 1,
                 'the correction reports the completed movement it invalidates');
  perform tst.eq((select count(*)::int from exceptions where type = 'MANIFEST_CONFLICT'),
                 exceptions_before + 1,
                 'and raises a critical exception for a human');

  -- The movement itself stands. A vehicle physically inside a container cannot
  -- be unloaded by a database row.
  perform tst.eq((select count(*)::int from movement_events
                   where assignment_id = a and status = 'COMPLETED'), 1,
                 'the completed movement is not retroactively invalidated');
end $$;

select tst.logout();
reset role;
