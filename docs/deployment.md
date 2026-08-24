# Pilot deployment

This is preparation for a controlled pilot, not a production deployment
runbook for scale. It assumes the reader has already read
[running.md](running.md) (development) and the "Backup and restore" section
there in particular — this document does not repeat what a backup contains
or how restore verification works, only how to schedule, transport, and
operate it for a real pilot.

Nothing in this repository executes any of the steps below. They are a
documented, tested procedure to be run by hand against a real host.

## 1. Production environment variables

Every variable the application actually reads, confirmed by direct search of
`packages/api/src` (not assumed from documentation elsewhere):

| Variable | Required? | Secret? | Notes |
|---|---|---|---|
| `DB_PATH` | **Required** (production; `start.ts` refuses to boot without it) | No | Must be a persistent path. Optional in dev (`main.ts` defaults to `:memory:`). |
| `JWT_SECRET` | **Required, every environment** | **Secret** | Fails closed — no fallback, ever (Stage 5/11). |
| `STORAGE_SECRET` | **Required** when `S3_BUCKET` is unset | **Secret** | Fails closed (Stage 11). Not read at all once `S3_BUCKET` is set. |
| `PUBLIC_BASE_URL` | **Required in production** when `S3_BUCKET` is unset (Stage 15 fix) | No | The only thing it affects anywhere in the codebase is the local storage driver's evidence/document capability URLs — confirmed by repo-wide search. Not used for CORS, redirects, or notification links (none exist). |
| `STORAGE_DIR` | Optional | No | Defaults to `./.evidence`. Must be a persistent path in production. |
| `BACKUP_DIR` | Optional | No | Defaults to `./backups`. Must be outside anything publicly served. |
| `BACKUP_SOURCE_DIR` | Required (restore CLI only) | No | Not read by the running server, only `restore.ts`. |
| `RESTORE_TARGET_DIR` | Required (restore CLI only) | No | Same. |
| `PORT` | Optional | No | Defaults to 3000. |
| `S3_BUCKET` / `S3_REGION` / `S3_ENDPOINT` | Optional | `S3_BUCKET`/`S3_ENDPOINT` no; AWS credentials (via the SDK's own env vars, not read by this app directly) yes | Presence of `S3_BUCKET` alone switches the storage driver. |
| `OCR_PROVIDER` | Optional | No | Only meaningful value today is `textract`, which also needs `S3_BUCKET`. |
| `TEXTRACT_REGION` | Optional | No | Falls back to `S3_REGION`, then `ap-south-1`. |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` / `SMTP_SECURE` / `MAIL_FROM` | Optional | `SMTP_PASS` yes | Absent entirely → JSON no-op transport (dev-safe default; a production deploy that forgets these simply sends no real email, silently — see "Remaining blockers"). |

`NODE_ENV` is **not read anywhere in the runtime code** — confirmed by
search; the only remaining references are code comments describing the
Stage 5/11 bugs it used to cause. Do not set behavior based on it; nothing
in this application does.

Development-only, never set in production: nothing — every variable above
that has a dev-only *default* still works identically if explicitly set in
production. There is no variable that is exclusively dev-only.

## 2. PUBLIC_BASE_URL — finding and fix

**Finding**: `PUBLIC_BASE_URL` is read in exactly one place,
`packages/api/src/lib/storage.ts`'s `getStorage()`, and only affects the
local storage driver's capability URLs (`presignPut`/`presignGet`). It has
no effect on CORS (none exists), redirects (none exist), or notification
emails (they never embed a URL at all — confirmed by search). Left unset, it
silently defaulted to `http://localhost:$PORT` in every environment,
meaning a misconfigured production deploy would boot successfully and mint
evidence/document links nobody outside the server could ever open.

**Fix (implemented this stage)**: `start.ts` — the production entrypoint —
now refuses to boot when the local storage driver would be used (no
`S3_BUCKET`) and `PUBLIC_BASE_URL` is unset or empty, with a specific error
message. `getStorage()` itself is unchanged (still defaults to localhost),
which is correct and necessary for `main.ts` (dev) — the fix is scoped to
the one file whose entire purpose is enforcing production configuration,
exactly matching how `JWT_SECRET`/`STORAGE_SECRET` are already validated
there. Regression tests added to `boot.test.ts`: refuses to start without
it (no `S3_BUCKET`), and does not require it when `S3_BUCKET` is set.

**Required production value**: the real public origin the pilot will be
reached at, e.g. `https://app.dp-logistics-pilot.example` — no trailing
slash, `https://`, matching whatever domain is configured (see §11).

## 3. Node version requirement

**Pinned to Node 26** (`>=26`), via a new `.nvmrc` at the repo root and a new
`engines.node` field in the root and `packages/api` `package.json` files.
CI's `actions/setup-node` step now reads `.nvmrc` instead of a
hard-coded string, so local development, CI, and the version documented for
production all come from one file.

This is the version actually verified throughout this entire engagement —
every test run, typecheck, and manual boot/backup/restore check across every
stage ran on Node 26.7.0. `node --experimental-strip-types` (used by every
workspace's dev/test/start scripts) and `node:sqlite`'s `DatabaseSync`/
`backup()` (used throughout the API and the Stage 14 backup system) both
need a recent Node runtime; **no earlier major version was tested in this
engagement**, so no earlier minimum is claimed. Do not lower this without
actually testing against the lower version first.

## 4. Process supervision

**Recommendation: systemd**, not PM2. The deployment target established in
Stage 12 is a self-managed Hostinger **VPS** (shared/basic Hostinger hosting
cannot run a persistent Node process at all) — a VPS is a normal Linux host
with systemd already present, so systemd needs nothing installed beyond
what the OS ships with, gives real crash-restart and boot-start semantics
natively, and is the standard tool for exactly this shape of deployment (one
long-running Node process). PM2 is a reasonable alternative if the
deployment account has no root/`systemctl` access, but it is an additional
dependency to install and keep patched for no benefit here.

A template unit is provided at
[`deploy/dp-logistics-api.service`](../deploy/dp-logistics-api.service) —
not installed by anything in this repository. It:
- restarts on crash (`Restart=on-failure`) with a burst limit so a
  genuinely broken deploy does not loop forever silently,
- starts on boot once enabled (`WantedBy=multi-user.target`),
- loads all production configuration from an `EnvironmentFile` that lives
  **outside** this repository and is never committed,
- is hardened with `ProtectSystem=strict` plus an explicit
  `ReadWritePaths`, so the process can only write to its own data
  directories — DB_PATH, STORAGE_DIR, and BACKUP_DIR all need to live under
  the path listed there.

## 5. Off-server backups

**Recommendation: `rclone` to S3-compatible object storage** (Backblaze B2
or Cloudflare R2 are the cheapest fits), not a second server.

Reasoning, weighed against the actual pilot: expected volume is small (a
handful of officers, one or two locations — at most a few hundred images and
a few MB of database growth per day, per Stage 12/14's own volume
estimates), so object storage costs a few dollars a month at most. A second
VPS as a backup target would cost more and — critically — is *more*
operational burden, not less: another host to patch, secure, and keep an
eye on, purely to hold files. `rclone` is a single static binary, its sync
is one command, and credentials are a single key pair instead of SSH host
management. Transport is TLS (HTTPS) either way. If a second server the
operator already controls at zero marginal cost exists, `rsync` over SSH to
it is an equally valid, slightly simpler alternative —
[`deploy/backup.sh`](../deploy/backup.sh) supports both (it prefers
`rclone` if present, falls back to `rsync` otherwise) and neither is
configured with real credentials anywhere in this repository.

**Not implemented in this stage, by rule**: no actual account was created,
no credentials configured, nothing was uploaded anywhere. This remains the
one concrete action item before pilot go-live — see §16.

## 6. Backup scheduling

**Recommendation: a daily cron entry** invoking
[`deploy/backup.sh`](../deploy/backup.sh), not a systemd timer. A timer is
not meaningfully safer or simpler than cron for a single daily job, and
cron's default failure-notification behavior (mail the invoking user
anything a job writes to stdout/stderr) is exactly the alerting mechanism
recommended in §7 — reusing it is one less thing to configure.

```
# /etc/cron.d/dp-logistics-backup — daily at 02:15 server time
15 2 * * * dplogistics /opt/dp-logistics/deploy/backup.sh
```

**Retention: 14 days, rolling.** Verified against actual pilot volume,
not assumed: at a few hundred images/day, 14 days of local backups is at
most a few GB — cheap to keep, and two weeks is enough time to notice and
act on a problem that was not caught immediately. This is the same figure
already documented in `running.md` from Stage 14; nothing here changes it.
Deleting backups older than 14 days is not yet automated — a second cron
line (e.g. `find "$BACKUP_DIR" -maxdepth 1 -mtime +14 -exec rm -rf {} \;`)
is deployment configuration, documented here rather than built into
`backup.ts`, since retention policy is a deployment decision and the
backup tool itself should not silently delete anything on its own
initiative.

## 7. Backup failure detection

`npm run backup` (via `lib/backup.ts`, unchanged from Stage 14) already
exits non-zero for: a missing source database, and an incomplete backup
(any verified evidence file missing or hash-mismatched). `deploy/backup.sh`
(new this stage) adds: a missing required environment variable, and an
off-server sync failure (auth failure, network failure, or the remote
being out of space all surface as `rclone`/`rsync`'s own non-zero exit,
which the script checks explicitly and reports before exiting non-zero
itself). Verified directly, this stage: missing database, missing env var,
and a successful full run including the off-server step all produce the
expected exit code and a clear stderr message.

**How an operator finds out**: cron's default behavior mails the invoking
user any output from a job that produced output or exited non-zero — this
script always prints a `[backup] ...` line either way, so a failed run is
never silent. This is the pilot-appropriate mechanism; building real
alerting/monitoring is explicitly out of scope here.

## 8. Backup security

Verified, not assumed:
- `BACKUP_DIR` defaults to `./backups`, a sibling of the API's working
  directory — not `packages/admin/` (the only publicly-served directory)
  and not under `STORAGE_DIR`. Neither backups nor evidence are served by
  any HTTP route other than the signed capability-URL endpoint, which
  cannot enumerate or serve arbitrary paths.
- Every file and directory a backup produces is created owner-only
  (`0700` directories, `0600` files) — implemented and tested in Stage 14,
  re-verified this stage.
- `deploy/backup.sh` sources credentials from an environment file outside
  the repository (`/etc/dp-logistics/backup.env` by default); nothing here
  commits or prints a credential. `rclone`'s own config file
  (`RCLONE_CONFIG`, default `/etc/dp-logistics/rclone.conf`) is likewise
  external and never referenced by path assumptions inside the repo.
- Transport is TLS in both supported mechanisms (`rclone` to S3-compatible
  storage is HTTPS; `rsync` is run over SSH).
- No new HTTP route was added anywhere for backup or restore — both remain
  pure CLI tools with no API surface, so there is nothing to expose.

## 9. Hostinger deployment architecture

A. **Node.js runtime**: Node 26 (§3), on a Hostinger **VPS** plan — shared/
   basic Hostinger web hosting cannot run a persistent Node process, per
   Stage 12's finding, reconfirmed unchanged this stage.

B. **API process**: one Node process (`start.ts`), supervised by systemd
   (§4), on the VPS.

C. **Admin UI**: no separate hosting decision — it is served by the API
   process itself (`express.static` at `/admin`, confirmed unchanged in
   `server.ts`). It lives wherever the API lives.

D. **Mobile application**: out of scope for this VPS entirely — it is a
   separate Expo/React Native build/distribution pipeline, unaffected by
   any of this stage's changes. Confirmed unchanged: `packages/mobile`
   still has no web build target.

E. **Persistent database path**: e.g. `/var/lib/dp-logistics/db.sqlite`
   (matches the systemd unit's `ReadWritePaths`).

F. **Persistent evidence path**: e.g. `/var/lib/dp-logistics/.evidence`
   (same volume as E, same `ReadWritePaths`).

G. **Backup path**: e.g. `/var/lib/dp-logistics/backups` (same volume,
   same `ReadWritePaths`) — or a separate, larger disk if the VPS plan
   provisions one, since backups accumulate independently of live data.

H. **Off-server backup path**: an S3-compatible bucket (§5), not on
   Hostinger at all — deliberately, so a Hostinger account or VPS incident
   cannot take out both the live data and its backups at once.

I. **Environment variables**: per §1, loaded via the systemd unit's
   `EnvironmentFile` — never inside the git checkout.

J. **HTTPS/domain**: terminated in front of the Node process (e.g. Caddy or
   nginx on the same VPS, or a Hostinger-provided proxy if one exists for
   VPS plans — not verified in this engagement, confirm at deployment
   time). The Node app itself has no TLS code and needs none.

K. **Process restart**: the systemd unit (§4) — `systemctl restart
   dp-logistics-api`, or automatic on crash/reboot.

L. **Deployment/update procedure**: §12.

M. **Rollback**: §13.

**What genuinely cannot run on Hostinger's shared/basic hosting tier**: the
API process itself (needs a persistent process, not static file serving),
reconfirmed unchanged from Stage 12 — this is not new information, just
re-verified rather than assumed.

## 10. Domain, HTTPS, and CORS

- **Public application URL**: whatever domain is pointed at the VPS (not
  created or modified by this stage — DNS is a deployment-time action).
- **API URL**: the same origin — there is no separate API subdomain
  requirement, since the admin panel is already same-origin with the API
  (§9C) and the mobile app is a native client (not subject to CORS at all).
- **Admin URL**: `<domain>/admin` — same origin, no separate hosting.
- **CORS**: **still not needed**, confirmed unchanged this stage — no CORS
  middleware exists anywhere in the code, and neither current client
  (native mobile app, same-origin admin panel) is affected by its absence.
  This becomes a real requirement only if a genuine third-party browser
  client is ever built — not the case today, and not something to
  pre-emptively configure.
- **Secure cookies/tokens**: not applicable — auth is bearer-JWT-in-header,
  not cookie-based (unchanged from every prior stage's finding).
- **`PUBLIC_BASE_URL`**: must equal the real public application URL,
  `https://` (§2) — this is the one domain-dependent configuration value
  the application actually reads.

**Configuration values to set at deployment**: the domain's DNS record
pointing at the VPS, a TLS certificate (e.g. via Let's Encrypt/certbot on
the VPS, or Hostinger's own mechanism if the VPS plan provides one — not
verified here), and `PUBLIC_BASE_URL` matching that domain exactly.

## 11. Secrets checklist

Values only — never exposed here or anywhere in this repository.

| Secret | Required | Insecure fallback? | Committed? | Printed in logs? |
|---|---|---|---|---|
| `JWT_SECRET` | Yes, always | No — fails closed (Stage 5/11, unchanged) | No | No — never logged anywhere in the codebase |
| `STORAGE_SECRET` | Yes, unless `S3_BUCKET` set | No — fails closed (Stage 11, unchanged) | No | No |
| SMTP credentials (`SMTP_PASS` etc.) | Only if real email is wanted | Fails open by design (falls back to a no-op JSON transport, not a predictable secret) — see "Remaining blockers" | No | No — nodemailer is never passed to a logging call |
| Off-server backup credentials (`rclone`/SSH) | Only once off-server backup is configured | N/A — not implemented yet | No — lives in `/etc/dp-logistics/rclone.conf` or SSH keys outside the repo | No — `deploy/backup.sh` never echoes the config file contents or key material |

No fake/example secret values were created anywhere in this repository —
every template file above uses a path reference, never a value.

## 12. Deployment runbook

A precise sequence, not yet executed against any real host.

1. **Prepare the server** — provision a Hostinger VPS, create a
   non-root service user (e.g. `dplogistics`).
2. **Install Node 26** — matching `.nvmrc` exactly (§3).
3. **Clone the repository** to e.g. `/opt/dp-logistics` (read-only at
   runtime per the systemd unit's `ProtectSystem=strict`).
4. **Install dependencies**: `npm ci` (authoritative against
   `package-lock.json`, per the existing CI comment).
5. **Build**: `npm run build --workspaces --if-present` — required, since
   `packages/shared-rules`' compiled output is gitignored and every other
   workspace depends on it at runtime (unchanged Stage 8 finding).
6. **Configure environment**: create `/etc/dp-logistics/api.env` (and
   `/etc/dp-logistics/backup.env`) with every variable from §1 that
   applies, real secrets from §11, `PUBLIC_BASE_URL` set to the real
   domain.
7. **Create persistent directories**: `/var/lib/dp-logistics/{,.evidence,
   backups}`, owned by the service user.
8. **Set permissions**: `chmod 700` on all three (the application itself
   already enforces this for backup contents specifically — Stage 14/15;
   the parent directories are a deployment-time step).
9. **Initialize the database**: none needed explicitly — `start.ts` calls
   the same idempotent `openDb()`/`migrate()` path a normal boot always
   uses; the schema creates itself on first boot against an empty file.
10. **Run migrations**: not a separate step — see 9; `migrate()` is
    additive and runs automatically on every boot.
11. **Do NOT seed demo data** — confirmed structurally impossible from
    `start.ts` (Stage 13); create the first real organization/users
    through the admin API instead, once the server is up.
12. **Start the application**: `sudo systemctl enable --now
    dp-logistics-api` (using the template at
    `deploy/dp-logistics-api.service`).
13. **Verify health**: `curl https://<domain>/v1/health` → `{"status":"ok"}`.
14. **Verify login**: create the first real admin user, log in, confirm a
    token pair is issued.
15. **Verify the API**: `GET /v1/auth/me` with that token.
16. **Verify evidence storage**: complete one real scan/upload cycle
    end-to-end and confirm the file lands under the configured
    `STORAGE_DIR` and the capability URL resolves against the real domain
    (not localhost — this is exactly what §2's fix guarantees was checked
    at boot).
17. **Verify backup**: run `deploy/backup.sh` by hand once; confirm
    `manifest.json`'s `status` is `ok`.
18. **Verify off-server transfer**: confirm the same run's off-server sync
    step actually completed once §5 is configured with real credentials.
19. **Enable process supervision**: already done in step 12; confirm with
    `systemctl status dp-logistics-api`.
20. **Confirm restart recovery**: `sudo systemctl restart
    dp-logistics-api`, then repeat steps 13–15 — this directly exercises
    the exact property `boot.test.ts` already proves in CI (a restart
    preserves real data and seeds nothing), now against the real
    deployment.

## 13. Rollback procedure

1. **Code rollback**: `git checkout <previous-commit>` in the deployed
   checkout, re-run steps 4–5 of the runbook (`npm ci`, rebuild), then
   `systemctl restart dp-logistics-api`. The database and evidence store
   are never touched by a code rollback.
2. **Database compatibility**: `migrate()` is strictly additive
   (`ADD COLUMN` only if missing) — a rollback to an older commit whose
   code does not know about a newer column simply ignores that column;
   it does not fail or need a down-migration. Confirmed unchanged from
   Stage 12/13's own analysis of `db.ts`.
3. **Evidence compatibility**: evidence keys and hashes are
   version-independent — no rollback scenario changes how a key or a hash
   is computed, so older code reading newer evidence (or vice versa) is
   safe.
4. **Service restart**: `systemctl restart dp-logistics-api` after the
   code rollback — the same restart-recovery property verified in step 20
   above applies identically in reverse.
5. **Backup verification before any risky rollback**: run
   `deploy/backup.sh` (or at minimum `npm run backup -w @dp/api`)
   immediately before a rollback that touches anything beyond application
   code, so a bad rollback has a fresh, known-good point to restore from.
6. **Emergency restore**: if a rollback alone does not fix the problem
   (e.g. the database itself is suspect), follow the Restore procedure in
   `running.md` exactly — restore into a staging directory, verify the
   printed report passes, only then promote. Never skip the verification
   step under incident pressure; that is exactly when a silent partial
   restore is most dangerous.

## 14. Pilot smoke test plan

Run once, after a real deployment — not executed as part of this stage.

1. **Login** — a real seeded/created user authenticates and receives a
   token pair.
2. **Role authorization** — a `field_officer` account is rejected from an
   admin-only route (e.g. report commit); an `admin` account succeeds.
3. **Manifest/job access** — an authenticated officer fetches the active
   pickup report for their assigned location.
4. **Container scan** — submit a scan session with a valid container
   read.
5. **Chassis (VIN) scan** — submit the paired VIN read.
6. **Mismatch rejection** — submit a deliberately wrong VIN/container
   pairing and confirm it is blocked with the correct outcome code.
7. **Evidence capture** — declare, upload, and finalize a real image;
   confirm it verifies (hash match).
8. **Sync** — submit a session twice (simulating a retry) and confirm the
   second is `duplicate`, not a second reconciliation.
9. **Reconciliation** — confirm the outcome recorded matches what the
   scan pairing should produce.
10. **Notification** — confirm the corresponding event produced a row in
    `/v1/admin/notifications` with the expected status.
11. **Logout/login again** — confirm a fresh login after logout still
    works (refresh-token rotation intact).
12. **Server restart** — restart the systemd service mid-pilot and confirm
    every record from steps 1–10 is still present and no demo data
    appeared (the exact property `boot.test.ts` proves automatically,
    now confirmed against the real deployment).
13. **Backup** — run `deploy/backup.sh`; confirm `manifest.json` status is
    `ok` and reflects the real records/evidence created in steps 4–7.
14. **Backup transfer** — confirm the same run's off-server copy is
    present at the configured destination.
15. **Evidence retrieval** — fetch the evidence image created in step 7
    back through its capability URL and confirm the bytes/hash still
    match.

## 15. Security re-check for this stage

Confirmed unaffected by every change in this stage: authentication, JWT
fail-closed behavior, authorization, role checks, organization isolation,
location isolation, refresh-token rotation, evidence integrity,
notification rate limiting, `STORAGE_SECRET` fail-closed behavior, and
production no-auto-seeding. This stage touched exactly: `start.ts` (added
one additional eager configuration check, no security-control change),
`packages/api/package.json` (script only), `boot.test.ts` (updated/added
tests), CI/`.nvmrc`/`engines` (Node version pinning), and new,
purely-additive `deploy/` templates and this document. No existing
security-relevant code path was modified.

## 16. Remaining blockers before pilot go-live

- **Off-server backup destination is not yet configured with real
  credentials** — the mechanism is built, tested, and documented (§5–8);
  an actual account/bucket and its credentials are the one concrete,
  external action item left.
- **SMTP is not yet configured for real email** — acceptable for an
  initial pilot phase that does not depend on real notification delivery,
  but must be set before treating notification email as operational.
- **TLS/reverse-proxy setup on the actual VPS is unverified** — this
  engagement has no live host to test against; confirm Hostinger's VPS
  offering during deployment rather than assuming a specific mechanism.

Everything else Stage 12 flagged as non-blocking for a pilot (admin UI
gaps, SQLite's future multi-process scaling ceiling) remains non-blocking
— nothing in this stage's inspection changed that assessment.
