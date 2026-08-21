-- ---------------------------------------------------------------------------
-- Raising an exception.
--
-- A driver can raise one and can never resolve one: the person who hit the
-- block is not the person who clears it. Resolution arrives in phase 9 and is
-- restricted to MANAGER and ADMIN.
-- ---------------------------------------------------------------------------
create or replace function public.raise_exception(
  p_type          exception_type,
  p_description   text,
  p_assignment_id uuid default null
)
returns public.exceptions
language plpgsql
security definer
set search_path = ''
as $$
declare
  caller public.profiles;
  a      public.vehicle_assignments;
  m      public.manifests;
  v_yard uuid;
  v_manifest uuid;
  created public.exceptions;
begin
  select * into caller from public.profiles where id = auth.uid();
  if not found or not caller.is_active then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  if p_type = 'OTHER' and length(btrim(coalesce(p_description, ''))) < 5 then
    raise exception 'describe the problem when choosing OTHER'
      using errcode = 'check_violation';
  end if;

  if p_assignment_id is not null then
    select * into a from public.vehicle_assignments where id = p_assignment_id;
    if not found then
      raise exception 'assignment not found' using errcode = 'no_data_found';
    end if;
    select * into m from public.manifests where id = a.manifest_id;
    if not app.user_has_yard(caller.id, m.yard_id) then
      raise exception 'assignment is outside your yards'
        using errcode = 'insufficient_privilege';
    end if;
    v_yard := m.yard_id;
    v_manifest := m.id;
  else
    -- No assignment: scope it to the caller's single yard, or refuse if the
    -- caller works several and the exception cannot be placed.
    select uy.yard_id into v_yard from public.user_yards uy
     where uy.user_id = caller.id limit 1;
    if v_yard is null then
      raise exception 'you are not assigned to a yard'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  insert into public.exceptions (
    org_id, yard_id, manifest_id, assignment_id, type, status, severity,
    description, raised_by
  ) values (
    caller.org_id, v_yard, v_manifest, p_assignment_id, p_type, 'OPEN',
    case when p_type in ('WRONG_VEHICLE', 'WRONG_CONTAINER') then 1 else 2 end,
    nullif(btrim(p_description), ''), caller.id
  ) returning * into created;

  -- The task is parked, not failed. It stays visible and stays incomplete.
  if p_assignment_id is not null then
    update public.vehicle_assignments
       set status = 'EXCEPTION', updated_at = now()
     where id = p_assignment_id and status <> 'COMPLETED';
  end if;

  perform app.audit('exception.raised', 'exception', created.id, null,
    jsonb_build_object('type', p_type, 'assignment_id', p_assignment_id),
    null, caller.org_id, v_yard);

  return created;
end;
$$;

revoke all on function public.raise_exception(exception_type, text, uuid) from public;
grant execute on function public.raise_exception(exception_type, text, uuid) to authenticated;
