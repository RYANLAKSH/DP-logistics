-- ---------------------------------------------------------------------------
-- Audit log: append-only, hash-chained.
--
-- Three independent layers, because any one alone is defeatable:
--   1. No write grant to any client role.
--   2. A trigger that raises on UPDATE / DELETE / TRUNCATE.
--   3. A hash chain, so tampering by someone who can bypass 1 and 2 is
--      detectable rather than merely discouraged.
-- ---------------------------------------------------------------------------

create table audit_logs (
  id           bigint generated always as identity primary key,
  org_id       uuid references organizations(id) on delete restrict,
  -- Yard scope so a MANAGER can be granted audit visibility for their own
  -- yards without being granted the whole organisation's history.
  yard_id      uuid references yards(id) on delete restrict,
  occurred_at  timestamptz not null default now(),
  actor_id     uuid references profiles(id) on delete restrict,
  actor_role   user_role,
  action       text not null,          -- 'movement.verified', 'manifest.published', …
  entity_type  text not null,
  entity_id    uuid,
  before_value jsonb,
  after_value  jsonb,
  context      jsonb,                  -- device, app version, ip, user agent
  prev_hash    text,
  row_hash     text not null
);

create index audit_org_time_idx on audit_logs (org_id, occurred_at desc);
create index audit_entity_idx on audit_logs (entity_type, entity_id, occurred_at desc);
create index audit_actor_idx on audit_logs (actor_id, occurred_at desc);
create index audit_action_idx on audit_logs (action, occurred_at desc);
create index audit_yard_time_idx on audit_logs (yard_id, occurred_at desc);

-- Serialises the chain. Audit writes are low-volume relative to the rest of
-- the workload, so a single advisory lock is an acceptable cost for a chain
-- that is actually verifiable.
create or replace function app.audit_hash_chain()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  last_hash text;
begin
  perform pg_advisory_xact_lock(hashtext('dp_audit_chain'));

  select a.row_hash into last_hash
    from public.audit_logs a
   order by a.id desc
   limit 1;

  new.prev_hash := last_hash;
  new.row_hash := encode(
    public.digest(
      coalesce(last_hash, '') ||
      coalesce(new.occurred_at::text, '') ||
      coalesce(new.actor_id::text, '') ||
      coalesce(new.action, '') ||
      coalesce(new.entity_type, '') ||
      coalesce(new.entity_id::text, '') ||
      coalesce(new.before_value::text, '') ||
      coalesce(new.after_value::text, ''),
      'sha256'),
    'hex');
  return new;
end;
$$;

create trigger audit_logs_hash before insert on audit_logs
  for each row execute function app.audit_hash_chain();

create or replace function app.audit_immutable()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception
    'audit_logs is append-only: % attempted by %', tg_op, current_user
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger audit_logs_no_update before update on audit_logs
  for each statement execute function app.audit_immutable();
create trigger audit_logs_no_delete before delete on audit_logs
  for each statement execute function app.audit_immutable();
create trigger audit_logs_no_truncate before truncate on audit_logs
  for each statement execute function app.audit_immutable();

-- The only supported way to write an audit row. SECURITY DEFINER so callers
-- need no direct grant; actor is derived from auth.uid(), never passed in.
create or replace function app.audit(
  p_action      text,
  p_entity_type text,
  p_entity_id   uuid,
  p_before      jsonb default null,
  p_after       jsonb default null,
  p_context     jsonb default null,
  p_org_id      uuid  default null,
  p_yard_id     uuid  default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.audit_logs
    (org_id, yard_id, actor_id, actor_role, action, entity_type, entity_id,
     before_value, after_value, context, row_hash)
  values
    (coalesce(p_org_id, app.current_org()), p_yard_id, auth.uid(), app.current_role(),
     p_action, p_entity_type, p_entity_id, p_before, p_after, p_context, '');
end;
$$;

-- Walks the chain and reports the first break. Run nightly; the result is
-- what gets anchored outside the database (docs/design/13 section 3).
create or replace function public.verify_audit_chain(p_from bigint default 0)
returns table (broken_at bigint, expected text, found text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  r          record;
  prev       text := null;
  recomputed text;
  first_row  boolean := true;
begin
  if not app.is_admin() then
    raise exception 'verify_audit_chain requires ADMIN'
      using errcode = 'insufficient_privilege';
  end if;

  for r in
    select * from public.audit_logs where id >= p_from order by id
  loop
    if first_row then
      prev := r.prev_hash;      -- trust the starting point when resuming
      first_row := false;
    end if;

    recomputed := encode(
      public.digest(
        coalesce(prev, '') ||
        coalesce(r.occurred_at::text, '') ||
        coalesce(r.actor_id::text, '') ||
        coalesce(r.action, '') ||
        coalesce(r.entity_type, '') ||
        coalesce(r.entity_id::text, '') ||
        coalesce(r.before_value::text, '') ||
        coalesce(r.after_value::text, ''),
        'sha256'),
      'hex');

    if recomputed <> r.row_hash then
      broken_at := r.id;
      expected  := recomputed;
      found     := r.row_hash;
      return next;
      return;
    end if;

    prev := r.row_hash;
  end loop;
end;
$$;

revoke all on function public.verify_audit_chain(bigint) from public;
grant execute on function public.verify_audit_chain(bigint) to authenticated;
