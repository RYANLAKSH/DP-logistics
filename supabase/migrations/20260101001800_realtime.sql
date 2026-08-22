-- ---------------------------------------------------------------------------
-- Realtime.
--
-- Only what a manager must act on the moment it happens: a blocked movement
-- while the truck is still at the ramp, and progress on the board. Driver
-- devices are deliberately NOT subscribed — an always-on socket on forty
-- phones with poor signal produces a reconnect storm, drains battery, and
-- delivers nothing that polling on focus does not.
-- ---------------------------------------------------------------------------

-- Realtime respects RLS only for tables in the publication whose policies
-- actually restrict SELECT. Both of these are default-deny with yard-scoped
-- read policies, so a manager in one yard cannot receive another yard's rows.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    execute 'alter publication supabase_realtime add table public.movement_events';
    execute 'alter publication supabase_realtime add table public.exceptions';
    execute 'alter publication supabase_realtime add table public.vehicle_assignments';
  end if;
exception
  when duplicate_object then null;   -- already published; nothing to do
end $$;

-- Realtime sends the OLD row on updates and deletes only when the table has a
-- replica identity that includes the columns. Default (primary key) is enough
-- here: the client uses an event as a trigger to refetch, never as the truth,
-- so it needs the id and nothing else.

-- ---------------------------------------------------------------------------
-- One call for everything the board shows, so a dashboard refresh is a single
-- round trip rather than five.
-- ---------------------------------------------------------------------------
create or replace function public.yard_board(
  p_yard_id uuid,
  p_date    date default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  mgr    public.profiles;
  v_date date := coalesce(p_date, current_date);
  result jsonb;
begin
  select * into mgr from public.profiles where id = auth.uid();
  if not found or not mgr.is_active then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if not app.user_has_yard(mgr.id, p_yard_id) then
    raise exception 'that yard is outside your scope' using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'yardId', p_yard_id,
    'operatingDate', v_date,
    'counters', (
      select jsonb_build_object(
        'vehiclesScheduled', count(*),
        'vehiclesCompleted', count(*) filter (where va.status = 'COMPLETED'),
        'vehiclesInProgress', count(*) filter (where va.status = 'IN_PROGRESS'),
        'vehiclesException', count(*) filter (where va.status = 'EXCEPTION'),
        'vehiclesPending', count(*) filter (where va.status = 'PENDING'),
        'activeDrivers', count(distinct va.claimed_by)
          filter (where va.status = 'IN_PROGRESS')
      )
      from public.vehicle_assignments va
      join public.manifests m on m.id = va.manifest_id
      where m.yard_id = p_yard_id and m.operating_date = v_date
        and m.status = 'PUBLISHED' and va.status <> 'CANCELLED'
    ),
    'containers', (
      select coalesce(jsonb_agg(c order by c.container_no), '[]'::jsonb)
      from (
        select ct.container_no,
               ct.bay_position,
               ct.expected_vehicle_count as capacity,
               count(me.id) filter (where me.status in ('COMPLETED','OVERRIDDEN')) as filled
        from public.containers ct
        join public.manifests m on m.id = ct.manifest_id
        left join public.vehicle_assignments va
               on va.container_id = ct.id and va.status <> 'CANCELLED'
        left join public.movement_events me on me.assignment_id = va.id
        where m.yard_id = p_yard_id and m.operating_date = v_date and m.status = 'PUBLISHED'
        group by ct.id, ct.container_no, ct.bay_position, ct.expected_vehicle_count
      ) c
    ),
    'openExceptions', (
      select count(*) from public.exceptions x
       where x.yard_id = p_yard_id and x.status in ('OPEN', 'UNDER_REVIEW')
    ),
    'activity', (
      select coalesce(jsonb_agg(a order by a.occurred_at desc), '[]'::jsonb)
      from (
        select me.id, 'MOVEMENT' as kind, me.verified_at as occurred_at,
               p.full_name as actor_name, me.expected_container_no as container_no,
               me.expected_chassis_no as chassis_no, me.status::text as detail,
               null::text as exception_type
          from public.movement_events me
          left join public.profiles p on p.id = me.driver_id
         where me.yard_id = p_yard_id
         order by me.verified_at desc limit 30
      ) a
    ),
    'exceptionFeed', (
      select coalesce(jsonb_agg(e order by e.occurred_at desc), '[]'::jsonb)
      from (
        select x.id, 'EXCEPTION' as kind, x.raised_at as occurred_at,
               p.full_name as actor_name,
               split_part(coalesce(x.expected_value, ' / '), ' / ', 1) as container_no,
               split_part(coalesce(x.expected_value, ' / '), ' / ', 2) as chassis_no,
               coalesce(x.description, x.type::text) as detail,
               x.type::text as exception_type
          from public.exceptions x
          left join public.profiles p on p.id = x.raised_by
         where x.yard_id = p_yard_id
         order by x.raised_at desc limit 30
      ) e
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.yard_board(uuid, date) from public;
grant execute on function public.yard_board(uuid, date) to authenticated;
