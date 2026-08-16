# Running it

```bash
npm install
npm test          # 101 tests across shared-rules, fixtures, api and mobile
```

## The reconciliation demo

Fastest way to see the engine work. No server, no database, no setup — it walks
a loading shift through every outcome including the wrong-container case.

```bash
npm run demo -w @dp/fixtures
```

## The API

```bash
npm start -w @dp/api
```

Boots on `:3000` with an in-memory database, seeded with four users, two
locations and a 24-vehicle pickup report committed through the real ingest
pipeline. Set `DB_PATH=./dev.db` to persist between restarts.

Seeded logins (password `FieldOfficer#2026` for all):

| Role | Email |
|---|---|
| `field_officer` | officer@dp-logistics.example |
| `supervisor` | supervisor@dp-logistics.example |
| `admin` | admin@dp-logistics.example |
| `auditor` | auditor@dp-logistics.example |

Email uses nodemailer's JSON transport by default — nothing leaves the machine,
and every send is recorded in the `notifications` table. Point it at a real
server with `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`.

`JWT_SECRET` falls back to a development value locally and is **required** in
production — the server refuses to boot without it.

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
logic is tested (13 tests over OCR interpretation), but the screens have not
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

## What is not built yet

- **Admin panel** (Next.js). The API endpoints it needs exist and are tested —
  report preview/commit, user and device management, notification recipients,
  dashboard summary — but there is no web UI over them.
- **Image upload to object storage.** Scans carry a local image URI and a SHA-256
  field; the presigned-URL flow described in `docs/api.md` is not wired.
- **PDF report ingest.** CSV and XLSX-as-CSV work; PDF table extraction is phase 3.
- **BullMQ/Redis.** Email currently sends inline after commit rather than through
  a queue. Fine at pilot volume, needs the queue before scale.
