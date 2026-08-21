#!/usr/bin/env bash
# Proves the verification engine under genuine concurrency.
#
# Two drivers, two connections, one container slot, fired at the same instant.
# Nothing about this can be demonstrated from a single session: the race is
# between transactions, and the control is a row lock plus a partial unique
# index. This script exists because "we take a lock" is a claim, not a test.
set -euo pipefail

# Expects a database freshly built by scripts/db-test.sh. Run that first.

SCRATCH="${DP_PG_DIR:-/tmp/dp-pg}"
SOCK="$SCRATCH/pgsock"
DB="${DP_TEST_DB:-dp_test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL=(psql -h "$SOCK" -U postgres -v ON_ERROR_STOP=1 -q -t -A)

DRIVER=00000000-0000-0000-0000-0000000000c3
YARD=00000000-0000-0000-0000-0000000000b1
ORG=00000000-0000-0000-0000-0000000000a1
MGR=00000000-0000-0000-0000-0000000000c2

echo "==> staging a fresh single-slot container"
"${PSQL[@]}" -d "$DB" <<SQL >/dev/null
insert into manifest_imports (
  id, org_id, yard_id, operating_date, file_name, file_path, file_sha256,
  file_bytes, status, row_count, valid_count, rejected_count, uploaded_by, parsed_rows
) values (
  '00000000-0000-0000-0000-00000000e100', '$ORG', '$YARD',
  current_date + 30, 'race.csv', 'p/q/race.csv', repeat('e', 64), 256,
  'READY', 1, 1, 0, '$MGR',
  '[{"row_no":1,"container_no":"CULVNSA2699100","chassis_no":"MAT990001R0R00001","sequence_no":1}]'
);
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','$MGR')::text, false);
select publish_manifest_from_import('00000000-0000-0000-0000-00000000e100', 'RACE-1');
reset role;
SQL

ASSIGNMENT=$("${PSQL[@]}" -d "$DB" -c \
  "select id from vehicle_assignments where chassis_no = 'MAT990001R0R00001'")

echo "==> recording evidence for two competing movements"
for n in 1 2; do
  "${PSQL[@]}" -d "$DB" <<SQL >/dev/null
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','$DRIVER')::text, false);
select record_scan_attempt(
  ('00000000-0000-0000-0000-00000000ca0' || $n)::uuid, '$ASSIGNMENT', 'CONTAINER',
  'CULVNSA2699100', 'p/c$n.jpg', repeat('c', 64));
select record_scan_attempt(
  ('00000000-0000-0000-0000-00000000cb0' || $n)::uuid, '$ASSIGNMENT', 'CHASSIS',
  'MAT990001R0R00001', 'p/h$n.jpg', repeat('h', 64));
SQL
done

# Each racer opens its own transaction, waits a fixed moment so both are
# inside verify_movement at the same time, then contends for the container row.
run_racer() {
  local n=$1
  "${PSQL[@]}" -d "$DB" > "$SCRATCH/racer-$n.out" 2>&1 <<SQL || true
begin;
set role authenticated;
select set_config('request.jwt.claims', json_build_object('sub','$DRIVER')::text, true);
select pg_sleep(0.6);
select (verify_movement(
  ('00000000-0000-0000-0000-00000000cc0' || $n)::uuid, '$ASSIGNMENT',
  'CULVNSA2699100', 'MAT990001R0R00001',
  ('00000000-0000-0000-0000-00000000ca0' || $n)::uuid,
  ('00000000-0000-0000-0000-00000000cb0' || $n)::uuid,
  null, 'device-driver-1')) ->> 'outcome';
commit;
SQL
}

echo "==> racing"
run_racer 1 &
P1=$!
run_racer 2 &
P2=$!
wait $P1 $P2 || true

OUT1=$(tail -1 "$SCRATCH/racer-1.out")
OUT2=$(tail -1 "$SCRATCH/racer-2.out")
echo "racer 1: $OUT1"
echo "racer 2: $OUT2"

COMPLETED=$("${PSQL[@]}" -d "$DB" -c \
  "select count(*) from movement_events where assignment_id = '$ASSIGNMENT'
     and status in ('COMPLETED','OVERRIDDEN')")

echo "completed movements for the contested assignment: $COMPLETED"

case "$OUT1|$OUT2" in
  "MATCH|ALREADY_COMPLETED"|"ALREADY_COMPLETED|MATCH") ;;
  *)
    echo "FAILED: expected one MATCH and one ALREADY_COMPLETED, got $OUT1 and $OUT2"
    exit 1 ;;
esac
if [ "$COMPLETED" != "1" ]; then
  echo "FAILED: expected exactly 1 completed movement, got $COMPLETED"
  exit 1
fi
echo "==> exactly one movement recorded. Race held."
