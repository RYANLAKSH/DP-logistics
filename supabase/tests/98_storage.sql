-- ---------------------------------------------------------------------------
-- Private image access.
--
-- The photographs are the evidence. If any authenticated user can read any
-- object, the audit trail is a public album of other people's yards, and the
-- product's central claim — that a movement can be proved — becomes a claim
-- that a movement can be alleged.
--
-- These are the storage policies themselves, not the app's use of them. RLS is
-- enabled on storage.objects in the shim for exactly this reason.
-- ---------------------------------------------------------------------------
do $$
declare
  own_path   text;
  other_yard text;
  n          int;
begin
  set local role authenticated;

  -- The server builds every path; the client never proposes one. Ask for one
  -- as the driver who owns the work.
  perform tst.login('00000000-0000-0000-0000-0000000000c3');
  own_path := create_evidence_upload_path(
    tst.assignment_id('MAT464844TSR09113'), 'CHASSIS', gen_random_uuid());

  -- A path in the same org but the yard this driver does not work.
  other_yard := '00000000-0000-0000-0000-0000000000a1/'
             || '00000000-0000-0000-0000-0000000000b2/'
             || current_date || '/' || gen_random_uuid() || '/CHASSIS-x.jpg';

  -- ------------------------------------------------- writing
  insert into storage.objects (bucket_id, name, owner)
  values ('evidence', own_path, auth.uid());
  perform tst.rowcount(
    format('select 1 from storage.objects where name = %L', own_path),
    1, 'a driver can file evidence for their own yard');

  perform tst.throws(format(
    'insert into storage.objects (bucket_id, name, owner) values (''evidence'', %L, auth.uid())',
    other_yard), 'a driver cannot file evidence into a yard they do not work');

  -- Evidence is immutable. Retention purging runs as the service role, from a
  -- scheduled job, not from anything holding a driver's token.
  --
  -- Asserted by outcome rather than by exception, because that is how RLS
  -- actually behaves: an INSERT with no policy raises, but an UPDATE or DELETE
  -- with no policy quietly matches nothing and reports success. A test that
  -- expected a raise here would fail on correct code, and — worse — a
  -- developer who "fixed" it by adding an UPDATE policy would make it pass.
  execute format('update storage.objects set name = ''tampered.jpg'' where name = %L', own_path);
  perform tst.rowcount(format('select 1 from storage.objects where name = %L', own_path),
                       1, 'an update touches no photograph');
  execute format('delete from storage.objects where name = %L', own_path);
  perform tst.rowcount(format('select 1 from storage.objects where name = %L', own_path),
                       1, 'a delete removes no photograph');
  perform tst.logout();

  -- And the row really is still there, not merely invisible to the driver.
  set local role postgres;
  select count(*) into n from storage.objects where name = own_path;
  perform tst.eq(n, 1, 'the photograph survives both attempts');
  set local role authenticated;

  -- ------------------------------------------------- reading
  perform tst.login('00000000-0000-0000-0000-0000000000c3');
  perform tst.rowcount(format('select 1 from storage.objects where name = %L', own_path),
                       1, 'the driver who took the photograph can see it');
  perform tst.logout();

  -- The manager of that yard can see it: this is the whole point of an audit
  -- trail, and it is scoped to their yard rather than to everything.
  perform tst.login('00000000-0000-0000-0000-0000000000c2');
  perform tst.rowcount(format('select 1 from storage.objects where name = %L', own_path),
                       1, 'the yard manager can open the evidence');
  perform tst.logout();

  -- A manager of a DIFFERENT yard in the same company cannot.
  perform tst.login('00000000-0000-0000-0000-0000000000c5');
  perform tst.rowcount(format('select 1 from storage.objects where name = %L', own_path),
                       0, 'a manager of another yard cannot open it');
  perform tst.logout();

  -- An admin of a different ORGANISATION cannot, whatever their role name says.
  perform tst.login('00000000-0000-0000-0000-0000000000c6');
  perform tst.rowcount(format('select 1 from storage.objects where name = %L', own_path),
                       0, 'another company''s admin cannot open it');
  perform tst.logout();

  -- And with no session at all, nothing is visible. A private bucket that
  -- answers to anon is a public bucket with extra steps.
  set local role anon;
  -- Refused at the grant, before RLS is even consulted. Two independent
  -- reasons an anonymous request cannot read a photograph is the right number.
  perform tst.throws('select count(*) from storage.objects',
                     'anonymous cannot read the evidence bucket at all');
  set local role authenticated;

  -- ------------------------------------------------- manifests bucket
  -- Source files carry the whole day's plan. Drivers have no business in them.
  perform tst.login('00000000-0000-0000-0000-0000000000c3');
  perform tst.throws(format(
    'insert into storage.objects (bucket_id, name, owner) values (''manifests'', %L, auth.uid())',
    '00000000-0000-0000-0000-0000000000a1/00000000-0000-0000-0000-0000000000b1/'
      || current_date || '/abc.csv'),
    'a driver cannot upload a manifest');
  perform tst.logout();

  -- ------------------------------------------------- the bucket itself
  perform tst.login('00000000-0000-0000-0000-0000000000c2');
  select count(*) into n from storage.buckets where public;
  perform tst.eq(n, 0, 'no bucket is public');
  perform tst.logout();

  raise notice '98_storage: ok';
end $$;
