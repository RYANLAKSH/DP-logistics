-- ---------------------------------------------------------------------------
-- Manifest publishing.
--
-- Publishing reads the stored parse result rather than accepting rows from the
-- client, so what goes live is tied to the uploaded file and its hash. There is
-- deliberately NO code path that uploads and publishes in one call: preview is
-- not skippable, because a malformed manifest blocks every vehicle in the yard.
-- ---------------------------------------------------------------------------

create or replace function public.publish_manifest_from_import(
  p_import_id uuid,
  p_reference_no text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr        public.profiles := app.require_manager();
  imp        public.manifest_imports;
  prev       public.manifests;
  new_m      public.manifests;
  v_version  int;
  v_row      jsonb;
  v_container_id uuid;
  v_containers int := 0;
  v_vehicles   int := 0;
  v_affected  jsonb := '[]'::jsonb;
begin
  select * into imp from public.manifest_imports where id = p_import_id for update;
  if not found then
    raise exception 'import not found' using errcode = 'no_data_found';
  end if;
  if imp.org_id <> mgr.org_id or not app.user_has_yard(mgr.id, imp.yard_id) then
    raise exception 'import is outside your yards' using errcode = 'insufficient_privilege';
  end if;
  if imp.status <> 'READY' then
    raise exception 'import is % — only a READY import can be published', imp.status
      using errcode = 'check_violation';
  end if;
  if imp.parsed_rows is null or jsonb_array_length(imp.parsed_rows) = 0 then
    raise exception 'import has no parsed rows' using errcode = 'check_violation';
  end if;
  if coalesce(imp.rejected_count, 0) > 0 then
    raise exception 'import has % rejected rows and cannot be published', imp.rejected_count
      using errcode = 'check_violation';
  end if;

  -- Version, never overwrite. Historical manifests are archived, not replaced.
  select coalesce(max(version), 0) + 1 into v_version
    from public.manifests
   where yard_id = imp.yard_id and operating_date = imp.operating_date;

  select * into prev
    from public.manifests
   where yard_id = imp.yard_id
     and operating_date = imp.operating_date
     and status = 'PUBLISHED'
   for update;

  insert into public.manifests (
    org_id, yard_id, operating_date, version, status, reference_no,
    supersedes_id, import_id, source_file_path, source_file_sha256, created_by
  ) values (
    imp.org_id, imp.yard_id, imp.operating_date, v_version, 'DRAFT', p_reference_no,
    prev.id, imp.id, imp.file_path, imp.file_sha256, mgr.id
  ) returning * into new_m;

  -- Containers first, so assignments can reference them.
  for v_row in
    select distinct on (app.normalize_code(r ->> 'container_no'))
           r
      from jsonb_array_elements(imp.parsed_rows) r
     order by app.normalize_code(r ->> 'container_no'), (r ->> 'row_no')::int
  loop
    insert into public.containers (
      manifest_id, container_no, iso_type, expected_vehicle_count, bay_position,
      sequence_no, raw_row
    ) values (
      new_m.id,
      app.normalize_code(v_row ->> 'container_no'),
      nullif(v_row ->> 'iso_type', ''),
      coalesce(
        nullif(v_row ->> 'expected_vehicle_count', '')::int,
        (select count(*) from jsonb_array_elements(imp.parsed_rows) r2
          where app.normalize_code(r2 ->> 'container_no')
                = app.normalize_code(v_row ->> 'container_no'))::int),
      nullif(v_row ->> 'bay_position', ''),
      nullif(v_row ->> 'row_no', '')::int,
      v_row
    );
    v_containers := v_containers + 1;
  end loop;

  for v_row in select r from jsonb_array_elements(imp.parsed_rows) r
                order by (r ->> 'row_no')::int
  loop
    select id into v_container_id
      from public.containers
     where manifest_id = new_m.id
       and container_no = app.normalize_code(v_row ->> 'container_no');

    insert into public.vehicle_assignments (
      manifest_id, container_id, chassis_no, sequence_no,
      vehicle_reg_no, make_model, colour, raw_row
    ) values (
      new_m.id, v_container_id,
      app.normalize_code(v_row ->> 'chassis_no'),
      coalesce(nullif(v_row ->> 'sequence_no', '')::int, 1),
      nullif(v_row ->> 'vehicle_reg_no', ''),
      nullif(v_row ->> 'make_model', ''),
      nullif(v_row ->> 'colour', ''),
      v_row
    );
    v_vehicles := v_vehicles + 1;
  end loop;

  -- What does this supersede, and which completed movements does it touch?
  if prev.id is not null then
    select coalesce(jsonb_agg(jsonb_build_object(
             'movement_id', me.id,
             'container_no', me.expected_container_no,
             'chassis_no', me.expected_chassis_no,
             'verified_at', me.verified_at,
             'driver_id', me.driver_id)), '[]'::jsonb)
      into v_affected
      from public.movement_events me
     where me.manifest_id = prev.id
       and me.status in ('COMPLETED', 'OVERRIDDEN')
       -- only those whose pairing no longer exists in the new version
       and not exists (
         select 1 from public.vehicle_assignments va
           join public.containers ct on ct.id = va.container_id
          where va.manifest_id = new_m.id
            and va.chassis_no = me.expected_chassis_no
            and ct.container_no = me.expected_container_no);

    update public.manifests
       set status = 'ARCHIVED', archived_at = now(),
           archive_reason = format('Superseded by version %s', v_version)
     where id = prev.id;

    perform app.audit('manifest.archived', 'manifest', prev.id,
      jsonb_build_object('status', 'PUBLISHED'),
      jsonb_build_object('status', 'ARCHIVED', 'superseded_by', new_m.id),
      null, mgr.org_id, imp.yard_id);
  end if;

  update public.manifests
     set status = 'PUBLISHED', published_by = mgr.id, published_at = now(),
         total_containers = v_containers, total_vehicles = v_vehicles
   where id = new_m.id
  returning * into new_m;

  update public.manifest_imports
     set status = 'COMMITTED', committed_at = now()
   where id = imp.id;

  perform app.audit('manifest.published', 'manifest', new_m.id, null,
    jsonb_build_object('version', v_version, 'containers', v_containers,
                       'vehicles', v_vehicles, 'operating_date', imp.operating_date,
                       'supersedes', prev.id, 'affected_movements', v_affected),
    jsonb_build_object('import_id', imp.id, 'file_sha256', imp.file_sha256),
    mgr.org_id, imp.yard_id);

  -- A verified movement is never retroactively invalidated: the vehicle is
  -- physically in the container and a database row cannot unload it. What the
  -- system owes is a loud, permanent flag routed to a human.
  if jsonb_array_length(v_affected) > 0 then
    insert into public.exceptions (org_id, yard_id, manifest_id, type, severity,
                                   description, raised_by, expected_value, actual_value)
    values (mgr.org_id, imp.yard_id, new_m.id, 'MANIFEST_CONFLICT', 1,
            format('Manifest v%s invalidated %s already-completed movement(s)',
                   v_version, jsonb_array_length(v_affected)),
            mgr.id, prev.id::text, new_m.id::text);
  end if;

  return jsonb_build_object(
    'manifest_id', new_m.id,
    'version', v_version,
    'status', new_m.status,
    'containers', v_containers,
    'vehicles', v_vehicles,
    'superseded_manifest_id', prev.id,
    'affected_movements', v_affected
  );
end;
$$;

create or replace function public.archive_manifest(p_manifest_id uuid, p_reason text)
returns public.manifests
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr public.profiles := app.require_manager();
  m   public.manifests;
begin
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a substantive reason is required to archive a manifest'
      using errcode = 'check_violation';
  end if;

  select * into m from public.manifests where id = p_manifest_id for update;
  if not found then
    raise exception 'manifest not found' using errcode = 'no_data_found';
  end if;
  if not app.user_has_yard(mgr.id, m.yard_id) then
    raise exception 'manifest is outside your yards' using errcode = 'insufficient_privilege';
  end if;

  update public.manifests
     set status = 'ARCHIVED', archived_at = now(), archive_reason = p_reason
   where id = p_manifest_id
  returning * into m;

  perform app.audit('manifest.archived', 'manifest', m.id, null,
    jsonb_build_object('reason', p_reason), null, mgr.org_id, m.yard_id);
  return m;
end;
$$;

revoke all on function public.publish_manifest_from_import(uuid, text) from public;
revoke all on function public.archive_manifest(uuid, text) from public;
grant execute on function public.publish_manifest_from_import(uuid, text) to authenticated;
grant execute on function public.archive_manifest(uuid, text) to authenticated;
