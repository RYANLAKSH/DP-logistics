# 08 — Security Architecture

The brief says: do not rely on frontend authorization. This document is the answer to that,
and the design rule it implies is stronger than it first sounds — **not one capability in
§03 may depend on React code executing.**

## 1. Threat model

Who might attack this, and what they would want. Ordered by likelihood, which is not the
same as ordered by severity.

| # | Actor | Goal | Why it matters here |
|---|---|---|---|
| T1 | A driver under time pressure | Complete a task the app is blocking | The most likely attack, by a wide margin. Not malicious — just trying to finish a shift |
| T2 | A driver covering a mistake | Make a wrong load look right, or make the evidence unusable | Re-photograph the correct plate afterwards; alter timestamps; reuse an old photo |
| T3 | Two colluding staff | Move a vehicle off-manifest | Theft. The reason overrides need dual control |
| T4 | Anyone with the anon key | Read another org's manifests or evidence | The anon key is in the JS bundle. Assume it is public, because it is |
| T5 | A curious authenticated user | Read yards, drivers, or evidence outside their scope | Horizontal escalation via a hand-crafted PostgREST query |
| T6 | An external attacker | Credential stuffing, then anything above | Standard |
| T7 | An insider with database access | Alter history | Handled by the append-only design and hash chain, not by prevention |

T1 and T2 shape more of this design than T6 does. A phone in a driver's hand is not a
trusted computing environment, and the app must be built as though its front end is hostile
— because the person holding it has a rational incentive to make it lie.

## 2. Authentication

Supabase Auth (GoTrue). Email + password for office roles, phone OTP available for drivers.

- **Public sign-up disabled.** Admin-invite only (§03 §6). Verify this in staging: an open
  sign-up plus a permissive `profiles` insert policy is the single most common way Supabase
  projects are breached, and it is a checkbox.
- **Password policy** minimum 12 characters, checked against a breach list at set time.
- **MFA (TOTP) required for `admin` and `auditor`.** They have the broadest read, and they
  authenticate from ordinary office machines. Optional for supervisors, off for drivers —
  MFA at a ramp in the rain is how you get shared logins, which is worse.
- **Token lifetimes** per §03 §4. Access 15 minutes everywhere; refresh varies by role.
- **Revocation is active, not passive.** Deactivating a user calls
  `auth.admin.signOut(user_id)` to kill refresh tokens, and sets `profiles.is_active =
  false`, which every RLS policy checks. Relying on token expiry alone leaves a dismissed
  employee with up to 15 minutes of access, and a valid refresh token for far longer.
- **JWT claims** — `org_id`, `role`, `yard_ids` injected by the Custom Access Token Hook so
  policies need no subquery. The hook is the only place these are computed; the client can
  no more set a claim than it can sign a token.

`profiles.role` is writable by no one through PostgREST. Role changes go through an admin
RPC that logs to `audit_events`. A self-service `update profiles set role='admin'` is the
first thing an attacker tries, and a policy that allows a user to update their own profile
row without a column filter permits exactly that.

## 3. Row-level security

Every table: `alter table … enable row level security` plus `force row level security`, and
**no permissive default**. Start from deny.

```sql
-- The pattern, applied per table.
alter table movements enable row level security;
alter table movements force row level security;
revoke all on movements from anon, authenticated;
grant select on movements to authenticated;      -- reads only; writes go through the RPC

-- Helper, stable, reads claims not tables — no recursion, no per-row subquery.
create or replace function auth_role() returns user_role
  language sql stable as $$
    select (auth.jwt() -> 'app_metadata' ->> 'role')::user_role
  $$;

create or replace function auth_org() returns uuid
  language sql stable as $$
    select (auth.jwt() -> 'app_metadata' ->> 'org_id')::uuid
  $$;

create or replace function auth_yards() returns uuid[]
  language sql stable as $$
    select coalesce(array(select jsonb_array_elements_text(
             auth.jwt() -> 'app_metadata' -> 'yard_ids')::uuid), '{}')
  $$;
```

Read policies, by role:

```sql
create policy movements_driver_read on movements for select to authenticated
  using (auth_role() = 'driver' and driver_id = auth.uid());

create policy movements_supervisor_read on movements for select to authenticated
  using (auth_role() = 'supervisor' and org_id = auth_org() and yard_id = any(auth_yards()));

create policy movements_admin_read on movements for select to authenticated
  using (auth_role() in ('admin','auditor') and org_id = auth_org());
```

Note there is **no insert or update policy on `movements` at all**. Not a restrictive one —
none. PostgREST cannot write to this table under any circumstance, by any user, ever. The
only writer is `verify_movement()`, which is `SECURITY DEFINER` and therefore runs as its
owner, bypassing RLS by design after doing its own explicit checks.

That inversion is the core of the authorization design: **the front end has read access and
no write access to anything that decides an outcome.** Writes are function calls with
server-side preconditions.

### Rules for every `SECURITY DEFINER` function

Non-negotiable, because a mistake in one of these is a full compromise:

1. `set search_path = ''` and schema-qualify every identifier. A mutable `search_path` on a
   definer function is a privilege-escalation primitive.
2. Re-derive identity from `auth.uid()`. Never accept a user id, org id, or role as a
   parameter.
3. Validate the caller's role and yard scope explicitly at the top, and raise on failure.
4. `revoke execute … from public`, then `grant execute` to `authenticated` only.
5. Write an `audit_events` row on every state change.
6. Never call out to the network from inside the transaction.

### Testing that RLS actually holds

pgTAP suite, in `supabase/tests/`. Every table gets, at minimum:

- A driver from org A **cannot** select a row belonging to org B (returns zero rows — not
  an error, which is the correct and easily-missed shape).
- A driver **cannot** select another driver's movement in the same yard.
- A driver **cannot** insert or update `movements`, `exceptions`, `audit_events` at all.
- A supervisor **cannot** read a yard they are not assigned to.
- An auditor **cannot** write anything, anywhere.
- Every view is `security_invoker = true`.

These tests run in CI on every migration. A migration that adds a table without RLS fails
the build — assert that too, with a query over `pg_tables` that finds any table in `public`
with `rowsecurity = false`.

## 4. Storage

Two private buckets. No bucket is ever public.

| Bucket | Path convention | Read | Write |
|---|---|---|---|
| `evidence` | `{org}/{yard}/{date}/{movement}/{kind}.jpg` | supervisor (own yards), admin, auditor, and the driver who created it | Signed URL only, issued per movement by an RPC |
| `manifests` | `{org}/{yard}/{date}/{sha256}.xlsx` | admin, auditor | Admin, signed URL |

- **Signed upload URLs are issued by an RPC that constructs the path.** The client passes a
  movement id and a scan kind; it never passes a path. A client-supplied path is a
  write-anywhere primitive that a storage policy alone will not save you from.
- **Signed read URLs are short-lived** — 5 minutes for in-app viewing, 7 days for a link in
  an email, and the email variant is logged.
- Storage RLS policies parse the org and yard out of the object path and apply the same
  scoping as the tables. They are the backstop; the RPC is the gate.
- Images are stripped of EXIF **except** for a validated capture timestamp, which is stored
  in the `scans` row. GPS comes from the Geolocation API, not from EXIF — EXIF is
  attacker-controlled.

## 5. Evidence integrity

The audit trail is only worth what its evidence is worth.

- **SHA-256 computed on-device before upload**, stored in `scans.image_sha256`. Recomputing
  server-side after upload proves nothing about the bytes' journey. Recomputing it at audit
  time and comparing to the stored value proves the object has not been altered at rest.
- **Perceptual hash (`image_phash`) stored and indexed.** This catches T2 directly: a driver
  who photographs the same container plate for a second task, or re-uses yesterday's photo,
  produces a near-identical phash. Duplicate phashes across different movements are flagged
  for supervisor review. It is not proof of fraud — two photos of the same container legitimately
  look alike, which is exactly why the check is a flag and not a block.
- **Device time and server time both stored**, with the difference materialized
  (`clock_skew_s`). Skew beyond 5 minutes is flagged.
- **GPS with every scan**, with accuracy. A movement recorded 40 km from its yard's geofence
  is a strong signal and appears on the supervisor board. Note honestly: browser geolocation
  can be spoofed on a rooted device or via devtools. It raises the cost of fabrication; it
  does not prevent it. It is corroborating evidence, never the sole basis for a decision.
- **Append-only everywhere.** `movements`, `exceptions`, `overrides`, `audit_events` have
  triggers that raise on `UPDATE` and `DELETE`. Corrections are new rows with
  `supersedes_id`.

## 6. Anti-circumvention

T1 is the likeliest threat, so it gets explicit countermeasures rather than good intentions:

| Circumvention | Countermeasure |
|---|---|
| Type the expected number instead of scanning | Manual entry is allowed but recorded as `source='manual_entry'`, requires a photo regardless, and shows on the supervisor's board. A driver with a high manual-entry rate is a conversation |
| Photograph the correct plate on a different container | GPS + phash + timestamp gap between the two scans. Two scans 90 seconds and 200 m apart is normal; two scans 3 seconds apart from the same coordinates is not |
| Upload a saved photo instead of using the camera | The driver flow has no file input. `getUserMedia` only. This is defeatable by a determined user on a desktop browser, so also: block completion from a non-mobile user agent in the driver role, and flag a capture whose dimensions do not match the device's camera stream |
| Complete the task from the office | Yard geofence check, flagged not blocked (GPS fails legitimately indoors and between stacks) |
| Share credentials so someone else completes it | Device binding (§03 §5). Two devices for one driver in one shift is a flag |
| Ask a supervisor to override everything | Override rate per driver and per supervisor, on the dashboard, trended. Dual control in a `check` constraint |

None of these individually is strong. Together they make circumvention require deliberate,
repeated, logged effort — which is the realistic goal. The strongest control by far is the
one from §01: make the compliant path faster than the workaround.

## 7. Application-layer hardening

- **CSP** with no `unsafe-inline`, no `unsafe-eval`. Note `tesseract.js` uses WASM; that
  needs `wasm-unsafe-eval` in `script-src`, which is meaningfully narrower than
  `unsafe-eval`. Worth getting right rather than reaching for the broad directive.
- `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy:
  strict-origin-when-cross-origin`, `Permissions-Policy: camera=(self), geolocation=(self)`.
- **The anon key is public.** It is in the bundle. It grants nothing on its own; every
  capability behind it is gated by RLS. Design as though it is on a billboard, because
  effectively it is.
- **The service role key never leaves an Edge Function.** Never in the PWA, never in a
  build-time environment variable that reaches the client, never in CI logs. A leaked
  service role key bypasses all RLS, which is the whole security model.
- Session tokens in memory plus a refresh token in `localStorage` — the Supabase default.
  Acknowledge the tradeoff: this is XSS-vulnerable by design, which is why the CSP above is
  not optional and why dependencies get automated scanning.
- Rate limiting at the edge on auth endpoints and on `verify_movement`.
- Dependency scanning in CI; the OCR and XLSX libraries are the ones to watch, because they
  parse untrusted input.

## 8. Privacy

- Driver names, phone numbers, and employee numbers are personal data. Restricted to
  supervisor and above, excluded from exports by default.
- GPS traces are location data about employees. Retained 24 months with the movement, never
  used for anything other than movement verification, and that limitation stated in the
  staff-facing policy. Collecting it is defensible; repurposing it silently is not.
- Evidence images may incidentally capture people. Retention limits apply; the deletion job
  is real and tested, not a documented intention.
- Data residency: pick the Supabase region deliberately for where the operation runs, and
  record the choice. Moving a project between regions later is a migration, not a setting.
