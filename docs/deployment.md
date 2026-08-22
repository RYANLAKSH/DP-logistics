# Deployment

Everything needed to run this in production, in the order you need it.

## 1. Environment variables

### The PWA (build time — these ship in the bundle)

| Variable | Required | What it is |
|---|---|---|
| `VITE_SUPABASE_URL` | yes | Project URL, e.g. `https://abcd.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | yes | The anon key. **Public by design** — it is in the JavaScript |
| `VITE_OCR_ASSET_BASE` | no | Defaults to `/ocr`. Point it at a CDN if you serve the engine separately |
| `VITE_APP_VERSION` | recommended | Stamped onto every movement record and every error report |
| `VITE_ERROR_ENDPOINT` | recommended | Where crash reports are POSTed. See §8 |

`VITE_ERROR_ENDPOINT` takes a URL that accepts a JSON POST — a Sentry
[minimal endpoint](https://docs.sentry.io/), a log drain, or a function of your
own. There is no SDK and no key: the payload is `{message, stack, where, role,
release, at, online}` and nothing else. `where` is the route pattern with every
identifier stripped by an allowlist, so a crash report cannot become a second,
unaudited copy of the manifest. If you point this at a service that also wants
an API key, put the key in a proxy you control — never in a `VITE_` variable,
which ships in the bundle.

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

Ship browser errors somewhere — set `VITE_ERROR_ENDPOINT`. A driver will not
report a white screen, they will stop using the app, and you will hear about it
as "the system is unreliable" three weeks later.

### Scheduled jobs

Two jobs must run, both as the service role. `pg_cron` in the same project is
the least moving parts:

```sql
-- Retention: remove photographs past evidence_retention_months, keep the
-- record and the hashes. Batched, so a long-overdue first run does not lock
-- anything up; schedule it hourly and it will drain and then idle.
select cron.schedule('purge-evidence', '17 * * * *',
  $$ select app.purge_expired_evidence(500) $$);

-- Integrity: verify the audit hash chain, and anchor the head externally.
select cron.schedule('verify-audit', '0 2 * * *',
  $$ select verify_audit_chain() $$);
```

Check retention is actually working, as an admin, before trusting it:

```sql
select * from retention_pending();
-- org_id | retention_months | attempts_due | oldest
```

`attempts_due` climbing day after day means the job has stopped. That is the
failure mode worth alerting on: a retention job nobody can observe is a
retention job nobody will notice has died.

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

Run it, do not read it:

```bash
npm run build -w @dp/pwa      # the bundle checks need a build
./scripts/production-check.sh
```

It verifies 24 properties of the repository and the built bundle — no
service-role key in the bundle, RLS forced and hoistable, the retention purge
unreachable from a user token, the app chunk inside its budget, the framework
split out, the browser target pinned, an error boundary present, the audit
chain verifiable — and exits non-zero if any of them is false.

What it deliberately does **not** claim to check, because a script cannot:

- a restore from backup, actually performed into a scratch project
- one real movement completed on a real phone, on the yard's own network
- public sign-up disabled, verified by attempting one
- MFA enforced for `ADMIN`
- the error endpoint receiving events
- **a paper fallback agreed with the yard for the day this is down**

That last one is not ceremony. A verification system with no agreed fallback
becomes a reason to stop loading vehicles, and that is how a control gets
switched off permanently — not by a decision, but by one bad morning.

Alongside it, the test suite is the other half of the gate:

```bash
./scripts/test-all.sh         # parser, app, database + RLS, concurrency, browser
```

## 12. What this audit changed, and why it matters in production

Recorded because each of these was invisible until the volumes were realistic,
and each will be re-introduced by someone who does not know why it is the way
it is.

**RLS was evaluated once per row.** Policies called `app.current_org()` and
`app.can_see_yard(yard_id)` inline. Seeded with 300,000 audit rows — under a
year for one busy yard — a manager counting their own audit log took **15.2
seconds**. Written so the planner hoists them (`(select app.current_org())`,
and `yard_id in (select unnest(app.visible_yards()))`), the same count takes
**96 ms**, returning identical rows for every role. `30_rls.sql` pins the shape
structurally, because a timing test on a fixture database proves nothing.

**The bundle split did not split.** `manualChunks` keyed on package names, so
`'react-dom'` never matched `react-dom/client` — what the app imports. React
shipped inside the app chunk, so every release re-downloaded the framework.
Matching by path took the per-deploy download from **78.5 KB to 12.5 KB**
gzipped. The mock backend, the CSV parser and the XLSX reader were also on the
login critical path of a configured build; they are behind a dynamic import
now.

**Evidence images were 339 KB each.** Two per vehicle, forty vehicles a shift:
27 MB per driver over yard mobile data. At the measured setting they are 231 KB
— 18 MB a shift. Resolution was kept and quality spent, because the two are not
interchangeable: pixels on a plate cannot be recovered by any amount of
quality, and the plate is what the photograph is for.

**Retention was a setting nothing acted on.** `evidence_retention_months` has
been in the schema since the beginning and no job ever read it — a promise in a
contract and a storage bill that grows for ever. `app.purge_expired_evidence()`
now removes the photographs and keeps the record: the movement, the attempt,
the SHA-256 of each image and the audit log all survive, so what the image
*was* stays provable after the image is gone. It runs as the service role from
a schedule and is explicitly revoked from `authenticated` — a token in a
driver's phone that can delete evidence is not a retention policy, it is a way
to destroy the case against a bad movement.

**There was no error boundary.** One thrown error unmounted the whole tree: a
driver mid-shift holding a blank phone, with no message and no record. The
worst failure the app had, because nobody learns it happened.

**Six accessibility defects**, including five controls under the 44 px touch
floor — Sign out, the sync pill, and the exception rows on the board at 22 px —
and an unlabelled filter. `npm run e2e:a11y` keeps them fixed.
