-- ---------------------------------------------------------------------------
-- Local-only shim.
--
-- Supabase provides the auth schema, the auth.uid()/auth.jwt() helpers, the
-- anon/authenticated/service_role roles, and the storage schema. This file
-- recreates just enough of them that the real migrations run unmodified
-- against a plain PostgreSQL cluster.
--
-- It is NEVER applied to a Supabase project. It lives in tests/, not
-- migrations/, precisely so it cannot be.
-- ---------------------------------------------------------------------------

create schema if not exists auth;
create schema if not exists storage;

create table if not exists auth.users (
  id            uuid primary key default gen_random_uuid(),
  email         text unique,
  raw_app_meta_data jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now()
);

-- Supabase reads the verified JWT from a GUC. Tests set the same GUC.
-- Mirrors Supabase's own definition, including the nullif on the GUC itself:
-- an unset or cleared claims string must yield NULL, not a JSON parse error.
create or replace function auth.uid() returns uuid
  language sql stable as $$
  select nullif(
           nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub',
         '')::uuid
$$;

create or replace function auth.jwt() returns jsonb
  language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb)
$$;

create or replace function auth.role() returns text
  language sql stable as $$
  select coalesce(auth.jwt() ->> 'role', 'anon')
$$;

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema auth to anon, authenticated, service_role;

-- Minimal storage.objects so storage policies parse and can be exercised.
create table if not exists storage.buckets (
  id      text primary key,
  name    text not null,
  public  boolean not null default false
);

create table if not exists storage.objects (
  id          uuid primary key default gen_random_uuid(),
  bucket_id   text not null references storage.buckets(id),
  name        text not null,
  owner       uuid,
  created_at  timestamptz not null default now(),
  metadata    jsonb,
  unique (bucket_id, name)
);

create or replace function storage.foldername(name text) returns text[]
  language sql immutable as $$
  select string_to_array(name, '/')
$$;

grant usage on schema storage to anon, authenticated, service_role;
