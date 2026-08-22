#!/usr/bin/env bash
# Everything that can be automated on the way to a live deployment.
#
#   ./scripts/go-live.sh <supabase-project-ref>
#
# Stops at the first failure and tells you what to do about it. Safe to re-run:
# every step is idempotent, so if it dies halfway, fix the cause and run it again.
set -euo pipefail

REF="${1:-}"
DOMAIN="${DOMAIN:-dpw.rylaglobalservices.com}"

if [ -z "$REF" ]; then
  echo "usage: ./scripts/go-live.sh <supabase-project-ref>   e.g. frqruwbymanabrlbzbgy"
  exit 1
fi

step() { printf '\n\033[1m▸ %s\033[0m\n' "$1"; }
ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }

step "Checking the CLI is here"
command -v supabase >/dev/null || {
  echo "  Supabase CLI not found. Install it:  npm install -g supabase"; exit 1; }
supabase projects list >/dev/null 2>&1 || {
  echo "  Not logged in. Run:  supabase login"; exit 1; }
ok "supabase CLI ready"

step "Linking to project $REF"
supabase link --project-ref "$REF"
ok "linked"

step "Pushing the schema (21 migrations)"
# If this fails on 20260101001200_storage.sql with "must be owner of table
# objects", run that one file in the dashboard SQL editor and re-run this
# script — the migration itself says so when it happens.
supabase db push
ok "schema applied"

step "Deploying the manifest parser"
supabase functions deploy parse-manifest
supabase secrets set "ALLOWED_ORIGIN=https://$DOMAIN"
ok "edge function deployed, CORS set to https://$DOMAIN"

step "Building the web app"
[ -f apps/pwa/.env.local ] || {
  echo "  apps/pwa/.env.local is missing. It needs:"
  echo "    VITE_SUPABASE_URL=https://$REF.supabase.co"
  echo "    VITE_SUPABASE_ANON_KEY=<anon key from Settings -> API>"
  exit 1; }
npm ci
npm run build -w @dp/pwa
ok "built to apps/pwa/dist"

cat <<DONE

────────────────────────────────────────────────────────────
Automated steps are done. Four things are left, and none of
them can be scripted because they need a browser and a person.

1. DASHBOARD → Authentication → Providers → Email
   Turn OFF "Enable sign ups".
   Set Site URL to https://$DOMAIN

2. DASHBOARD → Authentication → Users → Add user
   Create your admin, and a driver. Copy both UUIDs.

3. DASHBOARD → SQL Editor
   Run supabase/bootstrap.sql, part by part, pasting those
   UUIDs in. Part 5 prints a summary — check it is non-zero.

4. NETLIFY → Import from Git
     base directory   apps/pwa
     build command    npm ci && npm run build
     publish          apps/pwa/dist
     env vars         VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY
   Then add the domain $DOMAIN, and at Hostinger add a CNAME
   record: dpw → <your-site>.netlify.app

Then open https://$DOMAIN on a phone and sign in.
────────────────────────────────────────────────────────────
DONE
