-- ---------------------------------------------------------------------------
-- End-of-shift reconciliation.
--
-- The error no per-movement check can catch: a container that received one
-- vehicle instead of two, sealed and shipped. Every individual scan passed.
-- Only the aggregate reveals it, and only if somebody looks — so this exists
-- to make somebody look.
-- ---------------------------------------------------------------------------

create or replace function public.shift_report(
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
  viewer public.profiles;
  v_date date := coalesce(p_date, current_date);
  result jsonb;
begin
  select * into viewer from public.profiles where id = auth.uid();
  if not found or not viewer.is_active then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  if viewer.role not in ('MANAGER', 'ADMIN') then
    raise exception 'the shift report is a manager''s view'
      using errcode = 'insufficient_privilege';
  end if;
  if not app.user_has_yard(viewer.id, p_yard_id) then
    raise exception 'that yard is outside your scope' using errcode = 'insufficient_privilege';
  end if;

  select jsonb_build_object(
    'yardId', p_yard_id,
    'operatingDate', v_date,

    -- THE headline. A partially loaded container is a customs and financial
    -- problem, and nothing in the scan flow can see it.
    'partiallyLoaded', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'containerNo', c.container_no,
               'bayPosition', c.bay_position,
               'expected', c.expected_vehicle_count,
               'loaded', c.loaded,
               'missing', c.missing_chassis) order by c.container_no), '[]'::jsonb)
      from (
        select ct.container_no, ct.bay_position, ct.expected_vehicle_count,
               count(me.id) filter (where me.status in ('COMPLETED','OVERRIDDEN')) as loaded,
               coalesce(jsonb_agg(va.chassis_no) filter (
                 where me.id is null and va.status <> 'CANCELLED'), '[]'::jsonb)
                 as missing_chassis
          from public.containers ct
          join public.manifests m on m.id = ct.manifest_id
          left join public.vehicle_assignments va
                 on va.container_id = ct.id and va.status <> 'CANCELLED'
          left join public.movement_events me
                 on me.assignment_id = va.id
                and me.status in ('COMPLETED','OVERRIDDEN')
         where m.yard_id = p_yard_id and m.operating_date = v_date
           and m.status = 'PUBLISHED'
         group by ct.id, ct.container_no, ct.bay_position, ct.expected_vehicle_count
        having count(me.id) filter (where me.status in ('COMPLETED','OVERRIDDEN'))
               between 1 and ct.expected_vehicle_count - 1
      ) c
    ),

    'notStarted', (
      select count(distinct ct.id)
        from public.containers ct
        join public.manifests m on m.id = ct.manifest_id
        left join public.vehicle_assignments va on va.container_id = ct.id
        left join public.movement_events me on me.assignment_id = va.id
             and me.status in ('COMPLETED','OVERRIDDEN')
       where m.yard_id = p_yard_id and m.operating_date = v_date
         and m.status = 'PUBLISHED'
       group by ct.id having count(me.id) = 0
    ),

    'openExceptions', (
      select count(*) from public.exceptions x
       where x.yard_id = p_yard_id and x.status in ('OPEN','UNDER_REVIEW')
    ),

    'overrides', (
      select jsonb_build_object(
        'count', count(*),
        'ratePercent', case when total.movements = 0 then 0
          else round(100.0 * count(*) / total.movements, 1) end)
      from public.movement_events me2, lateral (
        select count(*) as movements from public.movement_events m3
         where m3.yard_id = p_yard_id and m3.verified_at::date = v_date
      ) total
      where me2.yard_id = p_yard_id and me2.verified_at::date = v_date
        and me2.status = 'OVERRIDDEN'
      group by total.movements
    ),

    -- A movement verified long after the vehicle moved, or a cluster verified
    -- in a burst, is the signature of bulk back-filling from the cab.
    'clockAnomalies', (
      select count(*) from public.movement_events me
       where me.yard_id = p_yard_id and me.verified_at::date = v_date
         and abs(coalesce(me.clock_skew_s, 0)) > 300
    ),

    'manualEntries', (
      select count(*) from public.verification_attempts va
       where va.yard_id = p_yard_id and va.created_at::date = v_date
         and va.value_source in ('MANUAL_ENTRY', 'MANUAL_AUTHORISED')
    ),

    'completed', (
      select count(*) from public.movement_events me
       where me.yard_id = p_yard_id and me.verified_at::date = v_date
         and me.status in ('COMPLETED','OVERRIDDEN')
    )
  ) into result;

  return result;
end;
$$;

revoke all on function public.shift_report(uuid, date) from public;
grant execute on function public.shift_report(uuid, date) to authenticated;
