-- ---------------------------------------------------------------------------
-- The verification engine and the RPCs that are the ONLY write path into the
-- operational tables.
--
-- Every function here:
--   * is SECURITY DEFINER with `set search_path = ''` and fully-qualified names
--   * derives identity from auth.uid() and accepts no caller-supplied identity
--   * validates role and yard scope explicitly before doing anything
--   * writes an audit row for every state change
--   * makes no network call inside its transaction
-- ---------------------------------------------------------------------------

-- Resolves and asserts the calling driver, returning their profile row.
create or replace function app.require_driver()
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.profiles;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into p from public.profiles where id = auth.uid();

  if not found or not p.is_active then
    raise exception 'profile not found or inactive' using errcode = '28000';
  end if;
  if p.role <> 'DRIVER' then
    raise exception 'this operation requires the DRIVER role'
      using errcode = 'insufficient_privilege';
  end if;
  return p;
end;
$$;

create or replace function app.require_manager()
returns public.profiles
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  p public.profiles;
begin
  if auth.uid() is null then
    raise exception 'authentication required' using errcode = '28000';
  end if;
  select * into p from public.profiles where id = auth.uid();
  if not found or not p.is_active then
    raise exception 'profile not found or inactive' using errcode = '28000';
  end if;
  if p.role not in ('MANAGER', 'ADMIN') then
    raise exception 'this operation requires MANAGER or ADMIN'
      using errcode = 'insufficient_privilege';
  end if;
  return p;
end;
$$;

create or replace function app.user_has_yard(p_user uuid, p_yard uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.user_yards uy where uy.user_id = p_user and uy.yard_id = p_yard
  ) or exists (
    select 1 from public.profiles p
      join public.yards y on y.org_id = p.org_id
     where p.id = p_user and p.role = 'ADMIN' and y.id = p_yard
  )
$$;

-- ---------------------------------------------------------------------------
-- Device approval
-- ---------------------------------------------------------------------------
create or replace function public.approve_device(p_device_id uuid)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr public.profiles := app.require_manager();
  d   public.devices;
begin
  select * into d from public.devices where id = p_device_id for update;
  if not found then
    raise exception 'device not found' using errcode = 'no_data_found';
  end if;

  -- The device's owner must share a yard with the approving manager.
  if not exists (
    select 1 from public.user_yards uy
     where uy.user_id = d.user_id
       and (mgr.role = 'ADMIN' or uy.yard_id in (
              select uy2.yard_id from public.user_yards uy2 where uy2.user_id = mgr.id))
  ) then
    raise exception 'device owner is outside your yards'
      using errcode = 'insufficient_privilege';
  end if;

  update public.devices
     set status = 'APPROVED', approved_by = mgr.id, approved_at = now()
   where id = p_device_id
  returning * into d;

  perform app.audit('device.approved', 'device', d.id, null,
                    to_jsonb(d) - 'user_agent', null, mgr.org_id, null);
  return d;
end;
$$;

create or replace function public.revoke_device(p_device_id uuid, p_reason text)
returns public.devices
language plpgsql
security definer
set search_path = ''
as $$
declare
  mgr public.profiles := app.require_manager();
  d   public.devices;
begin
  update public.devices
     set status = 'REVOKED', revoked_by = mgr.id, revoked_at = now()
   where id = p_device_id
  returning * into d;

  if not found then
    raise exception 'device not found' using errcode = 'no_data_found';
  end if;

  perform app.audit('device.revoked', 'device', d.id, null,
                    jsonb_build_object('reason', p_reason), null, mgr.org_id, null);
  return d;
end;
$$;

-- ---------------------------------------------------------------------------
-- Claiming an assignment
--
-- Advisory only: a claim reserves a task in the UI so two drivers do not walk
-- to the same vehicle. It grants nothing. Completion is still decided by
-- verify_movement, which is what makes an offline claim safe to lose.
-- ---------------------------------------------------------------------------
create or replace function public.claim_assignment(p_assignment_id uuid)
returns public.vehicle_assignments
language plpgsql
security definer
set search_path = ''
as $$
declare
  drv public.profiles := app.require_driver();
  a   public.vehicle_assignments;
  m   public.manifests;
begin
  select * into a from public.vehicle_assignments where id = p_assignment_id for update;
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
  if a.status in ('COMPLETED', 'CANCELLED') then
    raise exception 'assignment is already %', a.status using errcode = 'check_violation';
  end if;
  if a.claimed_by is not null and a.claimed_by <> drv.id and a.status = 'IN_PROGRESS' then
    raise exception 'assignment is already claimed by another driver'
      using errcode = 'check_violation';
  end if;

  update public.vehicle_assignments
     set status = 'IN_PROGRESS', claimed_by = drv.id, claimed_at = now(), updated_at = now()
   where id = p_assignment_id
  returning * into a;

  perform app.audit('assignment.claimed', 'vehicle_assignment', a.id, null,
                    jsonb_build_object('driver_id', drv.id), null, drv.org_id, m.yard_id);
  return a;
end;
$$;

-- ---------------------------------------------------------------------------
-- Recording a single scan attempt (container or chassis).
--
-- The EXPECTED values are read from the manifest here, server-side. The client
-- supplies only what it scanned. A client that could supply the expected value
-- could make any scan pass.
-- ---------------------------------------------------------------------------
create or replace function public.record_scan_attempt(
  p_attempt_id      uuid,
  p_assignment_id   uuid,
  p_kind            attempt_kind,
  p_scanned_value   text,
  p_image_path      text,
  p_image_sha256    text,
  p_image_phash     text default null,
  p_ocr_text_raw    text default null,
  p_ocr_confidence  real default null,
  p_ocr_engine      text default null,
  p_value_source    value_source default 'OCR_AUTO',
  p_device_key      text default null,
  p_gps_lat         double precision default null,
  p_gps_lng         double precision default null,
  p_gps_accuracy_m  real default null,
  p_gps_denied      boolean default false,
  p_attempted_at_device timestamptz default now(),
  p_app_version     text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  drv       public.profiles := app.require_driver();
  a         public.vehicle_assignments;
  c         public.containers;
  m         public.manifests;
  dev       public.devices;
  settings  public.org_settings;
  v_scanned text;
  v_expected text;
  v_min_conf real;
  v_result  public.attempt_result;
  v_existing public.verification_attempts;
begin
  if p_kind = 'FINAL' then
    raise exception 'FINAL attempts are written by verify_movement only'
      using errcode = 'check_violation';
  end if;

  -- Idempotent on the client-generated attempt id.
  select * into v_existing from public.verification_attempts where id = p_attempt_id;
  if found then
    if v_existing.driver_id <> drv.id then
      raise exception 'attempt id belongs to another driver' using errcode = 'insufficient_privilege';
    end if;
    return jsonb_build_object('attempt_id', v_existing.id, 'result', v_existing.result,
                              'replayed', true);
  end if;

  select * into a from public.vehicle_assignments where id = p_assignment_id;
  if not found then
    raise exception 'assignment not found' using errcode = 'no_data_found';
  end if;
  select * into c from public.containers where id = a.container_id;
  select * into m from public.manifests where id = a.manifest_id;

  if not app.user_has_yard(drv.id, m.yard_id) then
    raise exception 'assignment is outside your yards' using errcode = 'insufficient_privilege';
  end if;

  select * into settings from public.org_settings where org_id = drv.org_id;

  if p_device_key is not null then
    select * into dev from public.devices
     where user_id = drv.id and device_key = p_device_key;
  end if;

  v_scanned  := app.normalize_code(p_scanned_value);

  -- Hoisted out of the IF chain below: plpgsql terminates an ELSIF expression
  -- at the first THEN keyword, so an inline CASE cannot appear in one.
  if p_kind = 'CONTAINER' then
    v_expected := app.normalize_code(c.container_no);
    v_min_conf := coalesce(settings.container_min_confidence, 0.70);
  else
    v_expected := app.normalize_code(a.chassis_no);
    v_min_conf := coalesce(settings.chassis_min_confidence, 0.85);
  end if;

  -- Grade the attempt. This is advisory record-keeping: the authoritative
  -- comparison happens again inside verify_movement.
  if v_scanned is null then
    v_result := 'FAIL_OCR';
  elsif p_kind = 'CONTAINER'
        and app.is_iso6346_shaped(v_expected)
        and not app.is_valid_container_no(v_scanned) then
    -- Only meaningful when the yard actually uses ISO 6346 numbers. See
    -- app.is_iso6346_shaped().
    v_result := 'FAIL_CHECK_DIGIT';
  elsif p_ocr_confidence is not null
        and p_value_source in ('OCR_AUTO', 'OCR_CONFIRMED')
        and p_ocr_confidence < v_min_conf then
    v_result := 'FAIL_LOW_CONFIDENCE';
  elsif v_scanned <> v_expected then
    v_result := 'FAIL_MISMATCH';
  else
    v_result := 'PASS';
  end if;

  insert into public.verification_attempts (
    id, org_id, yard_id, manifest_id, assignment_id, driver_id, device_id,
    kind, result,
    expected_container_no, expected_chassis_no,
    scanned_container_no, scanned_chassis_no,
    ocr_text_raw, ocr_confidence, ocr_engine, value_source,
    container_image_path, container_image_sha256,
    chassis_image_path, chassis_image_sha256, image_phash,
    gps_lat, gps_lng, gps_accuracy_m, gps_denied,
    attempted_at_device, app_version
  ) values (
    p_attempt_id, drv.org_id, m.yard_id, m.id, a.id, drv.id, dev.id,
    p_kind, v_result,
    app.normalize_code(c.container_no), app.normalize_code(a.chassis_no),
    case when p_kind = 'CONTAINER' then v_scanned end,
    case when p_kind = 'CHASSIS'   then v_scanned end,
    p_ocr_text_raw, p_ocr_confidence, p_ocr_engine, p_value_source,
    case when p_kind = 'CONTAINER' then p_image_path end,
    case when p_kind = 'CONTAINER' then p_image_sha256 end,
    case when p_kind = 'CHASSIS'   then p_image_path end,
    case when p_kind = 'CHASSIS'   then p_image_sha256 end,
    p_image_phash,
    p_gps_lat, p_gps_lng, p_gps_accuracy_m, p_gps_denied,
    p_attempted_at_device, p_app_version
  );

  perform app.audit(
    case when v_result = 'PASS' then 'scan.passed' else 'scan.failed' end,
    'verification_attempt', p_attempt_id, null,
    jsonb_build_object('kind', p_kind, 'result', v_result, 'source', p_value_source),
    null, drv.org_id, m.yard_id);

  return jsonb_build_object(
    'attempt_id', p_attempt_id,
    'result', v_result,
    'expected', v_expected,
    'scanned', v_scanned,
    'replayed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- verify_movement — the authoritative decision.
--
-- A movement may be completed ONLY when all of these hold:
--   1. the assignment belongs to the currently PUBLISHED manifest
--   2. the caller is an active DRIVER assigned to that yard
--   3. the driver's device is approved (when the org requires it)
--   4. the assignment is active and not already completed
--   5. the scanned container equals the expected container after safe
--      normalisation
--   6. the scanned chassis equals the expected chassis after safe
--      normalisation
--   7. the required evidence exists
--   8. the container is not already at capacity
--
-- The client's own verdict is accepted as a parameter and STORED, never used
-- as an input to the decision. A disagreement between the two is itself a
-- recorded signal.
-- ---------------------------------------------------------------------------
create or replace function public.verify_movement(
  p_movement_id          uuid,
  p_assignment_id        uuid,
  p_scanned_container_no text,
  p_scanned_chassis_no   text,
  p_container_attempt_id uuid default null,
  p_chassis_attempt_id   uuid default null,
  p_final_attempt_id     uuid default null,
  p_device_key           text default null,
  p_client_outcome       verification_outcome default null,
  p_gps_lat              double precision default null,
  p_gps_lng              double precision default null,
  p_gps_accuracy_m       real default null,
  p_gps_denied           boolean default false,
  p_completed_at_device  timestamptz default now(),
  p_app_version          text default null,
  -- false runs the identical decision without recording the movement, so the
  -- driver can see VERIFIED before asserting the vehicle has physically been
  -- moved. A block is recorded either way: a blocked attempt is evidence.
  p_commit               boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  drv         public.profiles;
  a           public.vehicle_assignments;
  c           public.containers;
  m           public.manifests;
  dev         public.devices;
  settings    public.org_settings;
  existing    public.movement_events;
  v_container text;
  v_chassis   text;
  v_exp_container text;
  v_exp_chassis   text;
  v_outcome   public.verification_outcome;
  v_result    public.attempt_result;
  v_filled    int;
  v_other     record;
  v_detail    jsonb := '{}'::jsonb;
  v_final_id  uuid := coalesce(p_final_attempt_id, public.gen_random_uuid());
  v_exception_id uuid;
  v_movement  public.movement_events;
begin
  drv := app.require_driver();

  ------------------------------------------------------------------ idempotency
  -- Replaying the same movement id returns the original outcome and changes
  -- nothing. Replaying it with DIFFERENT scanned values is not a retry.
  select * into existing from public.movement_events where id = p_movement_id;
  if found then
    if existing.driver_id <> drv.id then
      raise exception 'movement id belongs to another driver'
        using errcode = 'insufficient_privilege';
    end if;
    if app.normalize_code(existing.scanned_container_no)
         is distinct from app.normalize_code(p_scanned_container_no)
       or app.normalize_code(existing.scanned_chassis_no)
         is distinct from app.normalize_code(p_scanned_chassis_no) then
      -- Same movement id, different values. Not a retry: either a client bug
      -- or an attempt to overwrite a recorded outcome. Record it and refuse.
      --
      -- Deliberately RETURNS rather than RAISEs. Raising would abort the
      -- transaction and discard the very exception row that makes this
      -- visible, which is the opposite of what a conflict this serious needs.
      insert into public.exceptions (org_id, yard_id, manifest_id, assignment_id,
                                     movement_id, type, severity, description, raised_by,
                                     expected_value, actual_value)
      values (existing.org_id, existing.yard_id, existing.manifest_id,
              existing.assignment_id, existing.id, 'SYNC_ISSUE', 1,
              'Movement id resubmitted with different scanned values', drv.id,
              existing.scanned_container_no || ' / ' || existing.scanned_chassis_no,
              coalesce(p_scanned_container_no, '?') || ' / '
                || coalesce(p_scanned_chassis_no, '?'))
      returning id into v_exception_id;

      perform app.audit('movement.replay_conflict', 'movement_event', existing.id, null,
        jsonb_build_object(
          'recorded_container', existing.scanned_container_no,
          'recorded_chassis', existing.scanned_chassis_no,
          'resubmitted_container', p_scanned_container_no,
          'resubmitted_chassis', p_scanned_chassis_no,
          'exception_id', v_exception_id),
        null, existing.org_id, existing.yard_id);

      return jsonb_build_object(
        'outcome', 'REPLAY_CONFLICT',
        'status', 'BLOCKED',
        'movement_id', existing.id,
        'exception_id', v_exception_id,
        'replayed', true);
    end if;
    return jsonb_build_object('outcome', 'MATCH', 'status', existing.status,
                              'movement_id', existing.id, 'replayed', true);
  end if;

  ------------------------------------------------------------------- load state
  select * into a from public.vehicle_assignments where id = p_assignment_id;
  if not found then
    raise exception 'assignment not found' using errcode = 'no_data_found';
  end if;
  select * into m from public.manifests where id = a.manifest_id;
  select * into settings from public.org_settings where org_id = drv.org_id;

  -- Lock the container for the whole decision. Without this, two drivers
  -- scanning the last slot of the same container within the same second both
  -- read the same fill count and both succeed. That is not theoretical; it is
  -- a busy yard at shift change.
  select * into c from public.containers where id = a.container_id for update;

  v_exp_container := app.normalize_code(c.container_no);
  v_exp_chassis   := app.normalize_code(a.chassis_no);
  v_container     := app.normalize_code(p_scanned_container_no);
  v_chassis       := app.normalize_code(p_scanned_chassis_no);

  if p_device_key is not null then
    select * into dev from public.devices
     where user_id = drv.id and device_key = p_device_key;
  end if;

  --------------------------------------------------------------- the decision
  -- Evaluated in order; first hit wins. The order is part of the
  -- specification: a movement that is both CONTAINER_FULL and WRONG_VEHICLE
  -- reports WRONG_VEHICLE, because that is the more serious and more
  -- actionable fact.
  if m.status <> 'PUBLISHED' then
    -- Two very different situations reach here, and the driver's next move is
    -- different for each. A manifest that was REPLACED means the phone is
    -- working from a cached version — the fix is to sync, and it is the normal
    -- outcome of a manager correcting the day's plan while a driver is out of
    -- signal. Any other non-published state is a manifest problem the driver
    -- cannot fix alone. Reporting both as MANIFEST_NOT_PUBLISHED sent everyone
    -- to the office for what a pull-to-refresh would have solved.
    if exists (select 1 from public.manifests newer
                where newer.yard_id = m.yard_id
                  and newer.operating_date = m.operating_date
                  and newer.status = 'PUBLISHED'
                  and newer.version > m.version) then
      v_outcome := 'MANIFEST_SUPERSEDED';
    else
      v_outcome := 'MANIFEST_NOT_PUBLISHED';
    end if;

  elsif not app.user_has_yard(drv.id, m.yard_id) then
    v_outcome := 'DRIVER_NOT_AUTHORISED';

  elsif coalesce(settings.require_device_approval, true)
        and (dev.id is null or dev.status <> 'APPROVED') then
    v_outcome := 'DEVICE_NOT_APPROVED';

  elsif a.status = 'CANCELLED' then
    v_outcome := 'ASSIGNMENT_NOT_ACTIVE';

  elsif exists (select 1 from public.movement_events me
                 where me.assignment_id = a.id
                   and me.status in ('COMPLETED', 'OVERRIDDEN')) then
    v_outcome := 'ALREADY_COMPLETED';

  elsif exists (
      select 1
        from public.vehicle_assignments earlier
       where earlier.container_id = c.id
         and earlier.sequence_no < a.sequence_no
         and earlier.status not in ('COMPLETED', 'CANCELLED', 'EXCEPTION')
         and not exists (select 1 from public.movement_events me2
                          where me2.assignment_id = earlier.id
                            and me2.status in ('COMPLETED', 'OVERRIDDEN'))
    ) then
    -- Slots are filled in order: where a vehicle sits inside a container is
    -- not arbitrary. A driver who genuinely cannot take the earlier vehicle
    -- raises an exception, which parks that assignment and opens this one.
    -- That is the manager-authorised skip, and it leaves a record.
    v_outcome := 'OUT_OF_SEQUENCE';

  elsif v_container is null or v_chassis is null
        or p_container_attempt_id is null or p_chassis_attempt_id is null
        or not exists (select 1 from public.verification_attempts va
                        where va.id = p_container_attempt_id
                          and va.assignment_id = a.id
                          and va.driver_id = drv.id
                          and va.kind = 'CONTAINER'
                          and va.container_image_path is not null)
        or not exists (select 1 from public.verification_attempts va
                        where va.id = p_chassis_attempt_id
                          and va.assignment_id = a.id
                          and va.driver_id = drv.id
                          and va.kind = 'CHASSIS'
                          and va.chassis_image_path is not null) then
    v_outcome := 'EVIDENCE_MISSING';

  elsif v_container <> v_exp_container then
    -- Is it a real container on this manifest, just not this vehicle's?
    select ct.container_no into v_other
      from public.containers ct
     where ct.manifest_id = m.id
       and app.normalize_code(ct.container_no) = v_container;
    if found then
      v_outcome := 'WRONG_CONTAINER';
      v_detail := jsonb_build_object('scanned_container_belongs_to_manifest', true);
    else
      v_outcome := 'CONTAINER_NOT_ON_MANIFEST';
    end if;

  elsif v_chassis <> v_exp_chassis then
    -- The core case: the scanned vehicle is assigned somewhere else.
    select va2.id as assignment_id, ct2.container_no, ct2.bay_position
      into v_other
      from public.vehicle_assignments va2
      join public.containers ct2 on ct2.id = va2.container_id
     where va2.manifest_id = m.id
       and va2.status <> 'CANCELLED'
       and app.normalize_code(va2.chassis_no) = v_chassis;
    if found then
      v_outcome := 'WRONG_VEHICLE';
      v_detail := jsonb_build_object(
        'scanned_vehicle_belongs_to_container', v_other.container_no,
        'bay_position', v_other.bay_position);
    else
      v_outcome := 'CHASSIS_NOT_ON_MANIFEST';
    end if;

  else
    select count(*) into v_filled
      from public.movement_events me
      join public.vehicle_assignments va3 on va3.id = me.assignment_id
     where va3.container_id = c.id
       and me.status in ('COMPLETED', 'OVERRIDDEN');

    if v_filled >= c.expected_vehicle_count then
      v_outcome := 'CONTAINER_FULL';
      v_detail := jsonb_build_object('filled', v_filled,
                                     'capacity', c.expected_vehicle_count);
    else
      v_outcome := 'MATCH';
    end if;
  end if;

  v_result := case when v_outcome = 'MATCH' then 'PASS'
                   when v_outcome in ('WRONG_CONTAINER','WRONG_VEHICLE',
                                      'CHASSIS_NOT_ON_MANIFEST','CONTAINER_NOT_ON_MANIFEST')
                        then 'FAIL_MISMATCH'
                   else 'FAIL_RULE' end;

  ------------------------------------------------------- record the attempt
  -- Every failure is recorded, because a blocked attempt is evidence. A
  -- passing non-committing check is not: it would double the attempt rows for
  -- every successful movement and tell the audit nothing new.
  if v_outcome <> 'MATCH' or p_commit then
  insert into public.verification_attempts (
    id, org_id, yard_id, manifest_id, assignment_id, driver_id, device_id,
    kind, result, outcome,
    expected_container_no, expected_chassis_no,
    scanned_container_no, scanned_chassis_no,
    client_outcome, gps_lat, gps_lng, gps_accuracy_m, gps_denied,
    attempted_at_device, app_version
  ) values (
    v_final_id, drv.org_id, m.yard_id, m.id, a.id, drv.id, dev.id,
    'FINAL', v_result, v_outcome,
    v_exp_container, v_exp_chassis, v_container, v_chassis,
    p_client_outcome, p_gps_lat, p_gps_lng, p_gps_accuracy_m, p_gps_denied,
    p_completed_at_device, p_app_version
  );
  end if;

  ------------------------------------------------------------------ on failure
  if v_outcome <> 'MATCH' then
    insert into public.exceptions (
      org_id, yard_id, manifest_id, assignment_id, attempt_id,
      type, severity, expected_value, actual_value, description, raised_by
    ) values (
      drv.org_id, m.yard_id, m.id, a.id, v_final_id,
      case v_outcome
        when 'WRONG_VEHICLE'             then 'WRONG_VEHICLE'::public.exception_type
        when 'WRONG_CONTAINER'           then 'WRONG_CONTAINER'::public.exception_type
        when 'CHASSIS_NOT_ON_MANIFEST'   then 'CHASSIS_MISMATCH'::public.exception_type
        when 'CONTAINER_NOT_ON_MANIFEST' then 'CONTAINER_MISMATCH'::public.exception_type
        when 'CONTAINER_FULL'            then 'CONTAINER_FULL'::public.exception_type
        when 'ALREADY_COMPLETED'         then 'ALREADY_COMPLETED'::public.exception_type
        when 'DEVICE_NOT_APPROVED'       then 'DEVICE_UNAPPROVED'::public.exception_type
        when 'MANIFEST_NOT_PUBLISHED'    then 'MANIFEST_ERROR'::public.exception_type
        when 'MANIFEST_SUPERSEDED'       then 'MANIFEST_CONFLICT'::public.exception_type
        when 'OUT_OF_SEQUENCE'           then 'OTHER'::public.exception_type
        else 'OTHER'::public.exception_type
      end,
      case when v_outcome in ('WRONG_VEHICLE', 'WRONG_CONTAINER') then 1 else 2 end,
      v_exp_container || ' / ' || v_exp_chassis,
      coalesce(v_container, '?') || ' / ' || coalesce(v_chassis, '?'),
      'Blocked by server verification: ' || v_outcome,
      drv.id
    ) returning id into v_exception_id;

    -- CANCELLED is excluded as well as COMPLETED. A withdrawn vehicle that a
    -- driver then scans would otherwise be quietly moved back into the day's
    -- work as an EXCEPTION — a state a manager can resolve back into service.
    -- It also re-occupies the chassis in the uniqueness index, so the corrected
    -- assignment that was supposed to replace it can no longer be created. The
    -- block is still recorded; what must not change is the fact that ops took
    -- this vehicle off the manifest.
    update public.vehicle_assignments
       set status = 'EXCEPTION', updated_at = now()
     where id = a.id and status not in ('COMPLETED', 'CANCELLED');

    perform app.audit('movement.blocked', 'vehicle_assignment', a.id, null,
      jsonb_build_object('outcome', v_outcome, 'attempt_id', v_final_id,
                         'exception_id', v_exception_id,
                         'client_outcome', p_client_outcome,
                         'client_agreed', p_client_outcome is not distinct from v_outcome),
      jsonb_build_object('device_key', p_device_key, 'app_version', p_app_version),
      drv.org_id, m.yard_id);

    return jsonb_build_object(
      'outcome', v_outcome,
      'status', 'BLOCKED',
      'movement_id', null,
      'attempt_id', v_final_id,
      'exception_id', v_exception_id,
      'expected_container_no', v_exp_container,
      'expected_chassis_no', v_exp_chassis,
      'scanned_container_no', v_container,
      'scanned_chassis_no', v_chassis,
      'detail', v_detail,
      'replayed', false
    );
  end if;

  ------------------------------------------------- a check that has not committed
  if not p_commit then
    select count(*) into v_filled
      from public.movement_events me
      join public.vehicle_assignments va5 on va5.id = me.assignment_id
     where va5.container_id = c.id and me.status in ('COMPLETED', 'OVERRIDDEN');

    return jsonb_build_object(
      'outcome', 'MATCH',
      'status', 'READY_TO_CONFIRM',
      'movement_id', null,
      'container_no', v_exp_container,
      'chassis_no', v_exp_chassis,
      'container_filled', v_filled,
      'container_capacity', c.expected_vehicle_count,
      'replayed', false
    );
  end if;

  ------------------------------------------------------------------ on success
  insert into public.movement_events (
    id, org_id, yard_id, manifest_id, container_id, assignment_id,
    driver_id, device_id, status,
    expected_container_no, expected_chassis_no,
    scanned_container_no, scanned_chassis_no,
    container_attempt_id, chassis_attempt_id, final_attempt_id,
    gps_lat, gps_lng, gps_accuracy_m,
    completed_at_device, app_version
  ) values (
    p_movement_id, drv.org_id, m.yard_id, m.id, c.id, a.id,
    drv.id, dev.id, 'COMPLETED',
    v_exp_container, v_exp_chassis, v_container, v_chassis,
    p_container_attempt_id, p_chassis_attempt_id, v_final_id,
    p_gps_lat, p_gps_lng, p_gps_accuracy_m,
    p_completed_at_device, p_app_version
  ) returning * into v_movement;

  update public.vehicle_assignments
     set status = 'COMPLETED', updated_at = now()
   where id = a.id;

  perform app.audit('movement.verified', 'movement_event', v_movement.id, null,
    jsonb_build_object('assignment_id', a.id, 'container_no', v_exp_container,
                       'chassis_no', v_exp_chassis, 'driver_id', drv.id,
                       'client_outcome', p_client_outcome,
                       'client_agreed', p_client_outcome is not distinct from v_outcome),
    jsonb_build_object('device_key', p_device_key, 'app_version', p_app_version),
    drv.org_id, m.yard_id);

  select count(*) into v_filled
    from public.movement_events me
    join public.vehicle_assignments va4 on va4.id = me.assignment_id
   where va4.container_id = c.id and me.status in ('COMPLETED', 'OVERRIDDEN');

  return jsonb_build_object(
    'outcome', 'MATCH',
    'status', 'COMPLETED',
    'movement_id', v_movement.id,
    'attempt_id', v_final_id,
    'container_no', v_exp_container,
    'chassis_no', v_exp_chassis,
    'container_filled', v_filled,
    'container_capacity', c.expected_vehicle_count,
    'replayed', false
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants. Nothing here is executable by anon.
-- ---------------------------------------------------------------------------
revoke all on function public.approve_device(uuid) from public;
revoke all on function public.revoke_device(uuid, text) from public;
revoke all on function public.claim_assignment(uuid) from public;
revoke all on function public.record_scan_attempt(
  uuid, uuid, attempt_kind, text, text, text, text, text, real, text, value_source,
  text, double precision, double precision, real, boolean, timestamptz, text) from public;
revoke all on function public.verify_movement(
  uuid, uuid, text, text, uuid, uuid, uuid, text, verification_outcome,
  double precision, double precision, real, boolean, timestamptz, text,
  boolean) from public;

grant execute on function public.approve_device(uuid) to authenticated;
grant execute on function public.revoke_device(uuid, text) to authenticated;
grant execute on function public.claim_assignment(uuid) to authenticated;
grant execute on function public.record_scan_attempt(
  uuid, uuid, attempt_kind, text, text, text, text, text, real, text, value_source,
  text, double precision, double precision, real, boolean, timestamptz, text) to authenticated;
grant execute on function public.verify_movement(
  uuid, uuid, text, text, uuid, uuid, uuid, text, verification_outcome,
  double precision, double precision, real, boolean, timestamptz, text,
  boolean) to authenticated;
