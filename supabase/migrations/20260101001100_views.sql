-- ---------------------------------------------------------------------------
-- Read models.
--
-- security_invoker = true on EVERY view. Without it a view runs as its owner
-- and silently bypasses the RLS of its underlying tables — a data leak with a
-- friendly name, and the most common RLS mistake in Supabase projects.
-- ---------------------------------------------------------------------------

-- The driver's task queue, in the order they should be worked: container
-- sequence, then slot within the container.
create view v_driver_tasks
with (security_invoker = true) as
select
  va.id                       as assignment_id,
  va.status                   as assignment_status,
  va.chassis_no,
  va.sequence_no,
  va.vehicle_reg_no,
  va.make_model,
  va.colour,
  va.claimed_by,
  c.id                        as container_id,
  c.container_no,
  c.bay_position,
  c.expected_vehicle_count,
  c.sequence_no               as container_sequence,
  m.id                        as manifest_id,
  m.yard_id,
  m.operating_date,
  m.version                   as manifest_version,
  y.name                      as yard_name,
  (select count(*) from movement_events me
     join vehicle_assignments va2 on va2.id = me.assignment_id
    where va2.container_id = c.id
      and me.status in ('COMPLETED', 'OVERRIDDEN'))         as container_filled,
  exists (select 1 from movement_events me2
           where me2.assignment_id = va.id
             and me2.status in ('COMPLETED', 'OVERRIDDEN')) as is_completed
from vehicle_assignments va
join containers c on c.id = va.container_id
join manifests  m on m.id = va.manifest_id
join yards      y on y.id = m.yard_id
where m.status = 'PUBLISHED'
  and va.status <> 'CANCELLED';

-- Container fill state. This is the widget that catches the error no
-- per-movement check can see: a container about to be sealed half-loaded.
create view v_container_progress
with (security_invoker = true) as
select
  c.id                as container_id,
  c.container_no,
  c.bay_position,
  c.expected_vehicle_count,
  m.id                as manifest_id,
  m.yard_id,
  m.operating_date,
  count(va.id)                                              as assigned_count,
  count(me.id) filter (where me.status in ('COMPLETED','OVERRIDDEN')) as moved_count,
  (count(me.id) filter (where me.status in ('COMPLETED','OVERRIDDEN'))
     >= c.expected_vehicle_count)                           as is_complete,
  max(me.verified_at)                                       as last_movement_at
from containers c
join manifests m on m.id = c.manifest_id
left join vehicle_assignments va on va.container_id = c.id and va.status <> 'CANCELLED'
left join movement_events me on me.assignment_id = va.id
where m.status = 'PUBLISHED'
group by c.id, c.container_no, c.bay_position, c.expected_vehicle_count,
         m.id, m.yard_id, m.operating_date;

-- Manager dashboard counters, one row per (yard, operating_date).
create view v_yard_dashboard
with (security_invoker = true) as
select
  m.yard_id,
  m.operating_date,
  m.id                                     as manifest_id,
  m.version                                as manifest_version,
  count(distinct va.id)                    as vehicles_scheduled,
  count(distinct me.assignment_id) filter (where me.status in ('COMPLETED','OVERRIDDEN'))
                                           as vehicles_completed,
  count(distinct va.id) filter (where va.status = 'IN_PROGRESS')
                                           as vehicles_in_progress,
  count(distinct va.id) filter (where va.status = 'EXCEPTION')
                                           as vehicles_exception,
  count(distinct c.id)                     as containers_scheduled,
  count(distinct c.id) filter (where cp.is_complete) as containers_completed,
  count(distinct va.claimed_by) filter (where va.status = 'IN_PROGRESS')
                                           as active_drivers
from manifests m
left join containers c on c.manifest_id = m.id
left join v_container_progress cp on cp.container_id = c.id
left join vehicle_assignments va on va.manifest_id = m.id and va.status <> 'CANCELLED'
left join movement_events me on me.assignment_id = va.id
where m.status = 'PUBLISHED'
group by m.yard_id, m.operating_date, m.id, m.version;

-- The activity feed. Movements and exceptions interleaved, newest first.
create view v_activity_feed
with (security_invoker = true) as
select
  me.id                    as event_id,
  'MOVEMENT'               as event_kind,
  me.yard_id,
  me.verified_at           as occurred_at,
  me.driver_id,
  me.expected_container_no as container_no,
  me.expected_chassis_no   as chassis_no,
  me.status::text          as status,
  null::exception_type     as exception_type,
  null::text               as detail
from movement_events me
union all
select
  ex.id,
  'EXCEPTION',
  ex.yard_id,
  ex.raised_at,
  ex.raised_by,
  split_part(coalesce(ex.expected_value, ' / '), ' / ', 1),
  split_part(coalesce(ex.expected_value, ' / '), ' / ', 2),
  ex.status::text,
  ex.type,
  ex.description
from exceptions ex;

-- End-of-shift sweep: containers that received fewer vehicles than assigned.
create view v_shift_incomplete
with (security_invoker = true) as
select cp.*,
       cp.expected_vehicle_count - cp.moved_count as missing_count
from v_container_progress cp
where cp.moved_count < cp.expected_vehicle_count;

grant select on v_driver_tasks, v_container_progress, v_yard_dashboard,
                v_activity_feed, v_shift_incomplete to authenticated;
