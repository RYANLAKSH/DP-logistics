#!/usr/bin/env bash
# Everything, in the order that fails fastest.
#
#   ./scripts/test-all.sh
#
# Requires a local PostgreSQL 16 (see scripts/db-test.sh) and, for the browser
# suites, the app served on :4173 (npm run build && npm run preview -w @dp/pwa).
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
FAILED=()

run() {
  local name="$1"; shift
  printf '\n\033[1m==> %s\033[0m\n' "$name"
  if "$@"; then
    printf '\033[32m    %s passed\033[0m\n' "$name"
  else
    printf '\033[31m    %s FAILED\033[0m\n' "$name"
    FAILED+=("$name")
  fi
}

run "typecheck"        npm run typecheck --workspaces --if-present
run "parser tests"     npx vitest run
run "app tests"        npm run test -w @dp/pwa
run "database + RLS"   ./scripts/db-test.sh
run "concurrency"      ./scripts/db-concurrency.sh

if curl -sf -o /dev/null "${E2E_BASE_URL:-http://localhost:4173}/login"; then
  run "e2e: acceptance"     npm run e2e:acceptance -w @dp/pwa
  run "e2e: driver + roles" npm run e2e -w @dp/pwa
  run "e2e: manifests"      npm run e2e:manifest -w @dp/pwa
  run "e2e: exceptions"     npm run e2e:exceptions -w @dp/pwa
  run "e2e: offline"        npm run e2e:offline -w @dp/pwa
  run "e2e: OCR"            npm run e2e:ocr -w @dp/pwa
else
  printf '\n\033[33m==> browser suites skipped: nothing serving on :4173\033[0m\n'
  printf '    npm run build -w @dp/pwa && npm run preview -w @dp/pwa\n'
fi

printf '\n'
if [ ${#FAILED[@]} -eq 0 ]; then
  printf '\033[32mALL GREEN\033[0m\n'
else
  printf '\033[31mFAILED: %s\033[0m\n' "${FAILED[*]}"
  exit 1
fi
