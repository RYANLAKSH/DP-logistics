#!/usr/bin/env bash
# Rebuilds a throwaway database, applies the Supabase shim + every migration in
# order, then runs each test file. Any error aborts: psql runs with
# ON_ERROR_STOP so a failing assertion fails the script.
set -euo pipefail

SCRATCH="${DP_PG_DIR:-/tmp/dp-pg}"
SOCK="$SCRATCH/pgsock"
DB="${DP_TEST_DB:-dp_test}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL=(psql -h "$SOCK" -U postgres -v ON_ERROR_STOP=1 -q)

echo "==> rebuilding $DB"
"${PSQL[@]}" -d postgres -c "drop database if exists $DB" >/dev/null
"${PSQL[@]}" -d postgres -c "create database $DB" >/dev/null

echo "==> shim"
"${PSQL[@]}" -d "$DB" -f "$ROOT/supabase/tests/00_local_shim.sql" >/dev/null

echo "==> migrations"
for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '    %s\n' "$(basename "$f")"
  "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null
done

echo "==> fixtures"
shopt -s nullglob
for f in "$ROOT"/supabase/tests/0[1-9]*.sql; do
  printf '    %s\n' "$(basename "$f")"
  "${PSQL[@]}" -d "$DB" -f "$f" >/dev/null
done

echo "==> tests"
fail=0
for f in "$ROOT"/supabase/tests/[1-9]*.sql; do
  printf '    %s ... ' "$(basename "$f")"
  if out=$("${PSQL[@]}" -d "$DB" -f "$f" 2>&1); then
    echo "ok"
  else
    echo "FAILED"
    echo "$out" | sed 's/^/        /'
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  echo "==> FAILURES"
  exit 1
fi
echo "==> all green"
