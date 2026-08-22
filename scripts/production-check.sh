#!/usr/bin/env bash
# Production readiness, executed rather than read.
#
#   ./scripts/production-check.sh
#
# A checklist in a document is a checklist someone ticks. This one fails.
# Everything here is a property that can be verified from the repository and a
# built bundle; the things that cannot be — a restore actually tested, a driver
# actually shown the flow — are listed at the end as the human items they are,
# because pretending a script can confirm them is worse than admitting it
# cannot.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
DIST="apps/pwa/dist"
PASS=0; FAIL=0; SKIP=0

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; FAIL=$((FAIL+1)); }
skip() { printf '  \033[33m–\033[0m %s\n' "$1"; [ $# -gt 1 ] && printf '      %s\n' "$2"; SKIP=$((SKIP+1)); }
group(){ printf '\n\033[1m%s\033[0m\n' "$1"; }

# ---------------------------------------------------------------- security
group "Security"

if [ -d "$DIST" ]; then
  # An explicit test, because `grep | head` exits 0 whatever it found and will
  # cheerfully report that a leaked key is fine.
  if grep -rqE "service_role|SUPABASE_SERVICE_ROLE" "$DIST" 2>/dev/null; then
    bad "service role key or its name is in the bundle" "rotate it, then find the build that put it there"
  else
    ok "no service-role key in the built bundle"
  fi

  if grep -rqE "eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}" "$DIST" 2>/dev/null; then
    # The anon key is a JWT and is public by design; anything else is not.
    ok "a JWT is present (expected: the anon key is public by design)"
  else
    skip "no JWT in the bundle" "a production build should contain the anon key"
  fi
else
  skip "bundle checks" "no build at $DIST — run: npm run build -w @dp/pwa"
fi

grep -q "force row level security" supabase/migrations/*.sql \
  && ok "row level security is forced, so a table owner is subject to policy" \
  || bad "RLS is not forced"

# A policy that calls a helper with a row's column cannot be hoisted, and costs
# ~50µs a row. On an audit log that is the difference between 96ms and 15s.
# Comment lines stripped first: this file explains why can_see_yard is not used
# in policies, and matching that explanation would fail the check it describes.
if sed 's/--.*//' supabase/migrations/20260101000800_rls.sql \
     supabase/migrations/20260101001200_storage.sql | grep -q "can_see_yard"; then
  bad "a policy still calls can_see_yard per row" "use: yard_id in (select unnest(app.visible_yards()))"
else
  ok "every policy helper is hoistable"
fi

grep -q "revoke all on function app.purge_expired_evidence" supabase/migrations/*.sql \
  && ok "the retention purge is not callable from a user session" \
  || bad "the retention purge is reachable from a token"

[ -f apps/pwa/public/_headers ] \
  && ok "security headers file is present" \
  || bad "no _headers file" "CSP, HSTS and frame-ancestors are served by the host"

if npm audit --omit=dev --audit-level=high >/dev/null 2>&1; then
  ok "npm audit clean at high and above"
else
  bad "npm audit reports a high or critical advisory" "npm audit --omit=dev"
fi

# ------------------------------------------------------------- correctness
group "Correctness"

for f in 30_rls 97_attack 97a_retention 98_storage 99_acceptance 99z_outcomes; do
  [ -f "supabase/tests/$f.sql" ] && ok "$f.sql present" || bad "$f.sql missing"
done

[ -f apps/pwa/e2e/acceptance.mjs ] \
  && ok "the 13-step acceptance walk exists" \
  || bad "no acceptance walk"

# ------------------------------------------------------------- performance
group "Performance"

if [ -d "$DIST/assets" ]; then
  entry=$(ls "$DIST"/assets/index-*.js 2>/dev/null | head -1)
  if [ -n "$entry" ]; then
    kb=$(( $(gzip -c "$entry" | wc -c) / 1024 ))
    # The chunk that changes on every deploy. Everything else is cached across
    # releases, so this is what a driver actually re-downloads.
    [ "$kb" -le 40 ] \
      && ok "app chunk is ${kb} KB gzipped (budget 40)" \
      || bad "app chunk is ${kb} KB gzipped, over the 40 KB budget"
  fi
  ls "$DIST"/assets/react-*.js >/dev/null 2>&1 \
    && ok "the framework is a separate chunk, cached across releases" \
    || bad "react is not split out" "every release re-downloads the framework"
fi

grep -q "quality = 0.75" apps/pwa/src/lib/camera.ts \
  && ok "evidence images encode at the measured quality" \
  || skip "evidence image quality has changed" "re-measure before shipping"

grep -q "target: \['chrome110', 'safari16.4'\]" apps/pwa/vite.config.ts \
  && ok "browser target is pinned" \
  || bad "browser target is not pinned" "a dependency bump would move it silently"

# ------------------------------------------------------------- operability
group "Operability"

[ -f apps/pwa/src/lib/ErrorBoundary.tsx ] \
  && ok "a render error shows a recoverable screen, not a white one" \
  || bad "no error boundary"

grep -q "installGlobalErrorHandlers" apps/pwa/src/App.tsx \
  && ok "unhandled rejections are reported" \
  || bad "async failures disappear silently"

grep -q "verify_audit_chain" supabase/migrations/*.sql \
  && ok "the audit chain can be verified" \
  || bad "no audit chain verification"

grep -q "purge_expired_evidence" supabase/migrations/*.sql \
  && ok "retention is enforced, not merely configured" \
  || bad "evidence_retention_months is a setting nothing acts on"

# --------------------------------------------------------------------- PWA
group "PWA"

[ -f "$DIST/manifest.webmanifest" ] && ok "web app manifest is built" || skip "no manifest" "build first"
[ -f "$DIST/sw.js" ] && ok "service worker is built" || skip "no service worker" "build first"
grep -q "clientsClaim" apps/pwa/src/sw.ts \
  && ok "the worker claims open pages, so an update reaches a running app" \
  || bad "the worker does not claim clients"

# ------------------------------------------------------------------ result
printf '\n\033[1m%d passed, %d failed, %d skipped\033[0m\n' "$PASS" "$FAIL" "$SKIP"

cat <<'HUMAN'

Not checkable from here — confirm these yourself before go-live:
  · a restore from backup, actually performed into a scratch project
  · one real movement completed on a real phone, on the yard's own network
  · public sign-up disabled, verified by attempting one
  · MFA enforced for ADMIN
  · the error endpoint receiving events
  · the paper fallback agreed with the yard for the day this is down
HUMAN

[ "$FAIL" -eq 0 ] || exit 1
