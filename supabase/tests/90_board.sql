-- The board RPC: one round trip, yard-scoped, and refused outside scope.
set role authenticated;

select tst.login('00000000-0000-0000-0000-0000000000c2');   -- manager, Nhava Sheva
do $$
declare b jsonb := yard_board('00000000-0000-0000-0000-0000000000b1', current_date);
begin
  perform tst.ok(b is not null, 'the board returns');
  perform tst.ok((b -> 'counters' ->> 'vehiclesScheduled')::int > 0,
                 'it counts scheduled vehicles');
  perform tst.ok(jsonb_array_length(b -> 'containers') > 0, 'it lists containers');
  perform tst.ok((b -> 'containers' -> 0 ? 'capacity'),
                 'each container reports its capacity');
  perform tst.ok((b -> 'containers' -> 0 ? 'filled'),
                 'and how many vehicles are in it');
  perform tst.ok((b ->> 'openExceptions')::int >= 0, 'it counts open exceptions');
  perform tst.ok(b ? 'activity', 'it carries the movement feed');
  perform tst.ok(b ? 'exceptionFeed', 'and the exception feed');

  -- Completed + pending + in progress + exception must account for everything.
  perform tst.eq(
    (b -> 'counters' ->> 'vehiclesCompleted')::int
      + (b -> 'counters' ->> 'vehiclesPending')::int
      + (b -> 'counters' ->> 'vehiclesInProgress')::int
      + (b -> 'counters' ->> 'vehiclesException')::int,
    (b -> 'counters' ->> 'vehiclesScheduled')::int,
    'the counters partition the scheduled vehicles with nothing lost');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c5');   -- manager, Mundra
do $$
begin
  perform tst.throws(
    'select yard_board(''00000000-0000-0000-0000-0000000000b1'')',
    'a manager cannot read a board for a yard they do not run');
end $$;

select tst.login('00000000-0000-0000-0000-0000000000c6');   -- another organisation
do $$
begin
  perform tst.throws(
    'select yard_board(''00000000-0000-0000-0000-0000000000b1'')',
    'another organisation cannot read the board at all');
end $$;

select tst.logout();
do $$
begin
  perform tst.throws(
    'select yard_board(''00000000-0000-0000-0000-0000000000b1'')',
    'an unauthenticated caller cannot read the board');
end $$;
reset role;

-- Realtime must never carry a table whose SELECT is unrestricted, or a
-- subscriber would receive rows RLS would refuse to a query.
do $$
declare t record;
begin
  for t in
    select c.relname
      from pg_publication_tables pt
      join pg_class c on c.relname = pt.tablename
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = pt.schemaname
     where pt.pubname = 'supabase_realtime' and pt.schemaname = 'public'
  loop
    perform tst.ok(
      (select relrowsecurity from pg_class where relname = t.relname),
      format('published table %s must have RLS enabled', t.relname));
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- v_yard_dashboard is grouped by (yard_id, operating_date): a yard gets a new
-- row every day it operates, and a past day's manifest is never archived —
-- only same-day republishing archives the prior version. The client query
-- behind getDashboard() filters by yard_id alone with .maybeSingle(), which
-- throws PGRST116 the moment more than one row comes back. This proves the
-- exact failure and the exact fix: filtering by yard AND operating_date keeps
-- it single-row even once a second day of history exists.
-- ---------------------------------------------------------------------------
select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
declare
  v_yard   uuid := '00000000-0000-0000-0000-0000000000b1';
  v_import uuid := gen_random_uuid();
  n        int;
begin
  -- A second day's manifest for the same yard, published the ordinary way.
  insert into manifest_imports (
    id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
    file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
  ) values (
    v_import,
    '00000000-0000-0000-0000-0000000000a1', v_yard,
    current_date - 1, 'manifest-yesterday.csv',
    '00000000-0000-0000-0000-0000000000a1/' || v_yard || '/y/yesterday.csv',
    repeat('c', 64), 512, 'READY', 2, 2, 0,
    '00000000-0000-0000-0000-0000000000c2',
    '[{"row_no":1,"container_no":"TGCU5033177","chassis_no":"MAT900009A0A00009","sequence_no":1},
      {"row_no":2,"container_no":"TGCU5033177","chassis_no":"MAT900009A0A00010","sequence_no":2}]'::jsonb
  );
  perform publish_manifest_from_import(v_import, 'REF-YDAY');

  -- Confirms the scenario is real: more than one PUBLISHED manifest for this
  -- yard, on different days — which is exactly what v_yard_dashboard groups
  -- by. The exact count varies with which other suites ran first in this
  -- shared database; what matters is that it is more than one.
  select count(*) into n from manifests
   where yard_id = v_yard and status = 'PUBLISHED';
  perform tst.ok(n >= 2, 'the yard now has more than one day of published history');

  select count(*) into n from v_yard_dashboard where yard_id = v_yard;
  perform tst.eq(n,
    (select count(*) from manifests where yard_id = v_yard and status = 'PUBLISHED')::int,
    'the dashboard view has exactly one row per published day, as designed');
  perform tst.ok(n > 1, 'and there is more than one — the ambiguity is real');

  -- The query getDashboard() actually runs: yard AND today. Exactly one row.
  select count(*) into n from v_yard_dashboard
   where yard_id = v_yard and operating_date = current_date;
  perform tst.eq(n, 1,
    'scoped to yard and today, the row getDashboard() reads is unambiguous');

  raise notice '90_board multi-day dashboard: ok';
end $$;
select tst.logout();
reset role;
