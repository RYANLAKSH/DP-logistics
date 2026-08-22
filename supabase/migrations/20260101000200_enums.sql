-- ---------------------------------------------------------------------------
-- Status enums.
--
-- Enums rather than text + CHECK because an invalid status must be impossible,
-- not merely rejected, and because adding a value is a reviewable migration
-- rather than a string appearing somewhere in application code.
-- ---------------------------------------------------------------------------

-- Role vocabulary per the build plan. MANAGER carries yard-supervisor
-- authority; ADMIN carries organisation-wide authority including audit.
create type user_role as enum ('ADMIN', 'MANAGER', 'DRIVER');

create type manifest_status as enum (
  'DRAFT',              -- created, not yet validated
  'VALIDATION_FAILED',  -- parsed, errors present, cannot be published
  'READY',              -- validated clean, awaiting a manager's decision
  'PUBLISHED',          -- live. At most one per (yard, operating_date)
  'ARCHIVED'            -- superseded by a later version, or retired
);

create type assignment_status as enum (
  'PENDING',
  'IN_PROGRESS',
  'COMPLETED',
  'EXCEPTION',
  'CANCELLED'
);

create type movement_status as enum (
  'COMPLETED',   -- verified by the server against the manifest
  'OVERRIDDEN',  -- completed under an authorised manager override
  'REVERSED'     -- reversed by a manager; the original row is retained
);

-- What a single verification attempt was trying to prove.
create type attempt_kind as enum ('CONTAINER', 'CHASSIS', 'FINAL');

create type attempt_result as enum (
  'PASS',
  'FAIL_MISMATCH',        -- read a value; it is not the expected one
  'FAIL_OCR',             -- OCR produced nothing usable
  'FAIL_LOW_CONFIDENCE',  -- read something, below threshold
  'FAIL_CHECK_DIGIT',     -- container number failed ISO 6346
  'FAIL_RULE'             -- a business rule rejected it (already completed, etc.)
);

-- Why a FINAL verification was refused. Mirrors docs/design/07 section 2.
create type verification_outcome as enum (
  'MATCH',
  'WRONG_CONTAINER',
  -- There is deliberately no WRONG_CHASSIS. A scanned chassis is either on the
  -- manifest against a different container (WRONG_VEHICLE) or on no line at
  -- all (CHASSIS_NOT_ON_MANIFEST); one chassis belongs to exactly one
  -- container, so there is no third case for a value to name. It existed, the
  -- engine could never return it, and an unreachable outcome is an invitation
  -- to write a branch that contradicts the rule.
  'WRONG_VEHICLE',            -- chassis belongs to a different container
  'CHASSIS_NOT_ON_MANIFEST',
  'CONTAINER_NOT_ON_MANIFEST',
  'ALREADY_COMPLETED',
  'CONTAINER_FULL',
  'ASSIGNMENT_NOT_ACTIVE',
  'MANIFEST_NOT_PUBLISHED',
  'MANIFEST_SUPERSEDED',
  'DRIVER_NOT_AUTHORISED',
  'DEVICE_NOT_APPROVED',
  'EVIDENCE_MISSING',
  'REPLAY_CONFLICT',          -- same movement id resubmitted with different values
  'OUT_OF_SEQUENCE'           -- an earlier slot in this container is still open
);

create type exception_type as enum (
  'CONTAINER_MISMATCH',
  'CHASSIS_MISMATCH',
  'OCR_FAILURE',
  'WRONG_VEHICLE',
  'WRONG_CONTAINER',
  'VEHICLE_UNAVAILABLE',
  'DAMAGED_CHASSIS_MARKING',
  'DAMAGED_CONTAINER_MARKING',
  'MISSING_VEHICLE',
  'CONTAINER_FULL',
  'ALREADY_COMPLETED',
  'SYNC_ISSUE',
  'MANIFEST_ERROR',
  'MANIFEST_CONFLICT',
  'DEVICE_UNAPPROVED',
  'OTHER'
);

create type exception_status as enum ('OPEN', 'UNDER_REVIEW', 'RESOLVED', 'CANCELLED');

create type exception_resolution as enum (
  'CORRECTED_AND_RESCANNED',
  'MANIFEST_AMENDED',
  'OVERRIDE_APPROVED',
  'MANUAL_ENTRY_AUTHORISED',
  'TASK_REASSIGNED',
  'VEHICLE_RESCHEDULED',
  'NO_ACTION_REQUIRED',
  'FALSE_ALARM'
);

create type override_reason as enum (
  'LAST_MINUTE_SUBSTITUTION',
  'MANIFEST_ERROR',
  'DAMAGED_PLATE',
  'OPERATIONAL_EXCEPTION',
  'OTHER'
);

-- How a value reached the system. Distinguishing these permanently is what
-- makes "the driver typed it" auditable years later.
create type value_source as enum (
  'OCR_AUTO',           -- OCR read it, matched, driver confirmed
  'OCR_CONFIRMED',      -- OCR proposed, driver accepted an imperfect read
  'MANUAL_ENTRY',       -- driver typed it
  'MANUAL_AUTHORISED'   -- driver typed it under a manager's explicit authorisation
);

create type import_status as enum ('PARSING', 'READY', 'COMMITTED', 'FAILED', 'DISCARDED');

create type device_status as enum ('PENDING', 'APPROVED', 'REVOKED');
