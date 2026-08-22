-- ---------------------------------------------------------------------------
-- Evidence access.
--
-- Images live in a private bucket and are reached through short-lived signed
-- URLs. Every view is logged: in a dispute, "was this photograph seen by
-- anyone before it was produced?" is a real question, and access logging is
-- what makes chain of custody meaningful rather than rhetorical.
-- ---------------------------------------------------------------------------

-- Everything needed to render one movement's evidence, in one call.
create or replace function public.movement_evidence(p_movement_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer public.profiles;
  m      public.movement_events;
  result jsonb;
begin
  select * into viewer from public.profiles where id = auth.uid();
  if not found or not viewer.is_active then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into m from public.movement_events where id = p_movement_id;
  if not found then
    raise exception 'movement not found' using errcode = 'no_data_found';
  end if;

  -- A driver sees their own work. A manager sees their yards. An admin sees
  -- the organisation. Anyone else sees nothing, including the fact it exists.
  if not (
    (viewer.role = 'DRIVER' and m.driver_id = viewer.id)
    or (viewer.role in ('MANAGER', 'ADMIN')
        and m.org_id = viewer.org_id
        and app.user_has_yard(viewer.id, m.yard_id))
  ) then
    raise exception 'movement not found' using errcode = 'no_data_found';
  end if;

  select jsonb_build_object(
    'movement', jsonb_build_object(
      'id', m.id,
      'status', m.status,
      'yardId', m.yard_id,
      'expectedContainerNo', m.expected_container_no,
      'expectedChassisNo', m.expected_chassis_no,
      'scannedContainerNo', m.scanned_container_no,
      'scannedChassisNo', m.scanned_chassis_no,
      'verifiedAt', m.verified_at,
      'completedAtDevice', m.completed_at_device,
      'clockSkewSeconds', m.clock_skew_s,
      'gps', case when m.gps_lat is null then null else
        jsonb_build_object('lat', m.gps_lat, 'lng', m.gps_lng,
                           'accuracyM', m.gps_accuracy_m) end,
      'driverName', (select full_name from public.profiles where id = m.driver_id),
      'appVersion', m.app_version
    ),
    'attempts', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', va.id,
               'kind', va.kind,
               'result', va.result,
               'outcome', va.outcome,
               'valueSource', va.value_source,
               'ocrTextRaw', va.ocr_text_raw,
               'ocrConfidence', va.ocr_confidence,
               'ocrEngine', va.ocr_engine,
               'scannedContainerNo', va.scanned_container_no,
               'scannedChassisNo', va.scanned_chassis_no,
               'imagePath', coalesce(va.container_image_path, va.chassis_image_path),
               'imageSha256', coalesce(va.container_image_sha256, va.chassis_image_sha256),
               'gps', case when va.gps_lat is null then null else
                 jsonb_build_object('lat', va.gps_lat, 'lng', va.gps_lng,
                                    'accuracyM', va.gps_accuracy_m) end,
               'gpsDenied', va.gps_denied,
               'attemptedAtDevice', va.attempted_at_device,
               'receivedAt', va.received_at,
               'clockSkewSeconds', va.clock_skew_s
             ) order by va.created_at), '[]'::jsonb)
        from public.verification_attempts va
       where va.assignment_id = m.assignment_id
    )
  ) into result;

  perform app.audit('evidence.viewed', 'movement_event', m.id, null,
    jsonb_build_object('viewer_role', viewer.role), null, viewer.org_id, m.yard_id);

  return result;
end;
$$;

-- The same, for an exception that has no movement — a driver-reported problem
-- still has photographs attached to its attempts.
create or replace function public.exception_evidence(p_exception_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  viewer public.profiles;
  x      public.exceptions;
  result jsonb;
begin
  select * into viewer from public.profiles where id = auth.uid();
  if not found or not viewer.is_active then
    raise exception 'authentication required' using errcode = '28000';
  end if;

  select * into x from public.exceptions where id = p_exception_id;
  if not found then
    raise exception 'exception not found' using errcode = 'no_data_found';
  end if;
  if not (
    (viewer.role = 'DRIVER' and x.raised_by = viewer.id)
    or (viewer.role in ('MANAGER', 'ADMIN')
        and x.org_id = viewer.org_id
        and app.user_has_yard(viewer.id, x.yard_id))
  ) then
    raise exception 'exception not found' using errcode = 'no_data_found';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
           'id', va.id,
           'kind', va.kind,
           'result', va.result,
           'valueSource', va.value_source,
           'ocrTextRaw', va.ocr_text_raw,
           'ocrConfidence', va.ocr_confidence,
           'imagePath', coalesce(va.container_image_path, va.chassis_image_path),
           'imageSha256', coalesce(va.container_image_sha256, va.chassis_image_sha256),
           'gps', case when va.gps_lat is null then null else
             jsonb_build_object('lat', va.gps_lat, 'lng', va.gps_lng,
                                'accuracyM', va.gps_accuracy_m) end,
           'gpsDenied', va.gps_denied,
           'attemptedAtDevice', va.attempted_at_device
         ) order by va.created_at), '[]'::jsonb)
    into result
    from public.verification_attempts va
   where va.assignment_id = x.assignment_id
     and coalesce(va.container_image_path, va.chassis_image_path) is not null;

  perform app.audit('evidence.viewed', 'exception', x.id, null,
    jsonb_build_object('viewer_role', viewer.role), null, viewer.org_id, x.yard_id);

  return jsonb_build_object('attempts', result);
end;
$$;

revoke all on function public.movement_evidence(uuid) from public;
revoke all on function public.exception_evidence(uuid) from public;
grant execute on function public.movement_evidence(uuid) to authenticated;
grant execute on function public.exception_evidence(uuid) to authenticated;
