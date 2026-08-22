-- ---------------------------------------------------------------------------
-- The evidence chain: who can see a photograph, and what viewing one records.
-- ---------------------------------------------------------------------------
set role authenticated;

-- The driver who made the movement.
select tst.login('00000000-0000-0000-0000-0000000000c3');
do $$
declare
  mv uuid := (select id from movement_events where status = 'COMPLETED'
               order by verified_at limit 1);
  e  jsonb;
begin
  e := movement_evidence(mv);
  perform tst.ok(e is not null, 'the driver can see their own movement');
  perform tst.ok((e -> 'movement' ->> 'expectedContainerNo') is not null,
                 'it carries what was expected');
  perform tst.ok((e -> 'movement' ->> 'scannedChassisNo') is not null,
                 'and what was scanned');
  perform tst.ok(jsonb_array_length(e -> 'attempts') > 0, 'and the attempts');

  -- The properties that make the evidence defensible.
  perform tst.ok(
    exists (select 1 from jsonb_array_elements(e -> 'attempts') a
             where a ->> 'imageSha256' is not null),
    'each captured attempt carries a content hash');
  perform tst.ok(
    exists (select 1 from jsonb_array_elements(e -> 'attempts') a
             where a ->> 'ocrTextRaw' is not null),
    'the raw engine output is retained, not just the confirmed value');
  perform tst.ok(
    exists (select 1 from jsonb_array_elements(e -> 'attempts') a
             where a ->> 'valueSource' is not null),
    'how each value was obtained is recorded');
  perform tst.ok((e -> 'movement' ? 'clockSkewSeconds'),
                 'device/server clock skew is exposed to the viewer');
end $$;

-- A different driver.
select tst.login('00000000-0000-0000-0000-0000000000c4');
do $$
declare mv uuid := (select id from movement_events where status = 'COMPLETED'
                     order by verified_at limit 1);
begin
  perform tst.throws(format('select movement_evidence(''%s'')', mv),
                     'a driver cannot open another driver''s evidence');
end $$;

-- A manager in another yard.
select tst.login('00000000-0000-0000-0000-0000000000c5');
do $$
declare mv uuid := (select id from movement_events where status = 'COMPLETED'
                     order by verified_at limit 1);
begin
  perform tst.throws(format('select movement_evidence(''%s'')', mv),
                     'a manager cannot open evidence from another yard');
end $$;

-- Another organisation entirely.
select tst.login('00000000-0000-0000-0000-0000000000c6');
do $$
declare mv uuid := (select id from movement_events where status = 'COMPLETED'
                     order by verified_at limit 1);
begin
  perform tst.throws(format('select movement_evidence(''%s'')', mv),
                     'another organisation cannot open it at all');
end $$;

-- The yard's own manager can, and the view is logged.
select tst.login('00000000-0000-0000-0000-0000000000c2');
do $$
declare
  mv uuid := (select id from movement_events where status = 'COMPLETED'
               order by verified_at limit 1);
  before_count int;
  e jsonb;
begin
  select count(*) into before_count from audit_logs where action = 'evidence.viewed';
  e := movement_evidence(mv);
  perform tst.ok(e is not null, 'the yard manager can open it');
  perform tst.eq((select count(*)::int from audit_logs where action = 'evidence.viewed'),
                 before_count + 1,
                 'every view is written to the audit log — chain of custody');
end $$;

select tst.logout();
reset role;

-- Nobody, at any level, holds a grant that could delete or alter an image
-- record. Evidence is immutable; retention purging runs as the service role.
do $$
begin
  perform tst.ok(
    not exists (
      select 1 from information_schema.role_table_grants
       where table_name = 'verification_attempts'
         and grantee in ('anon', 'authenticated')
         and privilege_type in ('UPDATE', 'DELETE', 'INSERT')),
    'clients hold no write grant on verification_attempts');
  perform tst.ok(
    not exists (
      select 1 from information_schema.role_table_grants
       where table_name = 'movement_events'
         and grantee in ('anon', 'authenticated')
         and privilege_type in ('UPDATE', 'DELETE', 'INSERT')),
    'clients hold no write grant on movement_events');
end $$;
