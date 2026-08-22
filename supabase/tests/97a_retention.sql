-- ---------------------------------------------------------------------------
-- Data retention: what it removes, and what it must never remove.
-- ---------------------------------------------------------------------------
do $$
declare
  v_att uuid;
  v_org uuid := '00000000-0000-0000-0000-0000000000a1';
  r     record;
  n     int;
begin
  -- An attempt from three years ago, with both photographs, under a two-year
  -- policy. Written as the owner: this is a fixture, not a user action.
  v_att := gen_random_uuid();
  insert into verification_attempts (
    id, org_id, yard_id, manifest_id, assignment_id, driver_id, kind, result,
    expected_container_no, expected_chassis_no,
    container_image_path, container_image_sha256,
    chassis_image_path, chassis_image_sha256,
    attempted_at_device, created_at
  )
  select v_att, v_org, m.yard_id, m.id, va.id,
         '00000000-0000-0000-0000-0000000000c3', 'CONTAINER', 'PASS',
         'TRHU8755445', 'MAT752389T7R20588',
         'old/container.jpg', repeat('a', 64),
         'old/chassis.jpg',   repeat('b', 64),
         now() - interval '3 years', now() - interval '3 years'
    from vehicle_assignments va join manifests m on m.id = va.manifest_id
   where m.status = 'PUBLISHED' limit 1;

  insert into storage.objects (bucket_id, name, owner)
  values ('evidence', 'old/container.jpg', '00000000-0000-0000-0000-0000000000c3'),
         ('evidence', 'old/chassis.jpg',   '00000000-0000-0000-0000-0000000000c3');

  -- An admin can see what is due before anyone runs anything.
  set local role authenticated;
  perform tst.login('00000000-0000-0000-0000-0000000000c1');
  select * into r from retention_pending() limit 1;
  perform tst.ok(r.attempts_due >= 1, 'retention reports what is due');
  perform tst.logout();
  reset role;

  -- A driver cannot run the purge. A token in a phone that deletes evidence is
  -- not a retention policy, it is a way to destroy the case against a movement.
  set local role authenticated;
  perform tst.login('00000000-0000-0000-0000-0000000000c3');
  perform tst.throws('select app.purge_expired_evidence()',
                     'a driver cannot purge evidence');
  perform tst.logout();
  perform tst.login('00000000-0000-0000-0000-0000000000c1');
  perform tst.throws('select app.purge_expired_evidence()',
                     'nor can an admin — it is a scheduled service-role job');
  perform tst.logout();
  reset role;

  perform app.purge_expired_evidence();

  -- The photographs are gone from the bucket.
  select count(*) into n from storage.objects
   where name in ('old/container.jpg', 'old/chassis.jpg');
  perform tst.eq(n, 0, 'the expired photographs are removed from storage');

  -- The record of the movement is NOT.
  select * into r from verification_attempts where id = v_att;
  perform tst.ok(r.id is not null, 'the attempt row survives retention');
  perform tst.ok(r.container_image_path is null, 'the image path is cleared');
  perform tst.eq(r.container_image_sha256, repeat('a', 64),
                 'the hash outlives the image, so a later copy can be checked');
  perform tst.eq(r.chassis_image_sha256, repeat('b', 64), 'both hashes survive');
  perform tst.eq(r.expected_chassis_no, 'MAT752389T7R20588',
                 'and which vehicle it was stays answerable for ever');
  perform tst.ok(r.evidence_purged_at is not null, 'the purge is recorded on the row');

  -- Idempotent: running it again changes nothing and raises nothing.
  perform app.purge_expired_evidence();
  select count(*) into n from verification_attempts where id = v_att;
  perform tst.eq(n, 1, 'a second run is a no-op');

  -- And recent evidence is untouched, which is the whole point of a period.
  select count(*) into n from verification_attempts
   where evidence_purged_at is null
     and (container_image_path is not null or chassis_image_path is not null);
  perform tst.ok(n > 0, 'evidence inside the retention period is left alone');

  raise notice '97a_retention: ok';
end $$;
