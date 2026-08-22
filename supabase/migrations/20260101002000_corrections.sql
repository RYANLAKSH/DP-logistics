-- ---------------------------------------------------------------------------
-- Manifest corrections.
--
-- The highest-risk mutation in the system: changing the source of truth after
-- work has been done against it. It therefore never mutates. A correction
-- clones the published manifest into a new version with the change applied,
-- archives the old version, and records the before value, the after value, the
-- reason, and every completed movement the change invalidates.
-- ---------------------------------------------------------------------------

create or replace function public.correct_manifest_assignment(
  p_assignment_id uuid,
  p_field         text,          -- 'chassis_no' | 'container_no' | 'sequence_no'
  p_new_value     text,
  p_reason        text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr       public.profiles := app.require_manager();
  a         public.vehicle_assignments;
  old_m     public.manifests;
  new_m     public.manifests;
  v_version int;
  v_before  text;
  v_after   text;
  v_target_container uuid;
  v_affected jsonb;
  v_correction uuid;
  r         record;
begin
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a correction to the manifest needs a substantive reason'
      using errcode = 'check_violation';
  end if;
  if p_field not in ('chassis_no', 'container_no', 'sequence_no') then
    raise exception 'unsupported field %', p_field using errcode = 'check_violation';
  end if;

  select * into a from public.vehicle_assignments where id = p_assignment_id;
  if not found then
    raise exception 'assignment not found' using errcode = 'no_data_found';
  end if;
  select * into old_m from public.manifests where id = a.manifest_id for update;
  if old_m.status <> 'PUBLISHED' then
    raise exception 'only the published manifest can be corrected (this one is %)',
      old_m.status using errcode = 'check_violation';
  end if;
  if not app.user_has_yard(mgr.id, old_m.yard_id) then
    raise exception 'that manifest is outside your yards'
      using errcode = 'insufficient_privilege';
  end if;

  v_before := case p_field
                when 'chassis_no'   then a.chassis_no
                when 'sequence_no'  then a.sequence_no::text
                else (select container_no from public.containers where id = a.container_id)
              end;
  v_after := case when p_field = 'sequence_no'
                  then p_new_value
                  else app.normalize_code(p_new_value) end;

  if v_before is not distinct from v_after then
    raise exception 'that is already the value on the manifest'
      using errcode = 'check_violation';
  end if;

  -- Which completed movements does this invalidate? Computed BEFORE the change,
  -- and recorded, so the correction carries its own blast radius.
  select coalesce(jsonb_agg(jsonb_build_object(
           'movement_id', me.id,
           'container_no', me.expected_container_no,
           'chassis_no', me.expected_chassis_no,
           'verified_at', me.verified_at)), '[]'::jsonb)
    into v_affected
    from public.movement_events me
   where me.assignment_id = a.id and me.status in ('COMPLETED', 'OVERRIDDEN');

  select coalesce(max(version), 0) + 1 into v_version
    from public.manifests
   where yard_id = old_m.yard_id and operating_date = old_m.operating_date;

  insert into public.manifests (
    org_id, yard_id, operating_date, version, status, reference_no,
    supersedes_id, import_id, source_file_path, source_file_sha256, created_by
  ) values (
    old_m.org_id, old_m.yard_id, old_m.operating_date, v_version, 'DRAFT',
    old_m.reference_no, old_m.id, old_m.import_id,
    old_m.source_file_path, old_m.source_file_sha256, mgr.id
  ) returning * into new_m;

  -- Clone the containers, renaming the one being corrected.
  insert into public.containers (
    manifest_id, container_no, iso_type, expected_vehicle_count, bay_position,
    sequence_no, raw_row
  )
  select new_m.id,
         case when p_field = 'container_no' and ct.id = a.container_id
              then v_after else ct.container_no end,
         ct.iso_type, ct.expected_vehicle_count, ct.bay_position, ct.sequence_no, ct.raw_row
    from public.containers ct
   where ct.manifest_id = old_m.id;

  -- Clone the assignments, applying the change to the one being corrected.
  for r in select * from public.vehicle_assignments
            where manifest_id = old_m.id order by sequence_no
  loop
    select nc.id into v_target_container
      from public.containers nc
      join public.containers oc on oc.id = r.container_id
     where nc.manifest_id = new_m.id
       and nc.container_no = case
             when p_field = 'container_no' and r.id = a.id then v_after
             else oc.container_no end;

    insert into public.vehicle_assignments (
      manifest_id, container_id, chassis_no, sequence_no, vehicle_reg_no,
      make_model, colour, status, claimed_by, claimed_at, raw_row
    ) values (
      new_m.id, v_target_container,
      case when p_field = 'chassis_no' and r.id = a.id then v_after else r.chassis_no end,
      case when p_field = 'sequence_no' and r.id = a.id then v_after::int else r.sequence_no end,
      r.vehicle_reg_no, r.make_model, r.colour,
      -- Carry state across: a vehicle already loaded stays loaded. A correction
      -- cannot un-move a vehicle that is physically inside a container.
      r.status, r.claimed_by, r.claimed_at, r.raw_row
    );
  end loop;

  update public.manifests
     set status = 'ARCHIVED', archived_at = now(),
         archive_reason = format('Corrected: %s', p_reason)
   where id = old_m.id;

  update public.manifests
     set status = 'PUBLISHED', published_by = mgr.id, published_at = now(),
         total_containers = (select count(*) from public.containers where manifest_id = new_m.id),
         total_vehicles = (select count(*) from public.vehicle_assignments where manifest_id = new_m.id)
   where id = new_m.id
  returning * into new_m;

  insert into public.manifest_corrections (
    org_id, from_manifest_id, to_manifest_id, container_no, chassis_no,
    field_name, before_value, after_value, reason, affected_movements, corrected_by
  ) values (
    mgr.org_id, old_m.id, new_m.id,
    (select container_no from public.containers where id = a.container_id),
    a.chassis_no, p_field, v_before, v_after, p_reason, v_affected, mgr.id
  ) returning id into v_correction;

  perform app.audit('manifest.corrected', 'manifest', new_m.id,
    jsonb_build_object('manifest_id', old_m.id, 'field', p_field, 'value', v_before),
    jsonb_build_object('manifest_id', new_m.id, 'field', p_field, 'value', v_after,
                       'reason', p_reason, 'affected_movements', v_affected,
                       'correction_id', v_correction),
    null, mgr.org_id, old_m.yard_id);

  -- A completed movement is never retroactively invalidated: the vehicle is
  -- physically in the container and a row cannot unload it. What the system
  -- owes is a loud, permanent flag routed to a human.
  if jsonb_array_length(v_affected) > 0 then
    insert into public.exceptions (
      org_id, yard_id, manifest_id, type, severity, description, raised_by,
      expected_value, actual_value
    ) values (
      mgr.org_id, old_m.yard_id, new_m.id, 'MANIFEST_CONFLICT', 1,
      format('Correction to %s invalidated %s already-completed movement(s)',
             p_field, jsonb_array_length(v_affected)),
      mgr.id, v_before, v_after
    );
  end if;

  return jsonb_build_object(
    'correction_id', v_correction,
    'manifest_id', new_m.id,
    'version', v_version,
    'field', p_field,
    'before', v_before,
    'after', v_after,
    'affected_movements', v_affected
  );
end;
$$;

-- Sign-in cannot be observed from inside Postgres: GoTrue issues the token.
-- The client reports it so the audit trail has the event; it is trusted only
-- for the identity the JWT already proves.
create or replace function public.record_sign_in(p_context jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then return; end if;
  perform app.audit('auth.login', 'profile', p.id, null,
    jsonb_build_object('role', p.role), p_context, p.org_id, null);
end;
$$;

create or replace function public.record_sign_out()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare p public.profiles;
begin
  select * into p from public.profiles where id = auth.uid();
  if not found then return; end if;
  perform app.audit('auth.logout', 'profile', p.id, null, null, null, p.org_id, null);
end;
$$;

revoke all on function public.correct_manifest_assignment(uuid, text, text, text) from public;
revoke all on function public.record_sign_in(jsonb) from public;
revoke all on function public.record_sign_out() from public;
grant execute on function public.correct_manifest_assignment(uuid, text, text, text) to authenticated;
grant execute on function public.record_sign_in(jsonb) to authenticated;
grant execute on function public.record_sign_out() to authenticated;
