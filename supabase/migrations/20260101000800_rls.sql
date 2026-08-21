-- ---------------------------------------------------------------------------
-- Row level security.
--
-- The design rule: the front end has READ access, scoped by these policies,
-- and NO write access to anything that decides an outcome. Every such write is
-- a SECURITY DEFINER function with server-side preconditions.
--
-- Consequence, and the acceptance test for this file: delete every route guard
-- from the React application and no user gains a single row.
-- ---------------------------------------------------------------------------

-- Default deny. `force` so even a table owner is subject to policy.
do $$
declare t text;
begin
  foreach t in array array[
    'organizations','yards','profiles','user_yards','devices','org_settings',
    'manifest_imports','manifests','containers','vehicle_assignments',
    'manifest_corrections','verification_attempts','movement_events',
    'exceptions','overrides','sync_operations','audit_logs'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- anon gets nothing anywhere. It exists only to reach the auth endpoints.
revoke all on schema public from anon;
grant usage on schema public to authenticated;

-- ------------------------------ organisations ------------------------------
create policy org_read on organizations for select to authenticated
  using (id = app.current_org());

-- ---------------------------------- yards ----------------------------------
create policy yards_read on yards for select to authenticated
  using (org_id = app.current_org() and app.can_see_yard(id));

-- --------------------------------- profiles --------------------------------
-- A driver sees themselves and nobody else. A manager sees people who share
-- one of their yards. An admin sees the organisation.
create policy profiles_self_read on profiles for select to authenticated
  using (id = auth.uid());

create policy profiles_manager_read on profiles for select to authenticated
  using (
    app.current_role() = 'MANAGER'
    and org_id = app.current_org()
    and exists (
      select 1 from user_yards uy
       where uy.user_id = profiles.id
         and uy.yard_id = any (app.current_yards())
    )
  );

create policy profiles_admin_read on profiles for select to authenticated
  using (app.is_admin() and org_id = app.current_org());

-- No UPDATE policy at all. Role changes and deactivation go through
-- admin RPCs so they are audited and cannot be self-applied. A policy
-- permitting a user to update their own profile row without a column filter
-- is a self-service privilege escalation, and it is the first thing anyone
-- probing this system will try.

-- -------------------------------- user_yards -------------------------------
create policy user_yards_self_read on user_yards for select to authenticated
  using (user_id = auth.uid());

create policy user_yards_manager_read on user_yards for select to authenticated
  using (app.is_manager_or_admin() and app.can_see_yard(yard_id));

-- --------------------------------- devices ---------------------------------
create policy devices_self_read on devices for select to authenticated
  using (user_id = auth.uid());

create policy devices_manager_read on devices for select to authenticated
  using (
    app.is_manager_or_admin()
    and exists (
      select 1 from user_yards uy
       where uy.user_id = devices.user_id
         and app.can_see_yard(uy.yard_id)
    )
  );

-- A user may register their OWN device, and only in PENDING. Approval is a
-- manager action through an RPC; a device that could self-approve would make
-- the whole device-binding control decorative.
grant insert (user_id, device_key, label, user_agent, platform) on devices to authenticated;

create policy devices_self_register on devices for insert to authenticated
  with check (user_id = auth.uid() and status = 'PENDING');

-- ------------------------------- org_settings ------------------------------
-- Readable by everyone in the org: the driver client needs the OCR thresholds.
create policy settings_read on org_settings for select to authenticated
  using (org_id = app.current_org());

grant update (container_min_confidence, chassis_min_confidence, chassis_match_margin,
              require_device_approval, require_gps, evidence_retention_months,
              max_clock_skew_seconds, geofence_warn_metres, override_rate_alert_pct,
              updated_by, updated_at)
  on org_settings to authenticated;

create policy settings_admin_write on org_settings for update to authenticated
  using (app.is_admin() and org_id = app.current_org())
  with check (app.is_admin() and org_id = app.current_org());

-- ----------------------------- manifest_imports ----------------------------
create policy imports_read on manifest_imports for select to authenticated
  using (app.is_manager_or_admin() and app.can_see_yard(yard_id));

grant insert (org_id, yard_id, operating_date, file_name, file_path, file_sha256,
              file_bytes, column_map, uploaded_by) on manifest_imports to authenticated;

create policy imports_insert on manifest_imports for insert to authenticated
  with check (
    app.is_manager_or_admin()
    and org_id = app.current_org()
    and app.can_see_yard(yard_id)
    and uploaded_by = auth.uid()
  );

grant update (column_map, status) on manifest_imports to authenticated;

create policy imports_update on manifest_imports for update to authenticated
  using (app.is_manager_or_admin() and app.can_see_yard(yard_id)
         and status in ('PARSING', 'READY'))
  with check (app.is_manager_or_admin() and app.can_see_yard(yard_id)
              and status in ('PARSING', 'READY', 'DISCARDED'));

-- -------------------------------- manifests --------------------------------
-- A driver sees only PUBLISHED manifests for their assigned yards. They have
-- no business seeing drafts, superseded versions, or another yard's day.
create policy manifests_driver_read on manifests for select to authenticated
  using (app.is_driver() and status = 'PUBLISHED' and app.can_see_yard(yard_id));

create policy manifests_manager_read on manifests for select to authenticated
  using (app.is_manager_or_admin() and app.can_see_yard(yard_id));

-- No INSERT/UPDATE/DELETE policies. Publishing, archiving and correcting all
-- go through RPCs that version rather than mutate.

-- -------------------------- containers / assignments -----------------------
create policy containers_read on containers for select to authenticated
  using (exists (select 1 from manifests m where m.id = containers.manifest_id));

create policy assignments_read on vehicle_assignments for select to authenticated
  using (exists (select 1 from manifests m where m.id = vehicle_assignments.manifest_id));

-- Both delegate to the manifests policies above: a row is visible exactly when
-- its manifest is. RLS on `manifests` applies inside these subqueries because
-- the policy is evaluated as the invoking user.

-- ---------------------------- manifest_corrections -------------------------
create policy corrections_read on manifest_corrections for select to authenticated
  using (
    app.is_manager_or_admin()
    and exists (select 1 from manifests m where m.id = manifest_corrections.from_manifest_id)
  );

-- --------------------------- verification_attempts -------------------------
create policy attempts_driver_read on verification_attempts for select to authenticated
  using (app.is_driver() and driver_id = auth.uid());

create policy attempts_manager_read on verification_attempts for select to authenticated
  using (app.is_manager_or_admin() and app.can_see_yard(yard_id));

-- ------------------------------ movement_events ----------------------------
create policy movements_driver_read on movement_events for select to authenticated
  using (app.is_driver() and driver_id = auth.uid());

create policy movements_manager_read on movement_events for select to authenticated
  using (app.is_manager_or_admin() and app.can_see_yard(yard_id));

-- NO insert, update or delete policy on movement_events, for any role. Not a
-- restrictive one — none at all. PostgREST cannot write this table under any
-- circumstance. The only writer is verify_movement().

-- -------------------------------- exceptions -------------------------------
create policy exceptions_driver_read on exceptions for select to authenticated
  using (app.is_driver() and raised_by = auth.uid());

create policy exceptions_manager_read on exceptions for select to authenticated
  using (app.is_manager_or_admin() and app.can_see_yard(yard_id));

-- --------------------------------- overrides -------------------------------
create policy overrides_driver_read on overrides for select to authenticated
  using (app.is_driver() and requested_by = auth.uid());

create policy overrides_manager_read on overrides for select to authenticated
  using (
    app.is_manager_or_admin()
    and exists (
      select 1 from vehicle_assignments va
        join manifests m on m.id = va.manifest_id
       where va.id = overrides.assignment_id
         and app.can_see_yard(m.yard_id)
    )
  );

-- ----------------------------- sync_operations -----------------------------
create policy sync_driver_read on sync_operations for select to authenticated
  using (driver_id = auth.uid());

create policy sync_manager_read on sync_operations for select to authenticated
  using (app.is_manager_or_admin() and org_id = app.current_org());

-- -------------------------------- audit_logs -------------------------------
-- SELECT only, and never more. Writes come from app.audit() alone.
create policy audit_admin_read on audit_logs for select to authenticated
  using (app.is_admin() and org_id = app.current_org());

create policy audit_manager_read on audit_logs for select to authenticated
  using (
    app.current_role() = 'MANAGER'
    and org_id = app.current_org()
    and yard_id is not null
    and yard_id = any (app.current_yards())
  );
