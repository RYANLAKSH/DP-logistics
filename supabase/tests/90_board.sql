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
