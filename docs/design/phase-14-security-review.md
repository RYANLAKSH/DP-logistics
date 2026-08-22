# Phase 14 — Security Review

A review of the built system, written from the attacker's side. Every finding
below is either **fixed** or **accepted with a stated reason**; nothing is
listed and left.

## 1. The model being defended

The front end is assumed hostile. It runs on a phone held by a person with a
rational incentive to make it lie: a driver under time pressure who wants a
blocked movement to go through. That assumption produces one structural rule,
and most of this review is checking that the rule actually holds.

> The client has READ access, scoped by RLS, and NO write access to anything
> that decides an outcome.

## 2. The write boundary, swept

`supabase/tests/97_attack.sql` enumerates every `INSERT`, `UPDATE`, `DELETE`,
`TRUNCATE` and `REFERENCES` grant held by `anon` or `authenticated` in the
`public` schema, and fails if it is not one of exactly three:

| Table | Grant | Constrained by |
|---|---|---|
| `devices` | INSERT (5 columns) | Own user id, `PENDING` only |
| `manifest_imports` | INSERT (9 columns), UPDATE (2) | Manager, own yard, `parsed_rows` excluded |
| `org_settings` | UPDATE (10 columns) | Admin, own org, `org_id` not writable |

Everything else is read-only to every client, forever. A migration that widens
this fails the build rather than reaching production.

`anon` holds no grant on any table at all.

## 3. Attacks attempted, and the result

All of these are executed as an ordinary driver, as the raw SQL a hand-crafted
PostgREST call would produce. Every one fails.

| What a driver would try | Result |
|---|---|
| Read another driver's movements, attempts, exceptions, devices | Zero rows |
| Read the audit log, imports, corrections, overrides | Zero rows |
| Rewrite the chassis or container they are meant to collect | Refused |
| Change a container's capacity to make room | Refused |
| Mark their own assignment completed | Refused |
| Delete an assignment so it stops blocking them | Refused |
| Publish a manifest of their own devising | Refused |
| Insert a movement directly | Refused |
| Flip an existing movement to completed | Refused |
| Edit what a movement says was scanned | Refused |
| Insert a passing scan attempt by hand | Refused |
| Upgrade a failed attempt to a pass | Refused |
| Rewrite what the OCR engine read | Refused |
| Change an image hash to match a substituted photograph | Refused |
| Resolve their own exception | Refused |
| Write themselves an override | Refused (function *and* CHECK constraint) |
| Promote themselves to ADMIN | Refused |
| Grant themselves another yard | Refused |
| Approve or pre-approve their own device | Refused |
| Forge, alter, delete or truncate an audit row | Refused (grant, trigger, and hash chain) |
| Mint an upload path for someone else's assignment | Refused |
| Read the board for a yard they do not work | Refused |
| Submit against another driver's movement id | Refused |

Cross-organisation isolation is asserted separately: an ADMIN of another
organisation sees zero rows in every table and every view.

## 4. Findings and what was done

### F1 — 23 dependency vulnerabilities, one critical · **FIXED**

`npm audit` reported 23 advisories including a critical `tar` path-traversal.
Every one traced to `packages/mobile`, the Expo application belonging to the
architecture this build supersedes — it is not deployed, not imported by the
PWA, and was being installed only because it sat in the npm workspace list.

Removed from `workspaces` (source retained, history intact). **Audit now
reports zero vulnerabilities at every severity.** It also removes the React 18
hoist that previously forced a `dedupe` workaround in the Vite config.

### F2 — A queued photograph could be swapped in IndexedDB · **FIXED**

Evidence sits in IndexedDB between capture and upload, which the person
holding the phone can edit with devtools. The hash was computed at upload,
so a substituted image would have been hashed, uploaded and certified as the
evidence.

Photographs are now hashed **at capture**, and the hash is re-checked
immediately before upload. A mismatch refuses the upload, marks the item
rejected, and tells the driver to see their manager. Items queued before this
existed carry no hash and are still uploaded — refusing them would strand real
evidence over a version boundary.

### F3 — No security headers · **FIXED**

`public/_headers` adds HSTS, `nosniff`, `frame-ancestors 'none'`, a
`Permissions-Policy` limiting camera and geolocation to same-origin, and a CSP
with no `unsafe-inline` script and no `unsafe-eval`. The OCR engine needs
WebAssembly, so the CSP grants `wasm-unsafe-eval` — meaningfully narrower than
`unsafe-eval`, and worth getting right rather than reaching for the broad
directive.

This matters more than usual here: the refresh token lives in `localStorage`,
which is XSS-readable by design, so the CSP is what stands between an injected
script and every driver's session.

### F4 — `SECURITY DEFINER` functions must pin `search_path` · **VERIFIED**

A definer function with a mutable `search_path` is a privilege-escalation
primitive. The suite now enumerates every `SECURITY DEFINER` function in
`public` and `app` and fails if any lacks `search_path` in its config. All
pass; the check guards future migrations.

### F5 — Realtime could publish an unprotected table · **VERIFIED**

Realtime respects RLS only for published tables whose policies actually
restrict `SELECT`. The suite enumerates `supabase_realtime`'s tables and fails
if any lacks RLS. Only `movement_events`, `exceptions` and
`vehicle_assignments` are published, all yard-scoped, and subscriptions are
filtered server-side so another organisation's rows never reach a client for
RLS to reject.

### F6 — Views could bypass RLS · **VERIFIED**

A view without `security_invoker = true` runs as its owner and silently
bypasses the RLS of its underlying tables — the most common RLS mistake in
Supabase projects. Every view in `public` is checked.

### F7 — Untrusted file parsing · **FIXED IN PHASE 5**

Manifests arrive by email from outside the company. The obvious dependency
(SheetJS on npm) carries prototype-pollution and ReDoS advisories, so the CSV
reader was written instead — RFC 4180, no regular expressions on the hot path,
so it cannot be made to backtrack, with row and cell caps. XLSX decoding stays
server-side in an Edge Function and loads SheetJS from its own maintained CDN
rather than the vulnerable npm build.

### F8 — Deactivation does not end a session · **MITIGATED, RESIDUAL**

`admin_deactivate_user` sets `is_active = false` (which every policy checks)
and revokes every device the user holds, in the same transaction. But a JWT
already issued stays valid until it expires, and SQL cannot revoke it.

The admin surface must also call `auth.admin.signOut(user_id)` from a
service-role Edge Function. This is stated in the migration itself rather than
left implicit. **Residual risk:** up to one access-token lifetime (15 minutes)
of read access for a dismissed employee. They cannot complete a movement —
their devices are revoked in the same transaction.

## 5. Accepted risks

Stated rather than hidden.

| Risk | Why accepted |
|---|---|
| The anon key is public | It is in the bundle by design and grants nothing on its own; every capability is gated by RLS |
| Refresh token in `localStorage` | The Supabase default. XSS-readable, which is why F3's CSP is not optional |
| Browser GPS is spoofable | Corroborating evidence only. Never the sole basis for a decision |
| A determined colluding pair defeats this | A driver and a manager working together can override anything. The controls make it slow, logged, dual-controlled and statistically visible — the realistic goal wherever humans hold final authority |
| The system verifies a photograph, not a physical act | It proves the right plates were photographed, not that the vehicle then entered the container. Closing that gap needs hardware — a gate camera, RFID, or a seal scan |

## 6. Still to do before production

Not code, and not something this phase can close alone:

1. **Rate limiting** on auth endpoints and on `verify_movement`, at the Supabase
   project level.
2. **MFA enforced for ADMIN and AUDITOR** — a project setting.
3. **Public sign-up disabled** — a project setting, and the single most common
   way Supabase projects are breached. Verify it in staging.
4. **The daily audit anchor**: write the latest `row_hash` somewhere the
   database administrator does not control. Without it the hash chain protects
   against tampering by anyone *except* the person most able to tamper.
5. **Dependency scanning in CI**, so F1 cannot recur silently.
