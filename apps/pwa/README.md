# DP Verify — PWA

Mobile-first Progressive Web App. One build serves the driver shell and the manager
shell; the role decides which subtree renders, and RLS decides what data returns.

## Running it

```bash
npm install                # from the repo root — this is a workspace
npm run dev -w @dp/pwa     # http://localhost:5173
```

Phase 3 has no authentication. Sign in with `driver@…`, `manager@…` or `admin@…`
(any password) to preview each role. Phase 4 replaces this with Supabase Auth.

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server with HMR |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run preview` | Serve `dist/` on :4173 |
| `npm run test` | Vitest unit tests |
| `npm run e2e -- ./shots` | Drives the built app in Chromium, writes screenshots |
| `npm run icons` | Regenerates the PWA icons |

The e2e script needs the app served first (`npm run build && npm run preview`). Set
`CHROMIUM_PATH` if Playwright's bundled browser is not the one on disk, and
`E2E_BASE_URL` to point at somewhere other than :4173.

## File structure

```
src/
├── main.tsx              entry
├── App.tsx               the router — every route in one readable tree
├── index.css             Tailwind v4 tokens, tuned for sunlight and gloves
├── sw.ts                 service worker (shell precache now; outbox in phase 13)
│
├── data/                 THE BACKEND SEAM
│   ├── types.ts          domain types, mirroring supabase/migrations
│   ├── DataSource.ts     the interface every backend must satisfy
│   ├── provider.tsx      the single place the backend is chosen
│   └── mock/             ISOLATED mock implementation + fixtures
│
├── lib/
│   ├── status.ts         the status vocabulary the whole UI speaks
│   ├── format.ts         presentation helpers (grouping, diffing, relative time)
│   ├── session.tsx       who is signed in
│   └── scanDraft.ts      the two captures for one task, across reloads
│
├── components/           Button, Card, CodeValue, Progress, StatusBadge,
│                         Table, Layout (DriverShell / ManagerShell), States
│
└── routes/
    ├── guards.tsx        RequireAuth / RequireRole — UX only, never authorisation
    ├── LoginPage.tsx
    ├── ErrorPages.tsx    403 / 404 / offline
    ├── driver/           Home · PickupDetail · Scan · Result · Exception · Completed
    └── manager/          Dashboard · ManifestUpload · ManifestPreview ·
                          ManifestHistory · Assignments · Exceptions · Users · Audit
```

## Two rules this structure exists to enforce

**Nothing outside `src/data/mock` imports from `src/data/mock`.** Screens depend on the
`DataSource` interface, so replacing the mock with Supabase changes `provider.tsx` and
nothing else. Grep for `data/mock` outside that directory — it should return two files:
the mock itself and its tests.

**Route guards decide which screen renders, never which data returns.** Delete
`guards.tsx` entirely and a driver who navigates to `/manager/users` gets the manager
shell around an empty table, because the query underneath returns nothing under RLS. If
removing a guard would expose data, the authorisation model is wrong and the fix belongs
in a policy.

## Design notes

- **56px minimum tap target** (`min-h-touch`). Drivers wear gloves.
- **Status is never colour alone.** Every status carries a word and an icon too —
  sunlight washes out hue, and roughly one man in twelve cannot separate red from green.
- **Identifiers render in a monospace `code` class with ligatures off**, grouped in
  fours. Confusing `0` with `O` is the failure mode the product exists to prevent.
- **Character-level diffing on a block.** The result screen highlights exactly which
  characters differ, which turns "those look similar" into something a driver can check.
- **The expected value stays visible while scanning.** Hiding it to make the driver read
  "blind" sounds more rigorous and is worse: they end up cross-checking against a paper
  sheet, which is the process being replaced.

## Known phase-3 placeholders

Each is replaced in the phase named, and each is marked with a comment in the file:

| Placeholder | Replaced in |
|---|---|
| `MockDataSource` | Phase 4 onward — Supabase |
| Persona sign-in, no real auth | Phase 4 |
| Simulated OCR read on the scan screen | Phase 7 |
| "Live updates — phase 10" badge on the dashboard | Phase 10 |
| Evidence placeholder in the exception panel | Phase 11 |
| Service worker precaches the shell only | Phase 13 |
