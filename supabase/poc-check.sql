-- ---------------------------------------------------------------------------
-- PoC check: did the backend understand the manifest?
--
-- Run this in the Supabase dashboard SQL editor AFTER uploading and publishing
-- a pickup list through the app. It reads only — nothing here writes.
--
-- There is nothing to edit. Every check below works on the manifest published
-- most recently, which during a PoC is the one you just uploaded. No psql
-- variables are used, because the dashboard SQL editor does not support them.
--
-- The point is not "did the upload return 200". It is whether the rows the
-- database now holds match the sheet a human would read off the paper, and
-- whether the two rules the whole product rests on actually hold:
--
--     one chassis belongs to exactly one container
--     one container carries exactly two chassis
--
-- Read the `verdict` column. Note that for checks 3 and 4, ZERO ROWS is the
-- pass — they are written to return only problems, so an empty result is the
-- result you want. Each of those says so where it appears.
-- ---------------------------------------------------------------------------


-- ============================ 1 — which manifest ============================
-- Confirms the file you think you published is the one everything below reads,
-- and that it belongs to the yard and date you meant.

select
  y.code                as yard,
  m.operating_date,
  m.version,
  m.status,
  m.reference_no,
  m.published_at,
  m.total_containers    as containers_recorded,
  m.total_vehicles      as vehicles_recorded
from manifests m
join yards y on y.id = m.yard_id
where m.status = 'PUBLISHED'
order by m.published_at desc
limit 1;


-- ============================ 2 — the import itself =========================
-- What the parser made of the file, before anything was published. If
-- `rejected` is not zero, open the preview screen in the app: it names every
-- rejected row and the reason, which this cannot.

with target as (
  select m.import_id from manifests m
   where m.status = 'PUBLISHED' order by m.published_at desc limit 1
)
select
  i.file_name,
  i.status,
  i.row_count      as rows_read_from_file,
  i.valid_count    as accepted,
  i.rejected_count as rejected,
  -- COMMITTED is the status a published import ends in; READY means parsed
  -- but not yet published. Either is fine here — what matters is that the
  -- parser rejected nothing.
  case when i.status in ('READY', 'COMMITTED') and i.rejected_count = 0 then 'PASS'
       when i.rejected_count > 0 then 'ROWS WERE REJECTED — open the preview screen in the app'
       else 'UNEXPECTED IMPORT STATUS: ' || i.status end as verdict
from manifest_imports i
join target t on t.import_id = i.id;


-- ============================ 3 — carry-forward =============================
-- The pickup list writes the container number on the first vehicle's row and
-- leaves it blank on the second, expecting a human to read down the column.
-- Every vehicle must still have come out of the parser with a container.
--
-- Stated honestly: this one cannot fail on a healthy schema, because
-- vehicle_assignments.container_id is NOT NULL — a vehicle with no container
-- can never be written in the first place. It is here as an explicit assertion
-- of that, and because if it ever does return a row, something is wrong at a
-- level well below this file.
--
-- The carry-forward failure you can actually have is the parser rejecting the
-- blank row outright (check 2 shows it) or attributing it to the WRONG
-- container (only checks 5 and 7 against the paper will show you that).
--
--   >>> ZERO ROWS IS THE PASS. <<<

with target as (
  select m.id from manifests m
   where m.status = 'PUBLISHED' order by m.published_at desc limit 1
)
select
  'FAIL — this vehicle has no container' as problem,
  a.sequence_no,
  a.chassis_no
from vehicle_assignments a
join target t on t.id = a.manifest_id
where a.container_id is null
order by a.sequence_no;


-- ============================ 4 — one chassis, one container ================
-- The rule stated first, and the error this product exists to prevent.
--
-- Within one manifest this is enforced by the unique constraint
-- assignments_chassis_unique_per_manifest on (manifest_id, chassis_no), so it
-- cannot fail either — again, asserted rather than merely hoped for.
--
--   >>> ZERO ROWS IS THE PASS. <<<

with target as (
  select m.id from manifests m
   where m.status = 'PUBLISHED' order by m.published_at desc limit 1
)
select
  'FAIL — one chassis is in more than one container' as problem,
  a.chassis_no,
  count(distinct c.container_no)            as containers_it_is_in,
  string_agg(distinct c.container_no, ', ') as which
from vehicle_assignments a
join target t on t.id = a.manifest_id
join containers c on c.id = a.container_id
group by a.chassis_no
having count(distinct c.container_no) > 1;


-- ============================ 4b — across manifests =========================
-- This one CAN fail, and nothing in the schema stops it. The unique constraint
-- above is per manifest, so the same chassis appearing on two manifests that
-- are both PUBLISHED — two yards each claiming the same vehicle, or a second
-- yard's list uploaded against the wrong yard — passes every constraint and is
-- exactly the kind of mistake a PoC is for.
--
--   >>> ZERO ROWS IS THE PASS. <<<

select
  'FAIL — this chassis is live on more than one manifest' as problem,
  a.chassis_no,
  count(distinct m.id) as manifests,
  string_agg(distinct y.code || ' ' || m.operating_date::text, ', ') as where_
from vehicle_assignments a
join manifests m on m.id = a.manifest_id and m.status = 'PUBLISHED'
join yards y on y.id = m.yard_id
group by a.chassis_no
having count(distinct m.id) > 1;


-- ============================ 5 — one container, two chassis ================
-- The rule stated second. Listed in full rather than filtered to failures,
-- because a container holding one vehicle is not always wrong — a part-loaded
-- container at the end of a shift is real — but it is always worth seeing.

with target as (
  select m.id from manifests m
   where m.status = 'PUBLISHED' order by m.published_at desc limit 1
)
select
  c.container_no,
  c.expected_vehicle_count as expected,
  count(a.id)              as assigned,
  string_agg(a.chassis_no, ', ' order by a.sequence_no) as chassis,
  case when count(a.id) = c.expected_vehicle_count then 'PASS'
       else 'LOOK AT THIS ONE' end as verdict
from containers c
join target t on t.id = c.manifest_id
left join vehicle_assignments a on a.container_id = c.id
group by c.container_no, c.expected_vehicle_count
order by verdict desc, c.container_no;


-- ============================ 6 — the totals agree ==========================
-- The manifest row stores its own counts at publish time. If those disagree
-- with the rows actually present, the publish did not complete cleanly and
-- nothing below this line can be trusted.

with target as (
  select m.id, m.total_containers, m.total_vehicles from manifests m
   where m.status = 'PUBLISHED' order by m.published_at desc limit 1
)
select
  t.total_containers as containers_recorded,
  (select count(*) from containers where manifest_id = t.id)          as containers_present,
  t.total_vehicles   as vehicles_recorded,
  (select count(*) from vehicle_assignments where manifest_id = t.id) as vehicles_present,
  case when t.total_containers = (select count(*) from containers where manifest_id = t.id)
        and t.total_vehicles   = (select count(*) from vehicle_assignments where manifest_id = t.id)
       then 'PASS' else 'FAIL — the publish did not complete cleanly' end as verdict
from target t;


-- ============================ 7 — what the driver will see ==================
-- The order the app will hand the work out in. This is the same view the
-- driver's screen reads, so if this looks right, their screen looks right.
-- Sequence numbers must ascend within each container with no gaps.

with target as (
  select m.yard_id, m.operating_date from manifests m
   where m.status = 'PUBLISHED' order by m.published_at desc limit 1
)
select
  v.container_no,
  v.sequence_no,
  v.chassis_no,
  v.make_model,
  v.assignment_status,
  v.container_filled || ' of ' || v.expected_vehicle_count as fill
from v_driver_tasks v
join target t on t.yard_id = v.yard_id and t.operating_date = v.operating_date
order by v.container_no, v.sequence_no;


-- ============================ 8 — the one-line answer =======================

with target as (
  select m.id from manifests m
   where m.status = 'PUBLISHED' order by m.published_at desc limit 1
),
counts as (
  select
    (select count(*) from containers where manifest_id = t.id)          as containers,
    (select count(*) from vehicle_assignments where manifest_id = t.id) as vehicles,
    (select count(*) from vehicle_assignments
      where manifest_id = t.id and container_id is null)                as orphans,
    (select count(*) from (
       select a.chassis_no from vehicle_assignments a
        join containers c on c.id = a.container_id
       where a.manifest_id = t.id
       group by a.chassis_no having count(distinct c.container_no) > 1) x) as double_booked
  from target t
)
select
  containers, vehicles, orphans, double_booked,
  case when orphans = 0 and double_booked = 0 and vehicles > 0
       then 'PASS — every vehicle has exactly one container'
       else 'FAIL — see checks 3 and 4' end as verdict
from counts;
