-- ---------------------------------------------------------------------------
-- Data retention.
--
-- org_settings.evidence_retention_months has existed since the first schema and
-- nothing ever acted on it. A retention period that is configured but not
-- enforced is worse than none: it is a promise in a contract, an answer given
-- to an auditor, and a storage bill that grows for ever.
--
-- What is purged, and what is never purged, is the whole design:
--
--   PURGED   the photographs. They are the largest thing by far, and their
--            evidential value has a half-life — nobody disputes a movement
--            from two years ago, and if they do, the record of it still exists.
--
--   KEPT     the movement, the attempt, the hashes and the audit log. The row
--            that says WHICH vehicle went into WHICH container, who decided,
--            when, and what the photograph's SHA-256 was, stays for ever. The
--            hash outlives the image on purpose: it still proves what the
--            image was, so a copy produced later can be checked against it.
--
-- Deleting an attempt row instead would break the audit hash chain and destroy
-- the answer while keeping the storage bill. This does the opposite.
-- ---------------------------------------------------------------------------

alter table verification_attempts
  add column if not exists evidence_purged_at timestamptz;

comment on column verification_attempts.evidence_purged_at is
  'When the photographs for this attempt were removed under the retention '
  'policy. The paths are cleared and the SHA-256 values are kept, so the '
  'record still proves what the image was.';

create index if not exists attempts_retention_idx
  on verification_attempts (org_id, created_at)
  where evidence_purged_at is null
    and (container_image_path is not null or chassis_image_path is not null);

/**
 * Removes evidence images that have outgrown their retention period.
 *
 * Runs as the service role from a schedule — never from a user session, which
 * is why there is no grant to `authenticated` at the bottom of this file. A
 * token in a driver's phone that can delete evidence is not a retention
 * policy, it is a way to destroy the case against a bad movement.
 *
 * Idempotent and interruptible: it works in batches, marks what it has done,
 * and can be run again after a timeout without redoing or skipping anything.
 */
create or replace function app.purge_expired_evidence(p_batch int default 500)
returns table (purged_attempts int, purged_objects int)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_attempts int := 0;
  v_objects  int := 0;
  v_paths    text[];
begin
  with expired as (
    select va.id,
           va.container_image_path,
           va.chassis_image_path
      from public.verification_attempts va
      join public.org_settings s on s.org_id = va.org_id
     where va.evidence_purged_at is null
       and (va.container_image_path is not null or va.chassis_image_path is not null)
       and va.created_at < now() - make_interval(months => s.evidence_retention_months)
     order by va.created_at
     limit p_batch
  ),
  cleared as (
    update public.verification_attempts va
       set container_image_path = null,
           chassis_image_path   = null,
           evidence_purged_at   = now()
      from expired e
     where va.id = e.id
    returning e.container_image_path, e.chassis_image_path
  )
  select coalesce(array_agg(p) filter (where p is not null), '{}'),
         count(*)::int
    into v_paths, v_attempts
    from cleared c
    cross join lateral (values (c.container_image_path), (c.chassis_image_path)) as t(p);

  -- The attempt row is the source of truth for what should exist in the
  -- bucket, so the object is removed only after the row no longer points at
  -- it. An orphaned object is a storage cost; a row pointing at a deleted
  -- object is a broken evidence link in an audit.
  if array_length(v_paths, 1) > 0 then
    delete from storage.objects
     where bucket_id = 'evidence' and name = any (v_paths);
    get diagnostics v_objects = row_count;
  end if;

  -- v_attempts counts (attempt, image) pairs above; report attempts.
  select count(*)::int into v_attempts
    from public.verification_attempts
   where evidence_purged_at >= now() - interval '1 second';

  return query select v_attempts, v_objects;
end $$;

revoke all on function app.purge_expired_evidence(int) from public, authenticated, anon;

/**
 * What retention would remove if it ran now.
 *
 * Read-only, and readable by an admin, so the policy can be seen working —
 * or seen not working — before anyone is asked to trust it. A retention job
 * nobody can observe is a retention job nobody will notice has stopped.
 */
create or replace function public.retention_pending()
returns table (org_id uuid, retention_months int, attempts_due bigint, oldest timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.org_id,
         s.evidence_retention_months,
         count(va.id),
         min(va.created_at)
    from public.org_settings s
    left join public.verification_attempts va
           on va.org_id = s.org_id
          and va.evidence_purged_at is null
          and (va.container_image_path is not null or va.chassis_image_path is not null)
          and va.created_at < now() - make_interval(months => s.evidence_retention_months)
   where s.org_id = app.current_org()
     and app.is_admin()
   group by s.org_id, s.evidence_retention_months
$$;

revoke all on function public.retention_pending() from public, anon;
grant execute on function public.retention_pending() to authenticated;
