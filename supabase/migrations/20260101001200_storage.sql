-- ---------------------------------------------------------------------------
-- Storage buckets and policies.
--
-- Two private buckets. No bucket is ever public, and no client ever chooses an
-- object path — a client-supplied path is a write-anywhere primitive that a
-- storage policy alone will not save you from. Paths are constructed by
-- create_evidence_upload_path() below.
--
--   evidence/{org_id}/{yard_id}/{operating_date}/{assignment_id}/{kind}-{attempt}.jpg
--   manifests/{org_id}/{yard_id}/{operating_date}/{sha256}.{ext}
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public)
values ('evidence', 'evidence', false), ('manifests', 'manifests', false)
on conflict (id) do update set public = false;

-- Path segment 1 is the org, segment 2 is the yard. Policies read them back
-- out of the object name and apply the same scoping as the tables.
create or replace function app.storage_org(objname text)
returns uuid language sql immutable set search_path = '' as $$
  select nullif((storage.foldername(objname))[1], '')::uuid
$$;

create or replace function app.storage_yard(objname text)
returns uuid language sql immutable set search_path = '' as $$
  select nullif((storage.foldername(objname))[2], '')::uuid
$$;

-- ------------------------------- evidence ----------------------------------
-- Drivers may write only into their own organisation and their own yards, and
-- may read back only what they created. Managers read their yards. Admins read
-- the organisation. Nobody gets UPDATE or DELETE: evidence is immutable, and
-- retention purging runs as the service role from a scheduled job.
--
-- Manifest source files carry the whole day's plan; drivers have no business
-- in them at all.
--
-- Helper calls are hoisted the same way as in the table policies: this bucket
-- is the largest table in the system by row count, and a per-row can_see_yard
-- here costs what it did on the audit log.
--
-- ---------------------------------------------------------------------------
-- Why these are wrapped rather than written as five plain statements.
--
-- Idempotency. A migration that half-applied — a timeout, a failure in a later
-- file, a re-run against a project the CLI had already been pointed at — has to
-- be safe to run again. `create policy` alone is not: it fails with "policy
-- already exists" and takes the rest of the push with it. Dropping first makes
-- a re-run a no-op.
--
-- And a legible failure. On a hosted project `storage.objects` is owned by
-- `supabase_storage_admin`; if the migration role cannot create policies on it
-- the raw error is `42501: must be owner of table objects`, arriving in the
-- middle of a 21-file push and naming neither the file nor the remedy.
--
-- Deliberately NOT attempted: adopting that owner role. These policy bodies
-- resolve names in `app` and in `auth`, so the adopted role would need USAGE on
-- both, and on a hosted project those schemas are owned by different roles
-- again. Chasing that grant matrix from inside a migration trades one obscure
-- failure for a longer chain of them. If this is the file that cannot apply,
-- running this one file from the dashboard SQL editor is a ten-second fix, and
-- the handler says so.
-- ---------------------------------------------------------------------------
do $$
begin
  execute 'drop policy if exists evidence_driver_insert on storage.objects';
  execute $ddl$
    create policy evidence_driver_insert on storage.objects for insert to authenticated
      with check (
        bucket_id = 'evidence'
        and (select app.is_driver())
        and app.storage_org(name) = (select app.current_org())
        and app.storage_yard(name) in (select unnest(app.visible_yards()))
      )
  $ddl$;

  execute 'drop policy if exists evidence_owner_read on storage.objects';
  execute $ddl$
    create policy evidence_owner_read on storage.objects for select to authenticated
      using (
        bucket_id = 'evidence'
        and owner = auth.uid()
      )
  $ddl$;

  execute 'drop policy if exists evidence_manager_read on storage.objects';
  execute $ddl$
    create policy evidence_manager_read on storage.objects for select to authenticated
      using (
        bucket_id = 'evidence'
        and (select app.is_manager_or_admin())
        and app.storage_org(name) = (select app.current_org())
        and app.storage_yard(name) in (select unnest(app.visible_yards()))
      )
  $ddl$;

  execute 'drop policy if exists manifest_manager_write on storage.objects';
  execute $ddl$
    create policy manifest_manager_write on storage.objects for insert to authenticated
      with check (
        bucket_id = 'manifests'
        and (select app.is_manager_or_admin())
        and app.storage_org(name) = (select app.current_org())
        and app.storage_yard(name) in (select unnest(app.visible_yards()))
      )
  $ddl$;

  execute 'drop policy if exists manifest_manager_read on storage.objects';
  execute $ddl$
    create policy manifest_manager_read on storage.objects for select to authenticated
      using (
        bucket_id = 'manifests'
        and (select app.is_manager_or_admin())
        and app.storage_org(name) = (select app.current_org())
        and app.storage_yard(name) in (select unnest(app.visible_yards()))
      )
  $ddl$;

  raise notice 'storage policies applied';
exception
  when insufficient_privilege then
    raise exception
      'Could not create the storage policies (%). Run this one file, '
      'supabase/migrations/20260101001200_storage.sql, from the Supabase '
      'dashboard SQL editor, then re-run `supabase db push` to continue.', sqlerrm;
end $$;

-- ---------------------------------------------------------------------------
-- The server constructs every evidence path. The client asks for a path for a
-- movement it is entitled to, and gets one; it never proposes one.
-- ---------------------------------------------------------------------------
create or replace function public.create_evidence_upload_path(
  p_assignment_id uuid,
  p_kind          attempt_kind,
  p_attempt_id    uuid
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  drv public.profiles := app.require_driver();
  a   public.vehicle_assignments;
  m   public.manifests;
begin
  select * into a from public.vehicle_assignments where id = p_assignment_id;
  if not found then
    raise exception 'assignment not found' using errcode = 'no_data_found';
  end if;
  select * into m from public.manifests where id = a.manifest_id;

  if m.status <> 'PUBLISHED' then
    raise exception 'assignment is not on a published manifest' using errcode = 'check_violation';
  end if;
  if not app.user_has_yard(drv.id, m.yard_id) then
    raise exception 'assignment is outside your yards' using errcode = 'insufficient_privilege';
  end if;

  return format('%s/%s/%s/%s/%s-%s.jpg',
                drv.org_id, m.yard_id, to_char(m.operating_date, 'YYYY-MM-DD'),
                a.id, lower(p_kind::text), p_attempt_id);
end;
$$;

revoke all on function public.create_evidence_upload_path(uuid, attempt_kind, uuid) from public;
grant execute on function public.create_evidence_upload_path(uuid, attempt_kind, uuid)
  to authenticated;
