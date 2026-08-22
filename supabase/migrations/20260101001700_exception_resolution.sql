-- ---------------------------------------------------------------------------
-- Exception resolution and overrides.
--
-- A driver raises; a manager resolves. The person who hit the block is never
-- the person who clears it, and nothing is ever deleted — resolution appends.
-- ---------------------------------------------------------------------------

create or replace function app.require_manager_for_exception(p_exception_id uuid)
returns public.exceptions
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  mgr public.profiles := app.require_manager();
  x   public.exceptions;
begin
  select * into x from public.exceptions where id = p_exception_id;
  if not found then
    raise exception 'exception not found' using errcode = 'no_data_found';
  end if;
  if x.org_id <> mgr.org_id or not app.user_has_yard(mgr.id, x.yard_id) then
    raise exception 'that exception is outside your yards'
      using errcode = 'insufficient_privilege';
  end if;
  return x;
end;
$$;

create or replace function public.acknowledge_exception(p_exception_id uuid)
returns public.exceptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr public.profiles := app.require_manager();
  x   public.exceptions := app.require_manager_for_exception(p_exception_id);
  updated public.exceptions;
begin
  if x.status <> 'OPEN' then
    raise exception 'only an OPEN exception can be acknowledged (this one is %)', x.status
      using errcode = 'check_violation';
  end if;

  update public.exceptions
     set status = 'UNDER_REVIEW', acknowledged_by = mgr.id, acknowledged_at = now()
   where id = p_exception_id
  returning * into updated;

  perform app.audit('exception.acknowledged', 'exception', p_exception_id,
    jsonb_build_object('status', x.status),
    jsonb_build_object('status', 'UNDER_REVIEW'),
    null, mgr.org_id, x.yard_id);
  return updated;
end;
$$;

create or replace function public.resolve_exception(
  p_exception_id uuid,
  p_resolution   exception_resolution,
  p_note         text
)
returns public.exceptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr public.profiles := app.require_manager();
  x   public.exceptions := app.require_manager_for_exception(p_exception_id);
  updated public.exceptions;
begin
  if x.status in ('RESOLVED', 'CANCELLED') then
    raise exception 'this exception is already %', x.status using errcode = 'check_violation';
  end if;

  -- An override is not a resolution code someone can simply select. It has to
  -- go through approve_override, which enforces dual control and writes an
  -- overrides row. Allowing it here would leave the same outcome with none of
  -- the constraints.
  if p_resolution = 'OVERRIDE_APPROVED' then
    raise exception 'use approve_override to authorise a movement'
      using errcode = 'check_violation';
  end if;

  if length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'a resolution needs a note explaining what was done'
      using errcode = 'check_violation';
  end if;

  update public.exceptions
     set status = 'RESOLVED', resolution = p_resolution, resolution_note = p_note,
         resolved_by = mgr.id, resolved_at = now(),
         acknowledged_by = coalesce(acknowledged_by, mgr.id),
         acknowledged_at = coalesce(acknowledged_at, now())
   where id = p_exception_id
  returning * into updated;

  -- Releasing the task is an explicit consequence of certain resolutions, not
  -- a side effect of closing a ticket.
  if p_resolution in ('CORRECTED_AND_RESCANNED', 'MANUAL_ENTRY_AUTHORISED',
                      'FALSE_ALARM', 'NO_ACTION_REQUIRED')
     and x.assignment_id is not null then
    update public.vehicle_assignments
       set status = 'PENDING', claimed_by = null, claimed_at = null, updated_at = now()
     where id = x.assignment_id and status = 'EXCEPTION';
  end if;

  if p_resolution = 'VEHICLE_RESCHEDULED' and x.assignment_id is not null then
    update public.vehicle_assignments
       set status = 'CANCELLED', cancelled_at = now(),
           cancel_reason = left(p_note, 500), updated_at = now()
     where id = x.assignment_id and status <> 'COMPLETED';
  end if;

  perform app.audit('exception.resolved', 'exception', p_exception_id,
    jsonb_build_object('status', x.status),
    jsonb_build_object('status', 'RESOLVED', 'resolution', p_resolution, 'note', p_note),
    null, mgr.org_id, x.yard_id);
  return updated;
end;
$$;

create or replace function public.cancel_exception(p_exception_id uuid, p_note text)
returns public.exceptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr public.profiles := app.require_manager();
  x   public.exceptions := app.require_manager_for_exception(p_exception_id);
  updated public.exceptions;
begin
  if length(btrim(coalesce(p_note, ''))) < 5 then
    raise exception 'say why this exception is being cancelled'
      using errcode = 'check_violation';
  end if;

  -- Cancelled, never deleted. An exception raised in error is still part of
  -- what happened, and a queue that can be emptied silently is not a control.
  update public.exceptions
     set status = 'CANCELLED', resolution_note = p_note,
         resolved_by = mgr.id, resolved_at = now()
   where id = p_exception_id
  returning * into updated;

  perform app.audit('exception.cancelled', 'exception', p_exception_id,
    jsonb_build_object('status', x.status),
    jsonb_build_object('status', 'CANCELLED', 'note', p_note),
    null, mgr.org_id, x.yard_id);
  return updated;
end;
$$;

-- ---------------------------------------------------------------------------
-- Overrides: the one operation that defeats the product's core control, and
-- therefore the most constrained.
-- ---------------------------------------------------------------------------

create or replace function public.request_override(p_exception_id uuid, p_note text)
returns public.exceptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  drv public.profiles := app.require_driver();
  x   public.exceptions;
  updated public.exceptions;
begin
  select * into x from public.exceptions where id = p_exception_id;
  if not found then
    raise exception 'exception not found' using errcode = 'no_data_found';
  end if;
  if x.raised_by <> drv.id then
    raise exception 'you can only request an override on your own exception'
      using errcode = 'insufficient_privilege';
  end if;
  if x.status in ('RESOLVED', 'CANCELLED') then
    raise exception 'this exception is already %', x.status using errcode = 'check_violation';
  end if;

  update public.exceptions
     set override_requested = true,
         description = coalesce(description, '') ||
           case when p_note is null then '' else E'\nDriver: ' || p_note end
   where id = p_exception_id
  returning * into updated;

  perform app.audit('override.requested', 'exception', p_exception_id, null,
    jsonb_build_object('note', p_note), null, drv.org_id, x.yard_id);
  return updated;
end;
$$;

create or replace function public.approve_override(
  p_exception_id uuid,
  p_reason       override_reason,
  p_note         text,
  p_movement_id  uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr public.profiles := app.require_manager();
  x   public.exceptions := app.require_manager_for_exception(p_exception_id);
  a   public.vehicle_assignments;
  c   public.containers;
  m   public.manifests;
  att public.verification_attempts;
  o   public.overrides;
  mv  public.movement_events;
  v_movement_id uuid := coalesce(p_movement_id, public.gen_random_uuid());
begin
  if x.assignment_id is null then
    raise exception 'this exception is not attached to an assignment'
      using errcode = 'check_violation';
  end if;
  if x.status in ('RESOLVED', 'CANCELLED') then
    raise exception 'this exception is already %', x.status using errcode = 'check_violation';
  end if;
  if x.raised_by is null then
    raise exception 'this exception has no requester to approve against'
      using errcode = 'check_violation';
  end if;
  -- Dual control. Also a CHECK constraint on overrides, because a control that
  -- lives only in application code survives until someone writes a script.
  if x.raised_by = mgr.id then
    raise exception 'you cannot approve an override you requested yourself'
      using errcode = 'insufficient_privilege';
  end if;
  if p_reason = 'OTHER' and length(btrim(coalesce(p_note, ''))) < 10 then
    raise exception 'OTHER requires an explanation' using errcode = 'check_violation';
  end if;

  select * into a from public.vehicle_assignments where id = x.assignment_id for update;
  select * into c from public.containers where id = a.container_id for update;
  select * into m from public.manifests where id = a.manifest_id;

  if exists (select 1 from public.movement_events me
              where me.assignment_id = a.id
                and me.status in ('COMPLETED', 'OVERRIDDEN')) then
    raise exception 'this vehicle has already been moved' using errcode = 'check_violation';
  end if;

  -- The blocked attempt this override is authorising. Its scanned values are
  -- what actually gets recorded: an override does not rewrite what happened,
  -- it authorises it.
  select * into att from public.verification_attempts
   where assignment_id = a.id and kind = 'FINAL'
   order by created_at desc limit 1;

  insert into public.overrides (
    org_id, assignment_id, exception_id, requested_by, approved_by, reason, reason_note
  ) values (
    mgr.org_id, a.id, x.id, x.raised_by, mgr.id, p_reason, p_note
  ) returning * into o;

  insert into public.movement_events (
    id, org_id, yard_id, manifest_id, container_id, assignment_id,
    driver_id, status, override_id,
    expected_container_no, expected_chassis_no,
    scanned_container_no, scanned_chassis_no,
    container_attempt_id, chassis_attempt_id, final_attempt_id,
    completed_at_device
  ) values (
    v_movement_id, mgr.org_id, m.yard_id, m.id, c.id, a.id,
    x.raised_by, 'OVERRIDDEN', o.id,
    app.normalize_code(c.container_no), app.normalize_code(a.chassis_no),
    coalesce(att.scanned_container_no, app.normalize_code(c.container_no)),
    coalesce(att.scanned_chassis_no, app.normalize_code(a.chassis_no)),
    att.id, att.id, att.id,
    now()
  ) returning * into mv;

  update public.vehicle_assignments
     set status = 'COMPLETED', updated_at = now()
   where id = a.id;

  update public.exceptions
     set status = 'RESOLVED', resolution = 'OVERRIDE_APPROVED',
         resolution_note = p_note, resolved_by = mgr.id, resolved_at = now(),
         acknowledged_by = coalesce(acknowledged_by, mgr.id),
         acknowledged_at = coalesce(acknowledged_at, now()),
         movement_id = mv.id
   where id = x.id;

  perform app.audit('override.approved', 'movement_event', mv.id, null,
    jsonb_build_object('exception_id', x.id, 'assignment_id', a.id,
                       'reason', p_reason, 'note', p_note,
                       'requested_by', x.raised_by, 'approved_by', mgr.id),
    null, mgr.org_id, m.yard_id);

  return jsonb_build_object(
    'movement_id', mv.id,
    'override_id', o.id,
    'status', 'OVERRIDDEN',
    'exception_id', x.id
  );
end;
$$;

-- Override rates, for the dashboard. A rising rate has exactly two causes —
-- bad manifest data or process abuse — and both need a human to look. The
-- number being on a screen is what makes anyone look.
create view v_override_rates
with (security_invoker = true) as
select
  m.yard_id,
  m.operating_date,
  o.approved_by,
  o.requested_by,
  count(*)                                    as override_count,
  (select count(*) from movement_events me
    where me.yard_id = m.yard_id
      and me.verified_at::date = m.operating_date) as movement_count
from overrides o
join vehicle_assignments va on va.id = o.assignment_id
join manifests m on m.id = va.manifest_id
group by m.yard_id, m.operating_date, o.approved_by, o.requested_by;

grant select on v_override_rates to authenticated;

revoke all on function public.acknowledge_exception(uuid) from public;
revoke all on function public.resolve_exception(uuid, exception_resolution, text) from public;
revoke all on function public.cancel_exception(uuid, text) from public;
revoke all on function public.request_override(uuid, text) from public;
revoke all on function public.approve_override(uuid, override_reason, text, uuid) from public;

grant execute on function public.acknowledge_exception(uuid) to authenticated;
grant execute on function public.resolve_exception(uuid, exception_resolution, text) to authenticated;
grant execute on function public.cancel_exception(uuid, text) to authenticated;
grant execute on function public.request_override(uuid, text) to authenticated;
grant execute on function public.approve_override(uuid, override_reason, text, uuid) to authenticated;
