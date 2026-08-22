# Deployment

Everything needed to run this in production, in the order you need it.

## 1. Environment variables

### The PWA (build time — these ship in the bundle)

| Variable | Required | What it is |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Project URL, e.g. `https://abcd.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | yes | The anon key. **Public by design** — it is in the JavaScript |
| `VITE_OCR_ASSET_BASE` | no | Defaults to `/ocr` |
| `APP_VERSION` | recommended | Stamped onto every movement record |

With neither Supabase variable set the app runs against the in-memory mock.
That is a development convenience; make sure your production build has both,
because a misconfigured deploy would otherwise start and look fine.

### Edge Functions (secrets — never in the bundle)

| Secret | Used by |
|---|---|
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | injected automatically |
| `ALLOWED_ORIGIN` | `parse-manifest` CORS. Set it to your domain, not `*` |

> **The service role key bypasses all row level security**, which is this
> system's entire security model. It belongs in Edge Function secrets and
> nowhere else — not in a `VITE_` variable, not in CI logs, not in a `.env`
> that gets committed. If it leaks, rotate it immediately and treat every
> record written since as unverified.

## 2. Supabase project setup

Create **three separate projects**: local, staging, production. Never share
one between environments — an RLS mistake found in staging is cheap; the same
mistake in production is a data breach.

Per project, in the dashboard:

1. **Authentication → Providers → Email**: enable, and **disable "Enable sign
   ups"**. There is no self-registration in this product; an admin invites
   users. An open sign-up plus a permissive profile policy is the single most
   common way Supabase projects are breached.
2. **Authentication → Sessions**: access token 900 seconds (15 minutes).
3. **Authentication → MFA**: enable TOTP. Enforce it for ADMIN accounts.
4. **Authentication → Rate limits**: cap sign-in attempts and token refreshes.
5. **Database → Replication**: confirm `movement_events`, `exceptions` and
   `vehicle_assignments` are in the `supabase_realtime` publication (the
   migration adds them; verify).
6. **Settings → Region**: choose deliberately for where the operation runs, and
   record the choice. Moving regions later is a migration, not a setting.

## 3. Database migrations

```bash
supabase link --project-ref <ref>
supabase db push            # applies supabase/migrations in order
```

Migrations are files, applied by CI. **Never** apply a change by hand in the
dashboard SQL editor: a hand-applied change is invisible to the next
environment and to the next person.

Before pushing to production, prove the migrations against a real database:

```bash
./scripts/db-test.sh          # rebuilds, applies everything, runs 12 suites
./scripts/db-concurrency.sh   # two connections racing for one container slot
```

## 4. Storage

The migration creates both buckets private. Verify in the dashboard that
neither `evidence` nor `manifests` is public — a public evidence bucket would
expose every photograph in the system to anyone who guesses a path.

Set a lifecycle rule on `evidence` matching `org_settings.evidence_retention_months`
(default 24). Purging must run as the service role from a scheduled job; the
`verification_attempts` row and its hash survive the image, so the record still
shows that a photograph existed, what it hashed to, and that it was deleted by
policy.

## 5. Edge Functions

```bash
supabase functions deploy parse-manifest
supabase secrets set ALLOWED_ORIGIN=https://verify.example.com
```

`parse-manifest` imports SheetJS from its own CDN at deploy time, so the
deploying machine needs network access to `cdn.sheetjs.com`. It is bundled into
the deployed function; nothing is fetched at runtime.

## 6. Building and deploying the PWA

```bash
npm ci
npm run build -w @dp/pwa      # stages OCR assets, typechecks, builds
```

`dist/` is a static site. Serve it from any static host with these
requirements:

- **HTTPS.** `getUserMedia`, service workers and `crypto.subtle` all require a
  secure context. Without it the app cannot open a camera or hash an image.
- **SPA fallback**: unknown paths serve `index.html`.
- **Headers**: `apps/pwa/public/_headers` is Netlify/Cloudflare format. Port the
  same directives to whatever serves this, and edit the CSP's `connect-src` to
  name your Supabase project origin.
- **Cache-Control**: `dist/assets/*` are content-hashed — cache them for a year,
  immutable. `index.html`, `sw.js` and `manifest.webmanifest` must be
  `no-cache`, or devices never learn a new version exists.

## 7. First-run setup

1. Create the first admin through Supabase Auth (dashboard → Add user).
2. `psql` or the SQL editor, once, to bootstrap:
   ```sql
   insert into organizations (id, name) values (gen_random_uuid(), 'Your Company');
   insert into profiles (id, org_id, role, full_name)
   values ('<auth-uid>', '<org-id>', 'ADMIN', 'Your Name');
   insert into org_settings (org_id) values ('<org-id>');
   ```
   This is the only hand-written SQL the system needs. Everything after it goes
   through the admin RPCs, which audit.
3. Sign in as that admin and create yards, then managers, then drivers.

## 8. Monitoring

| Watch | Why | Alert when |
|---|---|---|
| Blocked movements | The control working | Zero for a day — either a perfect yard, or nobody is using the app |
| Override rate | Bad manifest data, or process abuse | Above 5%, or rising week on week |
| `client_verdict_agreed = false` | A stale cache — or a tampered client | Any sustained rate |
| Manual-entry rate | OCR not carrying its weight | Above 25% for chassis |
| Items unsynced > 4 hours | A movement may have happened with no record | Any |
| Exceptions open > 30 minutes | A truck is standing at a ramp | Any |
| Partially filled containers at shift end | The error no per-scan check can catch | Any |
| `verify_audit_chain()` | Tampering | Any break, immediately |
| Clock skew > 5 minutes | A wrong timezone, or a device being manipulated | Any pattern |

Ship browser errors somewhere (Sentry or equivalent) — a driver will not report
a white screen, they will stop using the app.

## 9. Backups

Supabase takes daily backups; on Pro, enable point-in-time recovery. Neither is
enough on its own for this system:

- **The audit chain needs an external anchor.** Write the latest
  `audit_logs.row_hash`, the row count and the timestamp somewhere the database
  administrator does not control — an object-lock bucket, a logging service, an
  email to compliance. Without it the hash chain protects against everyone
  except the person most able to tamper.
- **Evidence images are not in the database backup.** Storage is backed up
  separately; confirm it is, and test a restore.
- **Test a restore before you need one.** A backup nobody has restored is a
  hypothesis.

## 10. Rollback

| Layer | How | Note |
|---|---|---|
| PWA | Redeploy the previous build | Devices pick it up on next load; the service worker prompts |
| Edge Functions | `supabase functions deploy` from the previous commit | Seconds |
| Migrations | **Roll forward, not back** | See below |

Migrations are not reversible in general, and a `down` migration that drops a
column destroys evidence. When a migration is wrong, write a new one that
corrects it. The exception is a migration that has not yet reached production:
fix it in place and re-run `db-test.sh`.

Before any production migration:
1. `./scripts/db-test.sh` against a copy of production data if possible.
2. Take a manual backup.
3. Apply during a window when no yard is loading — a failed migration mid-shift
   blocks every driver.

## 11. Production readiness checklist

**Security**
- [ ] Public sign-up disabled, and verified by attempting one
- [ ] MFA enforced for ADMIN
- [ ] Service role key absent from the bundle:
      ```bash
      grep -rq "service_role\|SUPABASE_SERVICE" apps/pwa/dist && echo LEAK || echo clean
      ```
      (note the explicit test — `grep | head` always exits 0 and will tell you
      everything is fine no matter what it found)
- [ ] Both storage buckets private
- [ ] Security headers served, CSP `connect-src` names the project
- [ ] Rate limits configured on auth
- [ ] `./scripts/db-test.sh` green, including `97_attack.sql`
- [ ] `npm audit` clean

**Correctness**
- [ ] `./scripts/test-all.sh` green
- [ ] `99_acceptance.sql` green against the production schema
- [ ] Concurrency script green
- [ ] A real end-to-end movement completed on a real phone, on the real yard's Wi-Fi

**Operability**
- [ ] Error reporting receiving events
- [ ] The monitoring queries in §8 running
- [ ] Audit chain verification scheduled, with an external anchor
- [ ] Evidence retention job scheduled and tested
- [ ] Backups confirmed, and a restore tested

**People**
- [ ] Admin, managers and drivers created; yards assigned
- [ ] Driver devices registered and approved
- [ ] Drivers shown the flow, including what to do when blocked
- [ ] Managers shown the exception queue and the override consequences
- [ ] A paper fallback agreed for the day the system is down

The last one matters. A verification system with no agreed fallback becomes a
reason to stop loading vehicles, and that is how a control gets switched off
permanently.
