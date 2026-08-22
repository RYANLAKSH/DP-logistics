-- Authentication and administration RPCs.
set role authenticated;

-- ------------------------------- me() --------------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c3');   -- driver1
do $$
declare m jsonb := me();
begin
  perform tst.eq(m ->> 'role', 'DRIVER', 'me() reports the caller''s role');
  perform tst.eq(m ->> 'fullName', 'Dev Driver', 'me() reports the caller''s name');
  perform tst.eq(jsonb_array_length(m -> 'yards'), 1, 'a driver sees only assigned yards');
  perform tst.eq(m -> 'yards' -> 0 ->> 'code', 'NSA', 'the right yard');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c1');   -- admin
do $$
declare m jsonb := me();
begin
  perform tst.eq(m ->> 'role', 'ADMIN', 'admin role');
  perform tst.eq(jsonb_array_length(m -> 'yards'), 2,
                 'an ADMIN is organisation-wide, so both yards');
end $$;

select tst.logout();
do $$
begin
  perform tst.ok(me() is null, 'me() is null with no session');
end $$;

-- --------------------------- role administration ----------------------------
select tst.login('00000000-0000-0000-0000-0000000000c2');   -- a MANAGER
do $$
begin
  perform tst.throws(
    'select admin_set_role(''00000000-0000-0000-0000-0000000000c3'', ''ADMIN'')',
    'a manager cannot change roles');
  perform tst.throws(
    'select admin_create_profile(gen_random_uuid(), ''ADMIN'', ''Sneaky'')',
    'a manager cannot create a profile');
  perform tst.throws(
    'select admin_deactivate_user(''00000000-0000-0000-0000-0000000000c3'', ''because'')',
    'a manager cannot deactivate a user');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c3');   -- a DRIVER
do $$
begin
  perform tst.throws(
    'select admin_set_role(auth.uid(), ''ADMIN'')',
    'a driver cannot promote themselves');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c1');   -- ADMIN
do $$
declare p profiles;
begin
  perform tst.throws(
    'select admin_deactivate_user(auth.uid(), ''oops'')',
    'an admin cannot deactivate themselves');

  perform tst.throws(
    'select admin_set_role(''00000000-0000-0000-0000-0000000000c6'', ''DRIVER'')',
    'an admin cannot touch another organisation''s user');

  -- The last-admin guard: this org has exactly one ADMIN.
  perform tst.throws(
    'select admin_set_role(auth.uid(), ''MANAGER'')',
    'the last active ADMIN cannot be demoted');

  p := admin_set_role('00000000-0000-0000-0000-0000000000c4', 'MANAGER');
  perform tst.eq(p.role::text, 'MANAGER', 'an admin can change a role');
  perform tst.ok((select count(*) > 0 from audit_logs where action = 'user.role_changed'),
                 'a role change is audited');
  perform tst.eq((select (before_value ->> 'role') from audit_logs
                   where action = 'user.role_changed' order by id desc limit 1),
                 'DRIVER', 'the audit row keeps the before value');

  -- Put it back so later assertions see the fixture as built.
  perform admin_set_role('00000000-0000-0000-0000-0000000000c4', 'DRIVER');
end $$;

-- ------------------------- deactivation revokes devices ---------------------
do $$
begin
  perform admin_deactivate_user('00000000-0000-0000-0000-0000000000c4', 'left the company');
  perform tst.eq((select is_active from profiles
                   where id = '00000000-0000-0000-0000-0000000000c4'), false,
                 'the user is deactivated');
  perform tst.ok((select bool_and(status = 'REVOKED') from devices
                   where user_id = '00000000-0000-0000-0000-0000000000c4'),
                 'every device the user held is revoked in the same transaction');
end $$;

-- A deactivated user has an identity but no authorisation.
select tst.login('00000000-0000-0000-0000-0000000000c4');
do $$
begin
  perform tst.ok(me() is null, 'a deactivated user resolves to no profile');
  perform tst.rowcount('select * from v_driver_tasks', 0,
                       'a deactivated user sees no tasks');
  perform tst.throws(
    'select claim_assignment((select id from vehicle_assignments limit 1))',
    'a deactivated user cannot claim work');
end $$;

select tst.logout();
reset role;

-- ---------------------------- raising exceptions ----------------------------
set role authenticated;
select tst.login('00000000-0000-0000-0000-0000000000c3');   -- driver1
do $$
declare e exceptions;
begin
  -- MAT464844TSR09257 is the one the earlier suite left uncompleted.
  e := raise_exception('DAMAGED_CONTAINER_MARKING', 'Plate painted over',
                       tst.assignment_id('MAT464844TSR09257'));
  perform tst.eq(e.status::text, 'OPEN', 'a raised exception starts OPEN');
  perform tst.eq(e.raised_by, auth.uid(), 'the raiser is taken from the session');
  perform tst.eq((select status::text from vehicle_assignments
                   where id = tst.assignment_id('MAT464844TSR09257')),
                 'EXCEPTION', 'the assignment is parked, not completed');

  -- Raising one against an already-completed assignment must not undo it.
  perform raise_exception('OTHER', 'raised after the fact',
                          tst.assignment_id('MAT752389T7R20588'));
  perform tst.eq((select status::text from vehicle_assignments
                   where id = tst.assignment_id('MAT752389T7R20588')),
                 'COMPLETED', 'a completed movement is never reopened by an exception');

  perform tst.throws(
    'select raise_exception(''OTHER'', ''x'')',
    'OTHER without a description is refused');
end $$;

-- A driver cannot resolve what they raised.
do $$
begin
  perform tst.throws(
    'update exceptions set status = ''RESOLVED''',
    'a driver cannot resolve an exception');
end $$;

select tst.logout();
reset role;
