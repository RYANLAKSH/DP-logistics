-- ---------------------------------------------------------------------------
-- Device binding off by default: a driver signs in with an email and password,
-- and that is the whole of it.
--
-- Why this migration exists rather than an edit to 20260101000300_identity.sql:
-- that file has already been applied to a real project, so changing it there
-- would leave the deployed database saying `true` while the repository says
-- `false` — the migration would never re-run to correct it. A new migration is
-- the only form of this change that reaches a database that already exists.
--
-- What is being given up, stated plainly: with binding on, a driver's password
-- is not enough on its own — the movement must also come from a handset an
-- approved manager recognised. Off, anyone holding the password can complete
-- movements from any device. That is an accepted trade here, not an oversight.
--
-- What is NOT being removed: verify_movement and record_scan_attempt still
-- accept p_device_key and still refuse an unapproved device when the setting
-- is on, and 40_verification.sql still proves it. Turning binding back on is
-- one UPDATE — but note it is not usable until the client actually sends a
-- device key and something creates the device row, neither of which exists
-- today. See the note in supabase/bootstrap.sql.
-- ---------------------------------------------------------------------------

alter table public.org_settings
  alter column require_device_approval set default false;

-- Existing organisations, including any already created against the old
-- default. Without this an already-deployed project keeps refusing every
-- movement with DEVICE_NOT_APPROVED, which is the exact problem being fixed.
update public.org_settings
   set require_device_approval = false,
       updated_at = now()
 where require_device_approval;
