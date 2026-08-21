-- Extensions and the private schema that holds helper functions.
create extension if not exists pgcrypto;      -- gen_random_uuid(), digest()

-- `app` holds helpers that are NOT part of the client-facing API surface.
-- Nothing in here is exposed through PostgREST.
create schema if not exists app;
revoke all on schema app from public;
grant usage on schema app to authenticated, service_role;
