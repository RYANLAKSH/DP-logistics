# Running it

```bash
npm install
npm test          # 250 tests across shared-rules, fixtures, api and mobile
```

## The reconciliation demo

Fastest way to see the engine work. No server, no database, no setup — it walks
a loading shift through every outcome including the wrong-container case.

```bash
npm run demo -w @dp/fixtures
```

## The API

### Development

```bash
npm run dev -w @dp/api
```

Boots on `:3000` with an in-memory database, seeded automatically with four
users, two locations and a 24-vehicle pickup report committed through the
real ingest pipeline. This is safe precisely because nothing here persists —
each run starts from nothing and seeds fresh.

Seeded logins (password `FieldOfficer#2026` for all):

| Role | Email |
|---|---|
| `field_officer` | officer@dp-logistics.example |
| `supervisor` | supervisor@dp-logistics.example |
| `admin` | admin@dp-logistics.example |
| `auditor` | auditor@dp-logistics.example |

Set `DB_PATH=./dev.db` to develop against a persistent file instead of an
in-memory database. In that case `npm run dev` does **not** seed
automatically (a persistent database restarting into another copy of the
demo org would be exactly the production bug this exists to avoid) — see
"Seeding a database" below.

### Production

```bash
DB_PATH=/var/lib/dp-logistics/db.sqlite \
JWT_SECRET=<random> \
STORAGE_SECRET=<random> \
npm start -w @dp/api
```

Runs `src/start.ts`, not `src/main.ts`. Three differences from `dev`, all
deliberate:

- **`DB_PATH` is required.** It refuses to boot against an in-memory
  database — production data must never be one restart away from vanishing.
- **`JWT_SECRET` and the storage secret are validated at boot**, not on the
  first request that happens to need them — a misconfigured deployment fails
  immediately and loudly instead of looking healthy until someone tries to
  log in.
- **It never seeds demo data.** There is no code path in `start.ts` that can
  create a demo organization, user, location, or report — it does not import
  `seed.ts` at all. A real deployment creates its first organization and
  users through the admin API.

### Seeding a database

```bash
DB_PATH=./dev.db npm run seed -w @dp/api
```

Populates whichever file `DB_PATH` points at with the same reference data
`npm run dev`'s in-memory mode seeds automatically — four users, two
locations, a 24-vehicle report. Run it once, before starting the server
against that file. It requires `DB_PATH`: seeding an in-memory database from
this separate, one-shot process would have no effect, since a running
server's in-memory database is not shared with this process's memory.

This is a different thing from `npm run seed` at the repo root, which
regenerates the fixtures package's CSV/JSON files on disk (see
"Regenerating the dummy data" below) — that one never touches a database at
all.

Email uses nodemailer's JSON transport by default — nothing leaves the machine,
and every send is recorded in the `notifications` table. Point it at a real
server with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.

`JWT_SECRET` is **required** in every environment — the server refuses to sign
or verify tokens without it, dev included. Set any non-empty value locally.

### A quick end-to-end poke

```bash
TOKEN=$(curl -s localhost:3000/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"officer@dp-logistics.example","password":"FieldOfficer#2026"}' \
  | node -pe 'JSON.parse(require("fs").readFileSync(0)).accessToken')

# the locationId is printed at server startup
curl -s "localhost:3000/v1/sync/reports?locationId=$LOCATION_ID" \
  -H "authorization: Bearer $TOKEN" | head -40
```

## Regenerating the dummy data

```bash
npm run seed      # writes packages/fixtures/data/*.csv and *.json
```

Deterministic — a given seed always produces the same report. Every container
number carries a computed ISO 6346 check digit and every VIN a computed ISO 3779
check digit, so the fixtures exercise the real validation paths.

## The mobile app

```bash
cd packages/mobile
npx expo start
```

**Not yet run against a device or emulator.** The code is written and the pure
logic is tested (24 tests over OCR interpretation and image hashing), but the screens have not
been exercised on hardware — that needs an Android device or emulator, which
this environment does not have. Expect the usual first-run friction.

Two things to know before you try:

**OCR needs a development build, not Expo Go.** ML Kit is a native module.
Until you produce a dev build, `MlKitOcrProvider` returns empty reads and the UI
falls through to manual entry — which works, and is a legitimate way to test the
rest of the flow.

```bash
npx expo install @react-native-ml-kit/text-recognition
npx expo prebuild
npx expo run:android
```

To demo the capture flow without any of that, swap in the mock provider, which
replays canned label text:

```ts
import { setOcrProvider, MockOcrProvider } from './src/lib/ocr.ts';

const mock = new MockOcrProvider();
mock.queue('TGHU 739121 8\n45G1', 'VIN MA3EJKD1S00100001');
setOcrProvider(mock);
```

**Point it at the API.** `EXPO_PUBLIC_API_BASE` defaults to `http://10.0.2.2:3000`,
which is how an Android emulator reaches the host machine. On a physical device
use your machine's LAN address:

```bash
EXPO_PUBLIC_API_BASE=http://192.168.1.20:3000 npx expo start
```

## Two shareable demos

Both are single self-contained pages — open them straight from disk, no server:

| File | For |
|---|---|
| `packages/admin/results-demo.html` | The outcome: a random batch of pairings, each matched or stopped |
| `packages/admin/checklist-demo.html` | The end-user checklist: photograph the plate, tick off each car |
| `packages/admin/client-demo.html` | The client walkthrough: the gate, the office, and whether the container can ship |

Each embeds the real matching engine and the seeded 24-vehicle report, so the
verdicts are not scripted.

## The admin panel

Served by the API at **http://localhost:3000/admin/index.html** — no build step,
no second process. Sign in with the admin or supervisor account above.

- **Upload report** — paste or pick a CSV, preview, commit. Rejected rows are
  listed with their reason code and are not committed.
- **Reconciliations** — live table, filterable by outcome.
- **Email log** — every send with its delivery status.
- **Recipients** — who gets told, per event.

Verified end to end in Chromium against the live API: login, preview (24 valid /
2 rejected with the correct reason codes), commit, the reconciliation table,
outcome filtering, and adding a recipient.

Keeping it a static page served by the API is a deliberate simplification: one
process, one origin, no bundler. Moving it to a separate Next.js app later is a
deployment change — the API surface it consumes does not change.

## Evidence and documents

Evidence images and trade documents both go straight to object storage with
hash verification. In development the local driver keeps them on disk:

```bash
STORAGE_DIR=./.evidence          # where files land
STORAGE_SECRET=<random>          # signs capability URLs; required in every environment
PUBLIC_BASE_URL=http://localhost:3000
```

For production, set `S3_BUCKET` / `S3_REGION` (and `S3_ENDPOINT` for R2 or
MinIO) and install the optional SDK:

```bash
npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner -w @dp/api
```

Read [security.md](security.md) before the first real image lands — Object Lock
in particular cannot be retrofitted onto an existing bucket.

**Text recognition for scanned documents** is off unless configured, because it
bills per page:

```bash
OCR_PROVIDER=textract            # needs S3_BUCKET; Textract reads from the bucket
npm i @aws-sdk/client-textract -w @dp/api
```

Without it, documents upload and verify normally and are linked by hand. The
admin panel's **Run recognition queue now** button drains the queue on demand
rather than waiting for the 30-second worker interval.

## Backup and restore

For scheduling these commands on a real host, transporting backups
off-server, and the full pilot deployment runbook, see
[deployment.md](deployment.md). What follows here is the mechanism itself.

The database alone is not a usable backup, and neither is the evidence
directory alone: `scans.image_key`/`image_sha256` and
`documents.file_key`/`file_sha256` are metadata pointing at files that live
only on disk, and nothing on disk says which record a file belongs to or
whether it was ever verified. Every backup below is the pair, taken together.

### Backup

```bash
DB_PATH=/var/lib/dp-logistics/db.sqlite \
STORAGE_DIR=/var/lib/dp-logistics/.evidence \
BACKUP_DIR=/var/backups/dp-logistics \
npm run backup -w @dp/api
```

Safe to run at any time against a live server — it never touches the running
API process, and the database half uses SQLite's own Online Backup API
(`node:sqlite`'s `backup()`), not a raw file copy, so it stays consistent
even while writes are landing on the source concurrently. `BACKUP_DIR`
defaults to `./backups` and must live outside anything publicly served (it is
not, and must never become, a static-file directory — see "Security" below).

Each run creates one new, uniquely-named directory under `BACKUP_DIR` and
never overwrites an existing one. Exits non-zero if the backup it just made
is incomplete (see "Verification").

### Backup contents

```
<BACKUP_DIR>/<timestamp>/
  database.sqlite   # SQLite Online Backup API output, not a raw file copy
  evidence/          # a raw recursive copy of STORAGE_DIR — bytes untouched
  manifest.json      # what's in this backup, and whether it verified clean
```

Every file and directory in a backup is created owner-only
(`0700`/`0600`) — backups contain the same sensitive evidence and personal
data the live system does.

### Restore

```bash
BACKUP_SOURCE_DIR=/var/backups/dp-logistics/<timestamp> \
RESTORE_TARGET_DIR=/var/tmp/dp-restore-test \
npm run restore -w @dp/api
```

This never touches the live database or evidence store and never promotes
the restored copy automatically — it restores into `RESTORE_TARGET_DIR` (a
fresh directory; it refuses to run against an existing one, and refuses to
target the live `DB_PATH`'s directory or `STORAGE_DIR`) and verifies it
there. The full procedure, only the last two steps of which are manual:

1. `npm run restore` as above — restores into a staging directory and
   verifies database integrity, every evidence file's hash, and that every
   verified scan/document record still resolves to a present, matching file.
2. Read the printed report. Do not proceed if it reports failure.
3. **Stop the running API process.** (manual)
4. Move the current `DB_PATH` file and `STORAGE_DIR` aside — do not delete
   them yet.
5. Move the restored `database.sqlite` to the real `DB_PATH`, and the
   restored `evidence/` to the real `STORAGE_DIR`.
6. **Restart the API process** (`npm start`) and confirm it serves the
   restored data correctly.

### Verification

A backup's `manifest.json` and a restore's printed report both check the
same three things, using the application's own SHA-256 discipline (the same
one that verifies uploads) rather than a separate mechanism:

- the SQLite file passes `PRAGMA integrity_check`
- every evidence file the manifest recorded is present and unmodified
- every *verified* scan/document image the database records resolves to a
  present file with the exact hash the database declared

Any of these failing is reported explicitly — a restore is never silently
partial. `npm run backup` also exits non-zero on an incomplete result, so a
cron job can alert on backup failure without parsing its output.

### Retention

Pilot-appropriate, not enterprise: **daily backups, kept for 14 days,
deleted on a rolling basis.** At pilot volume (a handful of officers, one or
two locations) a day's evidence is at most a few hundred images — cheap to
keep for two weeks, and two weeks is enough to notice and recover from a
problem that wasn't caught immediately. There is no automated retention/cron
job yet (see "Automation" below) — this is a recommendation to configure at
deployment, not a built-in schedule.

### Off-server storage

**Backups must end up somewhere other than the VPS they were taken on**
before this system is production-ready — a local-disk-only backup does not
survive the disk failure or server loss it exists to protect against. This
is not implemented here; it needs to be configured at deployment (e.g. an
off-box `rsync`/`rclone` step reading from `BACKUP_DIR` on a schedule). None
of that is built yet — see "Automation."

### Automation

`npm run backup`/`npm run restore` are plain CLI commands; nothing here
schedules them. A cron entry invoking `npm run backup -w @dp/api` with the
right environment, and a separate job syncing `BACKUP_DIR` off the VPS, are
deployment configuration for a later stage — deliberately out of scope here.

### Disaster scenario

If the server, its disk, or the evidence directory is lost: provision a new
host, restore the most recent off-server backup copy through the procedure
above, confirm the verification report passes, promote it, and restart.
Recovery is only as good as the most recent *off-server* backup — see
"Off-server storage."

## What is not built yet

- **The S3 and Textract providers have not been run against real AWS.** No
  credentials in this environment. The local storage driver and the fixture OCR
  provider mirror their semantics and are what the tests cover; budget a day to
  shake out each real integration.
- **PDF report ingest.** CSV and XLSX-as-CSV work; PDF table extraction is phase 3.
- **BullMQ/Redis.** Email sends inline after commit rather than through a queue.
  Fine at pilot volume, needs the queue before scale.
- **Supervisor override UI.** The endpoint exists and is tested; there is no
  button for it in the panel yet.
- **Mobile screens on hardware.** See the caveat above.
