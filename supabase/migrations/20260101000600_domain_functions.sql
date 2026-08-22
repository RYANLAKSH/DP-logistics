-- ---------------------------------------------------------------------------
-- Domain helpers: normalisation, ISO 6346, and the authorisation context
-- helpers that every RLS policy is built from.
-- ---------------------------------------------------------------------------

-- SAFE normalisation only: case-fold and strip separators.
--
-- Deliberately does NOT map confusable characters (O->0, I->1, S->5). Those
-- mappings can make two genuinely different identifiers compare equal, which
-- would mask exactly the mismatch this system exists to catch. Confusable
-- repair happens on the device as a *proposal* that a human confirms; the
-- server compares the confirmed value exactly.
create or replace function app.normalize_code(raw text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select nullif(regexp_replace(upper(btrim(coalesce(raw, ''))), '[^A-Z0-9]', '', 'g'), '')
$$;

-- ISO 6346 check digit. Letter values run A=10..Z=38 skipping every multiple
-- of 11. Each of the first 10 characters is weighted by 2^position, summed,
-- mod 11, with 10 folding to 0.
--
-- This is the highest-leverage arithmetic in the system: it rejects roughly
-- ten out of eleven single-character OCR errors, offline, in microseconds.
create or replace function app.container_check_digit(first10 text)
returns int
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  ch      text;
  i       int;
  val     int;
  total   int := 0;
  letters text := 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  lv      int[] := array[]::int[];
  v       int := 10;
begin
  if first10 is null or first10 !~ '^[A-Z]{4}[0-9]{6}$' then
    return null;
  end if;

  -- Build the letter table once per call: A=10, B=12, ... skipping 11/22/33.
  for i in 1..26 loop
    while v % 11 = 0 loop
      v := v + 1;
    end loop;
    lv := lv || v;
    v := v + 1;
  end loop;

  for i in 1..10 loop
    ch := substr(first10, i, 1);
    if i <= 4 then
      val := lv[position(ch in letters)];
    else
      val := ch::int;
    end if;
    total := total + val * (2 ^ (i - 1))::int;
  end loop;

  return (total % 11) % 10;
end;
$$;

-- Is this identifier shaped like an ISO 6346 container number at all?
--
-- Real operators do not universally use them: the sample data for this build
-- uses references like CULVNSA2601795, which is 14 characters and carries no
-- check digit. So check-digit validation is applied CONDITIONALLY — when the
-- expected identifier is ISO-shaped we get the free error detection, and when
-- it is not we fall back to exact comparison. Rejecting a customer's real
-- container references because they are not ISO 6346 would make the product
-- unusable at exactly the yards it was built for.
create or replace function app.is_iso6346_shaped(raw text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select app.normalize_code(raw) ~ '^[A-Z]{4}[0-9]{7}$'
$$;

create or replace function app.is_valid_container_no(raw text)
returns boolean
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  s text := app.normalize_code(raw);
begin
  if s is null or s !~ '^[A-Z]{4}[0-9]{7}$' then
    return false;
  end if;
  return app.container_check_digit(substr(s, 1, 10)) = substr(s, 11, 1)::int;
end;
$$;

-- ---------------------------------------------------------------------------
-- Authorisation context.
--
-- SECURITY DEFINER so a policy on `profiles` cannot recurse into itself, and
-- STABLE so the planner evaluates it once per statement rather than per row.
-- Every one of these derives identity from auth.uid() and accepts no
-- caller-supplied identity of any kind.
-- ---------------------------------------------------------------------------

create or replace function app.current_role()
returns user_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
    from public.profiles p
   where p.id = auth.uid()
     and p.is_active
$$;

create or replace function app.current_org()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select p.org_id
    from public.profiles p
   where p.id = auth.uid()
     and p.is_active
$$;

create or replace function app.current_yards()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(array_agg(uy.yard_id), '{}'::uuid[])
    from public.user_yards uy
    join public.profiles p on p.id = uy.user_id and p.is_active
   where uy.user_id = auth.uid()
$$;

-- ADMIN is organisation-wide. MANAGER and DRIVER are scoped to their yards.
create or replace function app.can_see_yard(target_yard uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then false
    when app.current_role() = 'ADMIN' then
      exists (select 1 from public.yards y
               where y.id = target_yard and y.org_id = app.current_org())
    else target_yard = any (app.current_yards())
  end
$$;

/**
 * Every yard the current user may see, as a set.
 *
 * can_see_yard() above answers the same question one yard at a time, which is
 * the right shape inside a function and the wrong shape inside a row policy:
 * the argument is a column, so the planner cannot hoist the call and evaluates
 * it once per row. Over an audit log with a few hundred thousand rows that was
 * measured at fifteen seconds for a single count.
 *
 * Written as a set, a policy can say `yard_id in (select unnest(...))` and
 * Postgres builds one hashed subplan for the whole statement. Same rows, same
 * rules — the difference is entirely in how many times the question is asked.
 */
create or replace function app.visible_yards()
returns uuid[]
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when auth.uid() is null then '{}'::uuid[]
    when app.current_role() = 'ADMIN' then coalesce(
      (select array_agg(y.id) from public.yards y where y.org_id = app.current_org()),
      '{}'::uuid[])
    else app.current_yards()
  end
$$;

create or replace function app.is_admin() returns boolean
  language sql stable set search_path = '' as $$ select app.current_role() = 'ADMIN' $$;

create or replace function app.is_manager_or_admin() returns boolean
  language sql stable set search_path = ''
  as $$ select app.current_role() in ('ADMIN', 'MANAGER') $$;

create or replace function app.is_driver() returns boolean
  language sql stable set search_path = '' as $$ select app.current_role() = 'DRIVER' $$;

grant execute on function
  app.normalize_code(text),
  app.container_check_digit(text),
  app.is_valid_container_no(text),
  app.is_iso6346_shaped(text),
  app.current_role(),
  app.current_org(),
  app.current_yards(),
  app.can_see_yard(uuid),
  app.visible_yards(),
  app.is_admin(),
  app.is_manager_or_admin(),
  app.is_driver()
to authenticated;
