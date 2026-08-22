-- Schema-level business rules. Each of these must be impossible, not merely
-- discouraged by application code.
do $$
declare
  v_manifest uuid;
  v_container uuid;
begin
  select id into v_manifest from manifests
   where yard_id = '00000000-0000-0000-0000-0000000000b1' and status = 'PUBLISHED';
  select id into v_container from containers
   where manifest_id = v_manifest and container_no = 'TRHU8755445';

  perform tst.ok(v_manifest is not null, 'fixture manifest published');
  perform tst.eq((select expected_vehicle_count from containers where id = v_container), 2,
                 'container capacity derived from the manifest is 2');
  perform tst.eq((select count(*)::int from vehicle_assignments where container_id = v_container), 2,
                 'container has two vehicle assignments');

  -- A chassis may not be assigned to two active containers in one manifest.
  perform tst.throws(format($q$
      insert into vehicle_assignments (manifest_id, container_id, chassis_no, sequence_no)
      values ('%s', '%s', 'MAT752389T7R18439', 3)$q$, v_manifest, v_container),
    'duplicate chassis within a manifest must be rejected');

  -- Two vehicles may not occupy the same slot.
  perform tst.throws(format($q$
      insert into vehicle_assignments (manifest_id, container_id, chassis_no, sequence_no)
      values ('%s', '%s', 'MAT999999Z9Z99999', 1)$q$, v_manifest, v_container),
    'duplicate slot within a container must be rejected');

  -- The same container may not appear twice in one manifest.
  perform tst.throws(format($q$
      insert into containers (manifest_id, container_no) values ('%s', 'TRHU8755445')$q$,
      v_manifest),
    'duplicate container within a manifest must be rejected');

  -- At most one PUBLISHED manifest per yard per operating day.
  perform tst.throws(format($q$
      insert into manifests (org_id, yard_id, operating_date, version, status, created_by,
                             published_by, published_at)
      values ('00000000-0000-0000-0000-0000000000a1',
              '00000000-0000-0000-0000-0000000000b1', current_date, 99, 'PUBLISHED',
              '00000000-0000-0000-0000-0000000000c2',
              '00000000-0000-0000-0000-0000000000c2', now())$q$),
    'a second PUBLISHED manifest for the same yard and day must be rejected');

  -- Capacity is bounded.
  perform tst.throws(format($q$
      insert into containers (manifest_id, container_no, expected_vehicle_count)
      values ('%s', 'CULVNSA9999999', 99)$q$, v_manifest),
    'absurd container capacity must be rejected');

  -- Overrides require two different people.
  perform tst.throws($q$
      insert into overrides (org_id, assignment_id, requested_by, approved_by, reason)
      select '00000000-0000-0000-0000-0000000000a1', id,
             '00000000-0000-0000-0000-0000000000c3',
             '00000000-0000-0000-0000-0000000000c3', 'MANIFEST_ERROR'
        from vehicle_assignments limit 1$q$,
    'an override approved by its own requester must be rejected');

  -- A correction must carry a substantive reason.
  perform tst.throws(format($q$
      insert into manifest_corrections (org_id, from_manifest_id, field_name,
                                        before_value, after_value, reason, corrected_by)
      values ('00000000-0000-0000-0000-0000000000a1', '%s', 'chassis_no', 'A', 'B', 'oops',
              '00000000-0000-0000-0000-0000000000c2')$q$, v_manifest),
    'a correction with a token reason must be rejected');
end $$;

-- The audit log is append-only, enforced by trigger as well as by grant.
do $$
begin
  perform tst.ok((select count(*) from audit_logs) > 0, 'publishing wrote audit rows');
  perform tst.throws('update audit_logs set action = ''tampered''',
                     'UPDATE on audit_logs must raise');
  perform tst.throws('delete from audit_logs', 'DELETE on audit_logs must raise');

  -- Every row after the first links to its predecessor. coalesce, because
  -- bool_and over an empty set is NULL, not true.
  perform tst.ok(
    coalesce((select bool_and(prev_hash is not null) from audit_logs
               where id > (select min(id) from audit_logs)), true),
    'every audit row after the first carries the previous hash');
end $$;

-- The chain verifier finds no break in a untampered log.
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c1');
do $$
begin
  perform tst.rowcount('select * from verify_audit_chain(0)', 0,
                       'an untampered audit chain reports no breaks');
end $$;
select tst.logout();
reset role;
