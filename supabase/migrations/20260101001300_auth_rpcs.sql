-- ---------------------------------------------------------------------------
-- Authentication support.
--
-- Supabase Auth owns identity. This file owns everything that turns an
-- authenticated identity into an authorised one, and it is all server-side.
-- ---------------------------------------------------------------------------

-- The single call the client makes after sign-in. Returns the caller's own
-- profile and yard scope and nothing else.
--
-- Deliberately an RPC rather than a select on `profiles`: the client needs the
-- yard list too, and one round trip beats two on a phone at a ramp. It is
-- SECURITY DEFINER only so it can read user_yards without a second policy;
-- it returns data for auth.uid() and no other row is reachable through it.
create or replace function public.me()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.profiles;
  y jsonb;
begin
  if auth.uid() is null then
    return null;
  end if;

  select * into p from public.profiles where id = auth.uid();
  if not found or not p.is_active then
    -- An authenticated user with no active profile has an identity but no
    -- authorisation. The client must treat this as "signed out", not as an
    -- error to retry.
    return null;
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', yy.id, 'code', yy.code, 'name', yy.name)), '[]'::jsonb)
    into y
    from public.yards yy
   where yy.is_active
     and (
       p.role = 'ADMIN' and yy.org_id = p.org_id
       or exists (select 1 from public.user_yards uy
                   where uy.user_id = p.id and uy.yard_id = yy.id)
     );

  return jsonb_build_object(
    'id', p.id,
    'orgId', p.org_id,
    'role', p.role,
    'fullName', p.full_name,
    'employeeNo', p.employee_no,
    'yards', y
  );
end;
$$;

revoke all on function public.me() from public;
grant execute on function public.me() to authenticated;

-- ---------------------------------------------------------------------------
-- Administration of users.
--
-- There is no self-registration and no client-writable path to `profiles`.
-- An administrator invites a user through Supabase Auth, then calls this to
-- give the resulting identity a role and a yard scope.
-- ---------------------------------------------------------------------------
create or replace function public.admin_create_profile(
  p_user_id     uuid,
  p_role        user_role,
  p_full_name   text,
  p_employee_no text default null,
  p_yard_ids    uuid[] default '{}'
)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles;
  created public.profiles;
  yid uuid;
begin
  select * into actor from public.profiles where id = auth.uid();
  if not found or not actor.is_active or actor.role <> 'ADMIN' then
    raise exception 'only an ADMIN may create profiles'
      using errcode = 'insufficient_privilege';
  end if;

  insert into public.profiles (id, org_id, role, full_name, employee_no)
  values (p_user_id, actor.org_id, p_role, p_full_name, p_employee_no)
  returning * into created;

  foreach yid in array coalesce(p_yard_ids, '{}') loop
    -- A yard from another organisation would silently widen this user's scope.
    if not exists (select 1 from public.yards y
                    where y.id = yid and y.org_id = actor.org_id) then
      raise exception 'yard % is not in your organisation', yid
        using errcode = 'insufficient_privilege';
    end if;
    insert into public.user_yards (user_id, yard_id) values (created.id, yid);
  end loop;

  perform app.audit('user.created', 'profile', created.id, null,
    jsonb_build_object('role', p_role, 'full_name', p_full_name,
                       'yard_ids', p_yard_ids),
    null, actor.org_id, null);
  return created;
end;
$$;

create or replace function public.admin_set_role(p_user_id uuid, p_role user_role)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor  public.profiles;
  before public.profiles;
  after  public.profiles;
begin
  select * into actor from public.profiles where id = auth.uid();
  if not found or not actor.is_active or actor.role <> 'ADMIN' then
    raise exception 'only an ADMIN may change a role'
      using errcode = 'insufficient_privilege';
  end if;

  select * into before from public.profiles
   where id = p_user_id and org_id = actor.org_id for update;
  if not found then
    raise exception 'user not found in your organisation' using errcode = 'no_data_found';
  end if;

  -- An admin who can demote the last admin can lock the organisation out of
  -- its own administration. Refuse rather than repair it later.
  if before.role = 'ADMIN' and p_role <> 'ADMIN'
     and (select count(*) from public.profiles
           where org_id = actor.org_id and role = 'ADMIN' and is_active) <= 1 then
    raise exception 'cannot remove the last active ADMIN' using errcode = 'check_violation';
  end if;

  update public.profiles set role = p_role, updated_at = now()
   where id = p_user_id returning * into after;

  perform app.audit('user.role_changed', 'profile', p_user_id,
    jsonb_build_object('role', before.role),
    jsonb_build_object('role', after.role),
    null, actor.org_id, null);
  return after;
end;
$$;

create or replace function public.admin_deactivate_user(p_user_id uuid, p_reason text)
returns public.profiles
language plpgsql
security definer
set search_path = ''
as $$
declare
  actor public.profiles;
  target public.profiles;
begin
  select * into actor from public.profiles where id = auth.uid();
  if not found or not actor.is_active or actor.role <> 'ADMIN' then
    raise exception 'only an ADMIN may deactivate a user'
      using errcode = 'insufficient_privilege';
  end if;
  if p_user_id = actor.id then
    raise exception 'you cannot deactivate yourself' using errcode = 'check_violation';
  end if;

  update public.profiles set is_active = false, updated_at = now()
   where id = p_user_id and org_id = actor.org_id
  returning * into target;

  if not found then
    raise exception 'user not found in your organisation' using errcode = 'no_data_found';
  end if;

  -- Every device the user holds is revoked in the same transaction. Leaving an
  -- approved device behind would leave a dismissed employee able to complete
  -- movements until someone noticed.
  update public.devices set status = 'REVOKED', revoked_by = actor.id, revoked_at = now()
   where user_id = p_user_id and status <> 'REVOKED';

  perform app.audit('user.deactivated', 'profile', p_user_id, null,
    jsonb_build_object('reason', p_reason), null, actor.org_id, null);
  return target;
end;
$$;

-- IMPORTANT, and not expressible in SQL: deactivating a user does NOT end
-- their session. Their access token stays valid until it expires and their
-- refresh token far longer. The admin surface MUST also call
-- auth.admin.signOut(user_id) from a service-role Edge Function. Relying on
-- is_active alone leaves a dismissed employee with a working session.

revoke all on function public.admin_create_profile(uuid, user_role, text, text, uuid[]) from public;
revoke all on function public.admin_set_role(uuid, user_role) from public;
revoke all on function public.admin_deactivate_user(uuid, text) from public;
grant execute on function public.admin_create_profile(uuid, user_role, text, text, uuid[]) to authenticated;
grant execute on function public.admin_set_role(uuid, user_role) to authenticated;
grant execute on function public.admin_deactivate_user(uuid, text) to authenticated;
